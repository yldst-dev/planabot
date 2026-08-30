package usecase

import (
	"context"
	"io"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
)

type FileRepository interface {
	Save(ctx context.Context, file *domain.ManagedFile) error
	Get(ctx context.Context, id string) (*domain.ManagedFile, error)
	List(ctx context.Context) ([]*domain.ManagedFile, error)
	Delete(ctx context.Context, id string) error
}

type HostGateway interface {
	Instance(ctx context.Context) (Instance, error)
	Upload(ctx context.Context, req UploadRequest) (*domain.ManagedFile, error)
	Download(ctx context.Context, id string, secret []byte, password, shareURL string) (io.ReadCloser, error)
	Metadata(ctx context.Context, id string, secret []byte, password, shareURL string) (*RemoteMetadata, error)
	OwnerInfo(ctx context.Context, id, ownerToken string) (*OwnerInfo, error)
	Delete(ctx context.Context, id, ownerToken string) error
	SetPassword(ctx context.Context, id, ownerToken string, secret []byte, password, shareURL string) error
	SetDownloadLimit(ctx context.Context, id, ownerToken string, limit int) error
	Exists(ctx context.Context, id string) (*ExistsResult, error)
}

type UploadRequest struct {
	Name      string
	MIME      string
	Size      int64
	Body      io.Reader
	Downloads int
	ExpireSec int
}

type RemoteMetadata struct {
	Name          string
	Size          int64
	MIME          string
	Manifest      domain.Manifest
	TTLMillis     int64
	FinalDownload bool
	RequiresPass  bool
}

type OwnerInfo struct {
	DownloadLimit int
	DownloadCount int
	TTLMillis     int64
}

type ExistsResult struct {
	RequiresPassword bool
}

type Instance struct {
	Version string
	Commit  string
	Source  string
	Limits  domain.Limits
}

type UploadInput struct {
	Name      string
	MIME      string
	Size      int64
	Body      io.Reader
	Downloads int
	ExpireSec int
	Password  string
}

type DownloadInput struct {
	ID       string
	URL      string
	Password string
	DestHint string
}

type PasswordInput struct {
	ID       string
	URL      string
	Password string
}

type LimitInput struct {
	ID    string
	URL   string
	Limit int
}

type ImportInput struct {
	URL        string
	OwnerToken string
	Password   string
}
