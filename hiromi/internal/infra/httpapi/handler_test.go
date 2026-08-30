package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"hiromi/internal/domain"
	"hiromi/internal/usecase"
)

type fakeGallery struct {
	g *domain.Gallery
}

func (f fakeGallery) GetByID(ctx context.Context, id uint64) (*domain.Gallery, error) {
	if f.g == nil || f.g.ID != id {
		return nil, domain.ErrNotFound
	}
	cp := *f.g
	return &cp, nil
}

func (f fakeGallery) ListIDs(ctx context.Context, q domain.ListQuery) (*domain.IDPage, error) {
	return &domain.IDPage{IDs: []uint64{f.g.ID}, Total: 1, Page: q.Page}, nil
}

func (f fakeGallery) ImageURL(ctx context.Context, hash string, format domain.ImageFormat) (string, error) {
	return "https://example.test/" + hash + "." + string(format), nil
}

func (f fakeGallery) ThumbnailURL(hash string, format domain.ImageFormat, size domain.ThumbSize) (string, error) {
	return "https://example.test/tn/" + hash, nil
}

func (f fakeGallery) ResolveFile(ctx context.Context, file *domain.File) error { return nil }

func (f fakeGallery) ResolveVideo(video *domain.Video) {}

func (f fakeGallery) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	return io.NopCloser(strings.NewReader("img")), "image/webp", nil
}

type fakeTags struct{}

func (fakeTags) Search(ctx context.Context, term string) ([]domain.TagCount, error) {
	tag, _ := domain.NewTag(domain.TagArtist, "mimonel", false)
	return []domain.TagCount{{Tag: tag, Count: 3}}, nil
}

func (fakeTags) List(ctx context.Context, typ domain.TagType, initial domain.NameInitial) ([]domain.Tag, error) {
	tag, _ := domain.NewTag(typ, "sample", false)
	return []domain.Tag{tag}, nil
}

func (fakeTags) Languages(ctx context.Context, tag domain.Tag) ([]domain.Language, error) {
	lang, _ := domain.LookupLanguage("korean")
	return []domain.Language{lang}, nil
}

func testHandler() http.Handler {
	g := &domain.Gallery{
		ID:          123,
		Title:       "sample",
		Type:        domain.TypeManga,
		GalleryPath: "/manga/sample-123.html",
		ReaderPath:  "/reader/123.html",
		AddedAt:     time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC),
		Files: []domain.File{{
			Index: 0, Name: "01.jpg", Hash: "abc", Width: 10, Height: 20, HasWebP: true, HasThumb: true,
			URLs: domain.FileURLs{WebP: "https://cdn.test/abc.webp"},
		}},
		Related: []uint64{456},
	}
	fake := fakeGallery{g: g}
	hs := usecase.NewGalleryService(fake, fake, fake)
	ts := usecase.NewTagService(fakeTags{})
	ms := usecase.NewMediaService(fake, fake, fake, "https://hitomi.la")
	cs := usecase.NewCatalogService()
	store := newMemStore()
	ds := usecase.NewDownloadService(fake, fake, fake, store, "https://hitomi.la").WithViewer(stubViewer{})
	h := NewHandler("https://hitomi.la", hs, ts, ms, cs, ds)
	return NewMux(h)
}

type memStore struct {
	mu    sync.Mutex
	files map[string][]byte
}

func newMemStore() *memStore {
	return &memStore{files: map[string][]byte{}}
}

type stubViewer struct{}

func (stubViewer) Render(doc domain.ViewerDocument) ([]byte, error) {
	return []byte(doc.Title), nil
}

func (m *memStore) Root() string { return "/tmp/downloads" }

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

func TestGetGalleryHTTP(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/v1/galleries/123")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body galleryDTO
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.ID != 123 || body.Title != "sample" || body.PageCount != 1 {
		t.Fatalf("%+v", body)
	}
	if body.URLs.Reader != "https://hitomi.la/reader/123.html" {
		t.Fatalf("reader %s", body.URLs.Reader)
	}
}

func TestGetGalleryNotFound(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/v1/galleries/999")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestHealthAndTypes(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("health %d", resp.StatusCode)
	}
	resp, err = http.Get(srv.URL + "/v1/types")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("types %d", resp.StatusCode)
	}
}

func TestSearchHTTP(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/v1/search?q=type:manga&language=korean")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body listDTO
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Total != 1 || len(body.IDs) != 1 || body.IDs[0] != 123 {
		t.Fatalf("%+v", body)
	}
}

func TestProxyFileHTTP(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/v1/proxy/galleries/123/files/0?format=webp")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if string(b) != "img" {
		t.Fatalf("body %q", b)
	}
}

func TestDownloadGalleryHTTP(t *testing.T) {
	srv := httptest.NewServer(testHandler())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/galleries/123/download", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body galleryDownloadDTO
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.ID != 123 || body.PageCount != 1 {
		t.Fatalf("%+v", body)
	}
	if len(body.Saved) != 1 || body.Saved[0].Name != "001.webp" {
		t.Fatalf("saved %+v failed %+v", body.Saved, body.Failed)
	}
}
