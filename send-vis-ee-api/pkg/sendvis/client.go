package sendvis

import (
	"context"
	"io"
	"os"
	"path/filepath"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/history"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/sendhost"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

type File = domain.ManagedFile
type Limits = domain.Limits
type Instance = usecase.Instance
type RemoteMetadata = usecase.RemoteMetadata

type Client struct {
	svc  *usecase.Service
	host string
}

type Options struct {
	Host        string
	HistoryPath string
	UserAgent   string
	MemoryOnly  bool
}

func New(opts Options) (*Client, error) {
	hostName := opts.Host
	if hostName == "" {
		hostName = domain.DefaultHost
	}
	var hostOpts []sendhost.Option
	if opts.UserAgent != "" {
		hostOpts = append(hostOpts, sendhost.WithUserAgent(opts.UserAgent))
	}
	host, err := sendhost.New(hostName, hostOpts...)
	if err != nil {
		return nil, err
	}
	var repo usecase.FileRepository
	if opts.MemoryOnly {
		repo = history.NewMemory()
	} else {
		path := opts.HistoryPath
		if path == "" {
			dir, err := os.UserConfigDir()
			if err != nil {
				dir = "."
			}
			path = filepath.Join(dir, "sendvis", "history.json")
		}
		store, err := history.OpenJSON(path)
		if err != nil {
			return nil, err
		}
		repo = store
	}
	return &Client{svc: usecase.New(host, repo), host: host.Host()}, nil
}

func (c *Client) Host() string { return c.host }

func (c *Client) Instance(ctx context.Context) (Instance, error) {
	return c.svc.Instance(ctx)
}

func (c *Client) Upload(ctx context.Context, in usecase.UploadInput) (*File, error) {
	return c.svc.Upload(ctx, in)
}

func (c *Client) Put(ctx context.Context, name, mime string, size int64, body io.Reader, downloads, expire int) (*File, error) {
	return c.svc.Upload(ctx, usecase.UploadInput{
		Name:      name,
		MIME:      mime,
		Size:      size,
		Body:      body,
		Downloads: downloads,
		ExpireSec: expire,
	})
}

func (c *Client) UploadPath(ctx context.Context, path string, downloads, expire int, password string) (*File, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	return c.svc.Upload(ctx, usecase.UploadInput{
		Name:      filepath.Base(path),
		Size:      st.Size(),
		Body:      f,
		Downloads: downloads,
		ExpireSec: expire,
		Password:  password,
	})
}

func (c *Client) List(ctx context.Context) ([]*File, error) {
	return c.svc.List(ctx)
}

func (c *Client) Get(ctx context.Context, idOrURL string, refresh bool) (*File, error) {
	return c.svc.Get(ctx, idOrURL, refresh)
}

func (c *Client) Delete(ctx context.Context, idOrURL string) error {
	return c.svc.Delete(ctx, idOrURL)
}

func (c *Client) SetPassword(ctx context.Context, idOrURL, password string) (*File, error) {
	return c.svc.SetPassword(ctx, usecase.PasswordInput{ID: idOrURL, Password: password})
}

func (c *Client) SetDownloadLimit(ctx context.Context, idOrURL string, limit int) (*File, error) {
	return c.svc.SetDownloadLimit(ctx, usecase.LimitInput{ID: idOrURL, Limit: limit})
}

func (c *Client) Download(ctx context.Context, idOrURL, password string) (io.ReadCloser, *RemoteMetadata, error) {
	return c.svc.Download(ctx, usecase.DownloadInput{URL: idOrURL, Password: password})
}

func (c *Client) Inspect(ctx context.Context, idOrURL, password string) (*RemoteMetadata, *File, error) {
	return c.svc.Inspect(ctx, idOrURL, password)
}

func (c *Client) Import(ctx context.Context, shareURL, ownerToken, password string) (*File, error) {
	return c.svc.Import(ctx, usecase.ImportInput{URL: shareURL, OwnerToken: ownerToken, Password: password})
}

func (c *Client) Exists(ctx context.Context, idOrURL string) (*usecase.ExistsResult, error) {
	return c.svc.Exists(ctx, idOrURL)
}
