package usecase

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	scrypto "github.com/yldst-dev/send.vis.ee-api/internal/infra/crypto"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/history"
)

type mockHost struct {
	host     string
	limits   domain.Limits
	upload   func(UploadRequest) (*domain.ManagedFile, error)
	password func(id, token string, secret []byte, password, url string) error
	info     func(id, token string) (*OwnerInfo, error)
	del      func(id, token string) error
	exists   func(id string) (*ExistsResult, error)
	meta     func(id string, secret []byte, password, url string) (*RemoteMetadata, error)
	dl       func(id string, secret []byte, password, url string) (io.ReadCloser, error)
	limit    func(id, token string, n int) error
}

func (m *mockHost) Host() string { return m.host }

func (m *mockHost) Instance(context.Context) (Instance, error) {
	return Instance{Version: "v3.4.27", Limits: m.limits.WithDefaults()}, nil
}

func (m *mockHost) Upload(_ context.Context, req UploadRequest) (*domain.ManagedFile, error) {
	if m.upload != nil {
		return m.upload(req)
	}
	return &domain.ManagedFile{
		ID:            "0123456789abcdef",
		Host:          m.host,
		URL:           domain.BuildShareURL(m.host, "0123456789abcdef", "secret"),
		Name:          req.Name,
		Size:          req.Size,
		MIME:          req.MIME,
		Secret:        "secret",
		OwnerToken:    "owner",
		DownloadMax:   req.Downloads,
		ExpireSeconds: req.ExpireSec,
		CreatedAt:     time.Now(),
		ExpiresAt:     time.Now().Add(time.Duration(req.ExpireSec) * time.Second),
	}, nil
}

func (m *mockHost) Download(ctx context.Context, id string, secret []byte, password, shareURL string) (io.ReadCloser, error) {
	if m.dl != nil {
		return m.dl(id, secret, password, shareURL)
	}
	return io.NopCloser(strings.NewReader("hello")), nil
}

func (m *mockHost) Metadata(ctx context.Context, id string, secret []byte, password, shareURL string) (*RemoteMetadata, error) {
	if m.meta != nil {
		return m.meta(id, secret, password, shareURL)
	}
	return &RemoteMetadata{Name: "a.txt", Size: 5, MIME: "text/plain"}, nil
}

func (m *mockHost) OwnerInfo(ctx context.Context, id, ownerToken string) (*OwnerInfo, error) {
	if m.info != nil {
		return m.info(id, ownerToken)
	}
	return &OwnerInfo{DownloadLimit: 1, DownloadCount: 0, TTLMillis: 1000}, nil
}

func (m *mockHost) Delete(ctx context.Context, id, ownerToken string) error {
	if m.del != nil {
		return m.del(id, ownerToken)
	}
	return nil
}

func (m *mockHost) SetPassword(ctx context.Context, id, ownerToken string, secret []byte, password, shareURL string) error {
	if m.password != nil {
		return m.password(id, ownerToken, secret, password, shareURL)
	}
	return nil
}

func (m *mockHost) SetDownloadLimit(ctx context.Context, id, ownerToken string, limit int) error {
	if m.limit != nil {
		return m.limit(id, ownerToken, limit)
	}
	return nil
}

func (m *mockHost) Exists(ctx context.Context, id string) (*ExistsResult, error) {
	if m.exists != nil {
		return m.exists(id)
	}
	return &ExistsResult{}, nil
}

func TestUploadRejectsEmpty(t *testing.T) {
	svc := New(&mockHost{host: "https://send.vis.ee", limits: domain.FallbackLimits()}, history.NewMemory())
	_, err := svc.Upload(context.Background(), UploadInput{Name: "a.txt", Size: 0, Body: bytes.NewReader(nil)})
	if err != domain.ErrEmptyFile {
		t.Fatalf("%v", err)
	}
}

