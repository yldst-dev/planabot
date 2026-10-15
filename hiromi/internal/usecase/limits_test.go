package usecase

import (
	"context"
	"errors"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"

	"hiromi/internal/domain"
)

func limitedService(store *memStore, limits downloadLimits) *DownloadService {
	fake := fakeRepo{g: testGallery()}
	svc := NewDownloadService(fake, fake, &seqFetch{payload: []byte("IMG")}, store, "https://hitomi.la")
	instantSleep(svc)
	svc.limits = limits
	return svc
}

func TestDownloadEnforcesPageImageAndGalleryCaps(t *testing.T) {
	opt := domain.DefaultDownloadOptions()
	store := newMemStore()
	if _, err := limitedService(store, downloadLimits{pages: 1, image: 10, total: 100}).Download(context.Background(), 1234567, opt); !errors.Is(err, domain.ErrTooLarge) || len(store.files) != 0 {
		t.Fatalf("page cap %v files=%v", err, keys(store.files))
	}
	store = newMemStore()
	res, err := limitedService(store, downloadLimits{pages: 10, image: 2, total: 100}).Download(context.Background(), 1234567, opt)
	if err != nil || len(res.Saved) != 0 || len(res.Failed) != 2 || !strings.Contains(res.Failed[0].Error, domain.ErrTooLarge.Error()) {
		t.Fatalf("image cap %v %+v", err, res)
	}
	if _, ok := store.files["1234567/001.webp"]; ok {
		t.Fatal("oversized image kept")
	}
	if _, err := limitedService(newMemStore(), downloadLimits{pages: 10, image: 10, total: 4}).Download(context.Background(), 1234567, opt); !errors.Is(err, domain.ErrTooLarge) {
		t.Fatalf("gallery cap %v", err)
	}
}

type heldFetch struct {
	started chan struct{}
	release chan struct{}
}

func (h *heldFetch) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	h.started <- struct{}{}
	select {
	case <-h.release:
	case <-ctx.Done():
		return nil, "", ctx.Err()
	}
	return io.NopCloser(strings.NewReader("IMG")), "image/webp", nil
}

func TestDownloadKeepsAFixedWorkerPool(t *testing.T) {
	g := testGallery()
	g.Files = nil
	for i := range 500 {
		g.Files = append(g.Files, domain.File{Index: i, Name: "p", Hash: "h", HasWebP: true, URLs: domain.FileURLs{WebP: "https://cdn.test/p.webp"}})
	}
	fake := fakeRepo{g: g}
	fetch := &heldFetch{started: make(chan struct{}, 500), release: make(chan struct{})}
	svc := NewDownloadService(fake, fake, fetch, newMemStore(), "https://hitomi.la")
	instantSleep(svc)
	before := runtime.NumGoroutine()
	done := make(chan error, 1)
	go func() {
		_, err := svc.Download(context.Background(), g.ID, domain.DefaultDownloadOptions())
		done <- err
	}()
	<-fetch.started
	<-fetch.started
	if extra := runtime.NumGoroutine() - before; extra > 20 {
		t.Fatalf("%d goroutines for 500 pages", extra)
	}
	close(fetch.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

type brokenOnceFetch struct {
	mu    sync.Mutex
	calls int
}

func (b *brokenOnceFetch) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	b.mu.Lock()
	b.calls++
	first := b.calls == 1
	b.mu.Unlock()
	if first {
		return io.NopCloser(io.MultiReader(strings.NewReader("IM"), errReader{errors.New("connection reset by peer")})), "image/webp", nil
	}
	return io.NopCloser(strings.NewReader("IMG")), "image/webp", nil
}

func TestDownloadRetriesABodyThatBreaksMidway(t *testing.T) {
	g := testGallery()
	g.Files = g.Files[:1]
	fake := fakeRepo{g: g}
	fetch := &brokenOnceFetch{}
	store := newMemStore()
	svc := NewDownloadService(fake, fake, fetch, store, "https://hitomi.la")
	instantSleep(svc)
	res, err := svc.Download(context.Background(), g.ID, domain.DefaultDownloadOptions())
	if err != nil || len(res.Saved) != 1 || fetch.calls != 2 || string(store.files["1234567/001.webp"]) != "IMG" {
		t.Fatalf("err=%v saved=%d calls=%d", err, len(res.Saved), fetch.calls)
	}
}

type partialFetch struct{}

func (partialFetch) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	if strings.Contains(rawURL, "bbb") {
		return nil, "", domain.ErrNotFound
	}
	return io.NopCloser(strings.NewReader("IMG")), "image/webp", nil
}

type cancelingFetch struct{ cancel context.CancelFunc }

func (c cancelingFetch) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	c.cancel()
	return nil, "", ctx.Err()
}

func TestShareReportsSavedPagesAndFailsWhenTheJobEnds(t *testing.T) {
	fake := fakeRepo{g: testGallery()}
	gs := NewGalleryService(fake, fake, fake)
	store := newMemStore()
	ds := NewDownloadService(fake, fake, partialFetch{}, store, "https://hitomi.la").WithViewer(stubViewer{})
	instantSleep(ds)
	share, err := NewShareService(gs, ds, &fakeUploader{url: "u"}, store, newMemClaims()).Deliver(context.Background(), 1234567)
	if err != nil || share.Pages != 1 {
		t.Fatalf("partial share %v %+v", err, share)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store = newMemStore()
	ds = NewDownloadService(fake, fake, cancelingFetch{cancel: cancel}, store, "https://hitomi.la").WithViewer(stubViewer{})
	instantSleep(ds)
	if _, err := NewShareService(gs, ds, &fakeUploader{url: "u"}, store, newMemClaims()).Deliver(ctx, 1234567); !errors.Is(err, context.Canceled) || len(store.files) != 0 {
		t.Fatalf("ended job %v files=%v", err, keys(store.files))
	}
}
