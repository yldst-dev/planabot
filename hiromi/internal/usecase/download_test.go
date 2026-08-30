package usecase

import (
	"bytes"
	"context"
	"io"
	"path"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"hiromi/internal/domain"
)

type memStore struct {
	root  string
	mu    sync.Mutex
	files map[string][]byte
}

func newMemStore() *memStore {
	return &memStore{root: "/tmp/downloads", files: map[string][]byte{}}
}

func (m *memStore) Root() string { return m.root }

func (m *memStore) Exists(relPath string) (bool, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.files[relPath]
	if !ok {
		return false, 0, nil
	}
	return true, int64(len(b)), nil
}

func (m *memStore) Read(relPath string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.files[relPath]
	if !ok {
		return nil, domain.ErrNotFound
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out, nil
}

func (m *memStore) Write(relPath string, r io.Reader) (int64, error) {
	b, err := io.ReadAll(r)
	if err != nil {
		return 0, err
	}
	m.mu.Lock()
	m.files[relPath] = b
	m.mu.Unlock()
	return int64(len(b)), nil
}

func (m *memStore) RemoveAll(relPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prefix := relPath + "/"
	for k := range m.files {
		if k == relPath || strings.HasPrefix(k, prefix) {
			delete(m.files, k)
		}
	}
	return nil
}

type seqFetch struct {
	payload []byte
	mu      sync.Mutex
	urls    []string
}

func (s *seqFetch) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	s.mu.Lock()
	s.urls = append(s.urls, rawURL)
	s.mu.Unlock()
	if !strings.Contains(referer, "/reader/") {
		return nil, "", domain.ErrRemote
	}
	return io.NopCloser(bytes.NewReader(s.payload)), "image/webp", nil
}

func testGallery() *domain.Gallery {
	return &domain.Gallery{
		ID:          1234567,
		Title:       "sample",
		Type:        domain.TypeManga,
		ReaderPath:  "/reader/1234567.html",
		GalleryPath: "/manga/sample-1234567.html",
		Language:    &domain.Language{Name: "korean", LocalName: "한국어"},
		Files: []domain.File{
			{Index: 0, Name: "01.jpg", Hash: "aaa", HasWebP: true, HasAVIF: true, URLs: domain.FileURLs{WebP: "https://cdn.test/aaa.webp", AVIF: "https://cdn.test/aaa.avif"}},
			{Index: 1, Name: "02.jpg", Hash: "bbb", HasWebP: true, URLs: domain.FileURLs{WebP: "https://cdn.test/bbb.webp"}},
		},
	}
}

func TestDownloadWritesPerGalleryID(t *testing.T) {
	g := testGallery()
	store := newMemStore()
	fetch := &seqFetch{payload: []byte("IMG")}
	fake := fakeRepo{g: g}
	svc := NewDownloadService(fake, fake, fetch, store, "https://hitomi.la")
	instantSleep(svc)
	res, err := svc.Download(context.Background(), 1234567, domain.DefaultDownloadOptions())
	if err != nil {
		t.Fatal(err)
	}
	if res.GalleryID != 1234567 {
		t.Fatalf("id %d", res.GalleryID)
	}
	if res.Dir != path.Join(store.Root(), "1234567") {
		t.Fatalf("dir %s", res.Dir)
	}
	if len(res.Saved) != 2 {
		t.Fatalf("saved %d failed %+v", len(res.Saved), res.Failed)
	}
	if _, ok := store.files["1234567/001.webp"]; !ok {
		t.Fatalf("missing 001 files=%v", keys(store.files))
	}
	if _, ok := store.files["1234567/002.webp"]; !ok {
		t.Fatalf("missing 002 files=%v", keys(store.files))
	}
	if _, ok := store.files["1234567/info.json"]; !ok {
		t.Fatal("missing info.json")
	}
	if !strings.Contains(string(store.files["1234567/info.json"]), "1234567") {
		t.Fatalf("info %s", store.files["1234567/info.json"])
	}
}

func TestDownloadSkipsExisting(t *testing.T) {
	g := testGallery()
	store := newMemStore()
	store.files["1234567/001.webp"] = []byte("OLD")
	fetch := &seqFetch{payload: []byte("NEW")}
	fake := fakeRepo{g: g}
	svc := NewDownloadService(fake, fake, fetch, store, "https://hitomi.la")
	instantSleep(svc)
	res, err := svc.Download(context.Background(), 1234567, domain.DefaultDownloadOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 1 || res.Skipped[0].Name != "001.webp" {
		t.Fatalf("skipped %+v", res.Skipped)
	}
	if len(res.Saved) != 1 || res.Saved[0].Name != "002.webp" {
		t.Fatalf("saved %+v", res.Saved)
	}
	if string(store.files["1234567/001.webp"]) != "OLD" {
		t.Fatal("overwrote existing")
	}
}

func TestDownloadWritesViewer(t *testing.T) {
	g := testGallery()
	store := newMemStore()
	fetch := &seqFetch{payload: []byte("IMG")}
	fake := fakeRepo{g: g}
	svc := NewDownloadService(fake, fake, fetch, store, "https://hitomi.la").WithViewer(stubViewer{})
	instantSleep(svc)
	res, err := svc.Download(context.Background(), 1234567, domain.DefaultDownloadOptions())
	if err != nil {
		t.Fatal(err)
	}
	if res.Viewer == "" {
		t.Fatal("viewer path")
	}
	html, err := store.Read("1234567/viewer.html")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(html), "sample") {
		t.Fatalf("html %s", html)
	}
	if !strings.Contains(string(html), "pages=2") {
		t.Fatalf("pages %s", html)
	}
}

