package sendshare

import (
	"context"
	"io"

	"github.com/yldst-dev/send.vis.ee-api/pkg/sendvis"

	"hiromi/internal/port"
)

type visClient interface {
	Instance(ctx context.Context) (sendvis.Instance, error)
	Put(ctx context.Context, name, mime string, size int64, body io.Reader, downloads, expire int) (*sendvis.File, error)
}

type Uploader struct {
	client visClient
}

func New(host string) (*Uploader, error) {
	c, err := sendvis.New(sendvis.Options{Host: host, MemoryOnly: true})
	if err != nil {
		return nil, err
	}
	return &Uploader{client: c}, nil
}

func NewWithClient(c visClient) *Uploader {
	return &Uploader{client: c}
}

func (u *Uploader) Limits(ctx context.Context) (port.ShareLimits, error) {
	inst, err := u.client.Instance(ctx)
	if err != nil {
		return port.ShareLimits{}, err
	}
	lim := inst.Limits.WithDefaults()
	return port.ShareLimits{Downloads: lim.MaxDownloads, ExpireSec: lim.MaxExpireSeconds}, nil
}

func (u *Uploader) Upload(ctx context.Context, name string, size int64, body io.Reader) (*port.UploadedShare, error) {
	lim, err := u.Limits(ctx)
	if err != nil {
		return nil, err
	}
	file, err := u.client.Put(ctx, name, "text/html; charset=utf-8", size, body, lim.Downloads, lim.ExpireSec)
	if err != nil {
		return nil, err
	}
	return &port.UploadedShare{URL: file.URL, Name: file.Name, Size: file.Size}, nil
}

var _ port.ShareUploader = (*Uploader)(nil)
