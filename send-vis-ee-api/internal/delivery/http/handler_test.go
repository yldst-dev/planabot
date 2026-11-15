package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/history"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

type stubHost struct{}

func (stubHost) Host() string { return "https://send.vis.ee" }

func (stubHost) Instance(context.Context) (usecase.Instance, error) {
	return usecase.Instance{Version: "v3.4.27", Limits: domain.FallbackLimits()}, nil
}

func (stubHost) Upload(_ context.Context, req usecase.UploadRequest) (*domain.ManagedFile, error) {
	return &domain.ManagedFile{
		ID:            "0123456789abcdef",
		Host:          "https://send.vis.ee",
		URL:           "https://send.vis.ee/download/0123456789abcdef/#sec",
		Name:          req.Name,
		Size:          req.Size,
		MIME:          req.MIME,
		Secret:        "sec",
		OwnerToken:    "tok",
		DownloadMax:   req.Downloads,
		ExpireSeconds: req.ExpireSec,
		CreatedAt:     time.Now(),
		ExpiresAt:     time.Now().Add(time.Hour),
	}, nil
}

func (stubHost) Download(context.Context, string, []byte, string, string) (io.ReadCloser, error) {
	return nil, domain.ErrNotFound
}

func (stubHost) Metadata(context.Context, string, []byte, string, string) (*usecase.RemoteMetadata, error) {
	return nil, domain.ErrNotFound
}

func (stubHost) OwnerInfo(context.Context, string, string) (*usecase.OwnerInfo, error) {
	return &usecase.OwnerInfo{DownloadLimit: 3, TTLMillis: 3600000}, nil
}

func (stubHost) Delete(context.Context, string, string) error { return nil }

func (stubHost) SetPassword(context.Context, string, string, []byte, string, string) error {
	return nil
}

func (stubHost) SetDownloadLimit(context.Context, string, string, int) error { return nil }

func (stubHost) Exists(context.Context, string) (*usecase.ExistsResult, error) {
	return &usecase.ExistsResult{}, nil
}

func TestHealthAndUpload(t *testing.T) {
	repo := history.NewMemory()
	svc := usecase.New(stubHost{}, repo)
	h := NewHandler(svc, "https://send.vis.ee")
	r := NewRouter(h, "")

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("health %d", rec.Code)
	}

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("file", "hello.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	_ = w.WriteField("download_limit", "3")
	_ = w.WriteField("expire_seconds", "3600")
	w.Close()
	req = httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/v1/files", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload %d %s", rec.Code, rec.Body.String())
	}
	var body fileBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.ID != "0123456789abcdef" || body.Name != "hello.txt" {
		t.Fatalf("%+v", body)
	}

	req = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/v1/files", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "hello.txt") {
		t.Fatalf("list %s", rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "http://localhost:8080/v1/instance", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("instance %d", rec.Code)
	}
}

func TestAPIKey(t *testing.T) {
	svc := usecase.New(stubHost{}, history.NewMemory())
	r := NewRouter(NewHandler(svc, "https://send.vis.ee"), "secret")
	req := httptest.NewRequest(http.MethodGet, "/v1/files", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("%d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/v1/files", nil)
	req.Header.Set("X-API-Key", "secret")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("with key %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("health behind key %d", rec.Code)
	}
}

func TestKeylessModeRefusesBrowsersAndForeignHostNames(t *testing.T) {
	svc := usecase.New(stubHost{}, history.NewMemory())
	r := NewRouter(NewHandler(svc, "https://send.vis.ee"), "")
	cases := []struct {
		name   string
		target string
		origin string
		want   int
	}{
		{"loopback address", "http://127.0.0.1:8080/v1/files", "", 200},
		{"localhost", "http://localhost:8080/v1/files", "", 200},
		{"ipv6 loopback", "http://[::1]:8080/v1/files", "", 200},
		{"rebinding name", "http://attacker.example:8080/v1/files", "", 403},
		{"lan address", "http://192.168.0.5:8080/v1/files", "", 403},
		{"web page origin", "http://127.0.0.1:8080/v1/files", "https://attacker.example", 403},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, c.target, nil)
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Fatalf("%s: %d", c.name, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "http://attacker.example:8080/healthz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("health %d", rec.Code)
	}
}

func TestNoCrossOriginHeaders(t *testing.T) {
	svc := usecase.New(stubHost{}, history.NewMemory())
	for _, key := range []string{"", "secret"} {
		r := NewRouter(NewHandler(svc, "https://send.vis.ee"), key)
		req := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:8080/v1/files/0123456789abcdef", nil)
		req.Header.Set("Origin", "https://attacker.example")
		req.Header.Set("Access-Control-Request-Method", "DELETE")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code < 400 || rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("key %q: %d %v", key, rec.Code, rec.Header())
		}
		req = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/healthz", nil)
		rec = httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("key %q: health has cors", key)
		}
	}
}