type stubViewer struct{}

func (stubViewer) Render(doc domain.ViewerDocument) ([]byte, error) {
	return []byte(doc.Title + " pages=" + strconv.Itoa(len(doc.Pages))), nil
}

func TestChooseFormatFallback(t *testing.T) {
	f := domain.File{HasAVIF: true}
	got, err := f.ChooseFormat(domain.FormatWebP)
	if err != nil || got != domain.FormatAVIF {
		t.Fatalf("got %s %v", got, err)
	}
}

type fakeRepo struct {
	g *domain.Gallery
}

func (f fakeRepo) GetByID(ctx context.Context, id uint64) (*domain.Gallery, error) {
	if f.g == nil || f.g.ID != id {
		return nil, domain.ErrNotFound
	}
	cp := *f.g
	return &cp, nil
}

func (f fakeRepo) ListIDs(ctx context.Context, q domain.ListQuery) (*domain.IDPage, error) {
	if f.g == nil {
		return &domain.IDPage{Page: q.Page}, nil
	}
	return &domain.IDPage{IDs: []uint64{f.g.ID}, Total: 1, Page: q.Page}, nil
}

func (f fakeRepo) ImageURL(ctx context.Context, hash string, format domain.ImageFormat) (string, error) {
	return "https://cdn.test/" + hash + "." + string(format), nil
}

func (f fakeRepo) ThumbnailURL(hash string, format domain.ImageFormat, size domain.ThumbSize) (string, error) {
	return "", nil
}

func (f fakeRepo) ResolveFile(ctx context.Context, file *domain.File) error { return nil }

func (f fakeRepo) ResolveVideo(video *domain.Video) {}

func TestDownloadRetries503ThenSucceeds(t *testing.T) {
	g := testGallery()
	g.Files = g.Files[:1]
	g.Files[0].URLs.WebP = "https://w2.gold-usergeneratedcontent.net/1/2/aaa.webp"
	store := newMemStore()
	fetch := &flakyFetch{fail: 2, payload: []byte("OK")}
	fake := fakeRepo{g: g}
	svc := NewDownloadService(fake, fake, fetch, store, "https://hitomi.la")
	instantSleep(svc)
	res, err := svc.Download(context.Background(), 1234567, domain.DefaultDownloadOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failed) != 0 || len(res.Saved) != 1 {
		t.Fatalf("saved %+v failed %+v hits %v", res.Saved, res.Failed, fetch.urls)
	}
	if len(fetch.urls) < 3 {
		t.Fatalf("retries %v", fetch.urls)
	}
	if fetch.urls[0] == fetch.urls[2] {
		t.Fatalf("expected alternate host %v", fetch.urls)
	}
}

func TestDownloadDoesNotRetry404(t *testing.T) {
	g := testGallery()
	g.Files = g.Files[:1]
	store := newMemStore()
	fetch := &flakyFetch{notFound: true}
	fake := fakeRepo{g: g}
	svc := NewDownloadService(fake, fake, fetch, store, "https://hitomi.la")
	instantSleep(svc)
	res, err := svc.Download(context.Background(), 1234567, domain.DefaultDownloadOptions())
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Failed) != 1 {
		t.Fatalf("failed %+v", res.Failed)
	}
	if len(fetch.urls) != 1 {
		t.Fatalf("hits %v", fetch.urls)
	}
}

func TestAlternateCDNURL(t *testing.T) {
	in := "https://w2.gold-usergeneratedcontent.net/1/2/abc.webp"
	out := alternateCDNURL(in)
	if out != "https://w1.gold-usergeneratedcontent.net/1/2/abc.webp" {
		t.Fatalf("got %s", out)
	}
	if alternateCDNURL(out) != in {
		t.Fatal("roundtrip")
	}
}

func TestDownloadBackoff(t *testing.T) {
	if downloadBackoff(0) != 500*time.Millisecond {
		t.Fatal("0")
	}
	if downloadBackoff(1) != time.Second {
		t.Fatal("1")
	}
	if downloadBackoff(10) != 12*time.Second {
		t.Fatal("cap")
	}
}

type flakyFetch struct {
	fail     int
	notFound bool
	payload  []byte
	mu       sync.Mutex
	urls     []string
}

func (f *flakyFetch) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	f.mu.Lock()
	f.urls = append(f.urls, rawURL)
	n := len(f.urls)
	f.mu.Unlock()
	if f.notFound {
		return nil, "", domain.ErrNotFound
	}
	if n <= f.fail {
		return nil, "", &domain.RemoteStatusError{Status: 503}
	}
	return io.NopCloser(bytes.NewReader(f.payload)), "image/webp", nil
}

func instantSleep(s *DownloadService) {
	s.sleep = func(context.Context, time.Duration) error { return nil }
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
