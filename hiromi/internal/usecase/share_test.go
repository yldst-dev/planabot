package usecase

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type fakeUploader struct {
	limits   port.ShareLimits
	url      string
	err      error
	mu       sync.Mutex
	uploads  int
	lastName string
	lastSize int64
	lastBody []byte
}

func (f *fakeUploader) Limits(context.Context) (port.ShareLimits, error) {
	return f.limits, nil
}

func (f *fakeUploader) Upload(_ context.Context, name string, size int64, body io.Reader) (*port.UploadedShare, error) {
	b, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.uploads++
	f.lastName = name
	f.lastSize = size
	f.lastBody = b
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return &port.UploadedShare{URL: f.url, Name: name, Size: size}, nil
}

type memClaims struct {
	mu   sync.Mutex
	data map[string]port.ShareClaim
}

func newMemClaims() *memClaims {
	return &memClaims{data: map[string]port.ShareClaim{}}
}

func (m *memClaims) Put(c port.ShareClaim) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[c.Token] = c
	return nil
}

func (m *memClaims) Get(token string) (port.ShareClaim, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.data[token]
	if !ok {
		return port.ShareClaim{}, domain.ErrClaim
	}
	return c, nil
}

func TestSharePreview(t *testing.T) {
	g := testGallery()
	fake := fakeRepo{g: g}
	gs := NewGalleryService(fake, fake, fake)
	store := newMemStore()
	ds := NewDownloadService(fake, fake, &seqFetch{payload: []byte("IMG")}, store, "https://hitomi.la")
	svc := NewShareService(gs, ds, &fakeUploader{}, store, newMemClaims())
	p, err := svc.Preview(context.Background(), 1234567)
	if err != nil {
		t.Fatal(err)
	}
	if p.Title != "sample" || p.Pages != 2 || p.Language != "korean" {
		t.Fatalf("%+v", p)
	}
}

func TestShareDeliverUploadsViewerAndCleans(t *testing.T) {
	g := testGallery()
	fake := fakeRepo{g: g}
	gs := NewGalleryService(fake, fake, fake)
	store := newMemStore()
	ds := NewDownloadService(fake, fake, &seqFetch{payload: []byte("IMG")}, store, "https://hitomi.la").WithViewer(stubViewer{})
	instantSleep(ds)
	up := &fakeUploader{url: "https://send.vis.ee/download/abc/#sec", limits: port.ShareLimits{Downloads: 20, ExpireSec: 259200}}
	svc := NewShareService(gs, ds, up, store, newMemClaims())
	svc.telegramLimit = 0
	share, err := svc.Deliver(context.Background(), 1234567)
	if err != nil {
		t.Fatal(err)
	}
	if share.URL != up.url || share.Title != "sample" || share.Token == "" || share.Path != "" {
		t.Fatalf("%+v", share)
	}
	if up.uploads != 1 || up.lastName != "viewer.html" {
		t.Fatalf("upload %+v %s", up.uploads, up.lastName)
	}
	if !bytes.Contains(up.lastBody, []byte("sample")) {
		t.Fatalf("body %s", up.lastBody)
	}
	if len(store.files) != 0 {
		t.Fatalf("left files %v", keys(store.files))
	}
	got, err := svc.Claim(share.Token)
	if err != nil || got.URL != share.URL {
		t.Fatalf("claim %v %+v", err, got)
	}
}

func TestShareDeliverKeepsLocalFileWhenSmall(t *testing.T) {
	g := testGallery()
	fake := fakeRepo{g: g}
	gs := NewGalleryService(fake, fake, fake)
	store := newMemStore()
	ds := NewDownloadService(fake, fake, &seqFetch{payload: []byte("IMG")}, store, "https://hitomi.la").WithViewer(stubViewer{})
	instantSleep(ds)
	up := &fakeUploader{url: "https://send.vis.ee/download/abc/#sec"}
	svc := NewShareService(gs, ds, up, store, newMemClaims())
	share, err := svc.Deliver(context.Background(), 1234567)
	if err != nil {
		t.Fatal(err)
	}
	if share.URL != "" || share.Path == "" || share.Token == "" || share.Size == 0 {
		t.Fatalf("%+v", share)
	}
	if up.uploads != 0 {
		t.Fatalf("uploads %d", up.uploads)
	}
	staged := "shares/" + share.Token + ".html"
	if _, ok := store.files[staged]; !ok || len(store.files) != 1 {
		t.Fatalf("left files %v", keys(store.files))
	}
	got, err := svc.Claim(share.Token)
	if err != nil || got.Path != share.Path {
		t.Fatalf("claim %v %+v", err, got)
	}
}

func TestShareDeliverCleansOnUploadError(t *testing.T) {
	g := testGallery()
	fake := fakeRepo{g: g}
	gs := NewGalleryService(fake, fake, fake)
	store := newMemStore()
	ds := NewDownloadService(fake, fake, &seqFetch{payload: []byte("IMG")}, store, "https://hitomi.la").WithViewer(stubViewer{})
	instantSleep(ds)
	up := &fakeUploader{err: errors.New("boom")}
	svc := NewShareService(gs, ds, up, store, newMemClaims())
	svc.telegramLimit = 0
	if _, err := svc.Deliver(context.Background(), 1234567); err == nil {
		t.Fatal("expected error")
	}
	if len(store.files) != 0 {
		t.Fatalf("left files %v", keys(store.files))
	}
}

func TestShareDeliverRequiresViewer(t *testing.T) {
	g := testGallery()
	fake := fakeRepo{g: g}
	gs := NewGalleryService(fake, fake, fake)
	store := newMemStore()
	ds := NewDownloadService(fake, fake, &seqFetch{payload: []byte("IMG")}, store, "https://hitomi.la")
	instantSleep(ds)
	svc := NewShareService(gs, ds, &fakeUploader{url: "x"}, store, newMemClaims())
	if _, err := svc.Deliver(context.Background(), 1234567); !errors.Is(err, domain.ErrNoViewer) {
		t.Fatalf("%v", err)
	}
	if len(store.files) != 0 {
		t.Fatalf("left files %v", keys(store.files))
	}
}

func TestShareBusy(t *testing.T) {
	g := testGallery()
	fake := fakeRepo{g: g}
	gs := NewGalleryService(fake, fake, fake)
	store := newMemStore()
	block := make(chan struct{})
	fetch := &gateFetch{payload: []byte("IMG"), block: block, started: make(chan struct{})}
	ds := NewDownloadService(fake, fake, fetch, store, "https://hitomi.la").WithViewer(stubViewer{})
	instantSleep(ds)
	svc := NewShareService(gs, ds, &fakeUploader{url: "u"}, store, newMemClaims())
	done := make(chan error, 1)
	go func() {
		_, err := svc.Deliver(context.Background(), 1234567)
		done <- err
	}()
	<-fetch.started
	if _, err := svc.Deliver(context.Background(), 1234567); !errors.Is(err, domain.ErrBusy) {
		t.Fatalf("%v", err)
	}
	close(block)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type gateFetch struct {
	payload []byte
	block   chan struct{}
	started chan struct{}
	once    sync.Once
}

func (g *gateFetch) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	g.once.Do(func() {
		close(g.started)
		<-g.block
	})
	_ = rawURL
	_ = referer
	return io.NopCloser(bytes.NewReader(g.payload)), "image/webp", nil
}