func TestUploadSavesHistory(t *testing.T) {
	repo := history.NewMemory()
	svc := New(&mockHost{host: "https://send.vis.ee", limits: domain.FallbackLimits()}, repo)
	file, err := svc.Upload(context.Background(), UploadInput{
		Name: "a.txt",
		Size: 4,
		Body: strings.NewReader("data"),
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get(context.Background(), file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "a.txt" || got.OwnerToken != "owner" {
		t.Fatalf("%+v", got)
	}
}

func TestUploadPassword(t *testing.T) {
	called := false
	host := &mockHost{
		host:   "https://send.vis.ee",
		limits: domain.FallbackLimits(),
		upload: func(req UploadRequest) (*domain.ManagedFile, error) {
			kc, _ := scrypto.Generate()
			return &domain.ManagedFile{
				ID:         "0123456789abcdef",
				Host:       "https://send.vis.ee",
				URL:        domain.BuildShareURL("https://send.vis.ee", "0123456789abcdef", kc.SecretEncoded()),
				Name:       req.Name,
				Size:       req.Size,
				Secret:     kc.SecretEncoded(),
				OwnerToken: "owner",
			}, nil
		},
		password: func(id, token string, secret []byte, password, url string) error {
			called = true
			if password != "pw" || token != "owner" {
				t.Fatalf("%s %s", password, token)
			}
			return nil
		},
	}
	svc := New(host, history.NewMemory())
	file, err := svc.Upload(context.Background(), UploadInput{
		Name:     "a.txt",
		Size:     1,
		Body:     strings.NewReader("x"),
		Password: "pw",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called || !file.HasPassword {
		t.Fatal("password not applied")
	}
}

func TestUploadTooLarge(t *testing.T) {
	svc := New(&mockHost{host: "https://send.vis.ee", limits: domain.FallbackLimits()}, history.NewMemory())
	_, err := svc.Upload(context.Background(), UploadInput{
		Name: "big.bin",
		Size: domain.FallbackMaxFileSize + 1,
		Body: bytes.NewReader(nil),
	})
	if err != domain.ErrTooLarge {
		t.Fatalf("%v", err)
	}
}

func TestForeignShareHostIsRejected(t *testing.T) {
	var called bool
	host := &mockHost{
		host:   "https://send.vis.ee",
		limits: domain.FallbackLimits(),
		meta: func(string, []byte, string, string) (*RemoteMetadata, error) {
			called = true
			return &RemoteMetadata{Name: "a.txt", Size: 5}, nil
		},
	}
	svc := New(host, history.NewMemory())
	foreign := "https://other.example/download/0123456789abcdef/#c2VjcmV0c2VjcmV0MTIzNA"
	own := "https://SEND.vis.ee/download/0123456789abcdef/#c2VjcmV0c2VjcmV0MTIzNA"
	if _, _, err := svc.Inspect(context.Background(), foreign, ""); err != domain.ErrInvalidURL {
		t.Fatalf("inspect %v", err)
	}
	if _, _, err := svc.Download(context.Background(), DownloadInput{URL: foreign}); err != domain.ErrInvalidURL {
		t.Fatalf("download %v", err)
	}
	if _, err := svc.Import(context.Background(), ImportInput{URL: foreign}); err != domain.ErrInvalidURL {
		t.Fatalf("import %v", err)
	}
	if _, err := svc.Exists(context.Background(), foreign); err != domain.ErrInvalidURL {
		t.Fatalf("exists %v", err)
	}
	if called {
		t.Fatal("host was asked about a foreign share")
	}
	if _, err := svc.Import(context.Background(), ImportInput{URL: own}); err != nil {
		t.Fatalf("own host %v", err)
	}
}

func TestImportKeepsAnExistingOwnerToken(t *testing.T) {
	repo := history.NewMemory()
	svc := New(&mockHost{host: "https://send.vis.ee", limits: domain.FallbackLimits()}, repo)
	if err := repo.Save(context.Background(), &domain.ManagedFile{ID: "0123456789abcdef", OwnerToken: "owner", Secret: "c2VjcmV0c2VjcmV0MTIzNA"}); err != nil {
		t.Fatal(err)
	}
	url := "https://send.vis.ee/download/0123456789abcdef/#c2VjcmV0c2VjcmV0MTIzNA"
	if _, err := svc.Import(context.Background(), ImportInput{URL: url}); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get(context.Background(), "0123456789abcdef")
	if err != nil || got.OwnerToken != "owner" {
		t.Fatalf("%+v %v", got, err)
	}
}
