package sendshare

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/yldst-dev/send.vis.ee-api/pkg/sendvis"
)

type stubVis struct {
	downloads int
	expire    int
	name      string
	mime      string
}

func (s *stubVis) Instance(context.Context) (sendvis.Instance, error) {
	return sendvis.Instance{Limits: sendvis.Limits{MaxDownloads: 20, MaxExpireSeconds: 259200}}, nil
}

func (s *stubVis) Put(_ context.Context, name, mime string, size int64, body io.Reader, downloads, expire int) (*sendvis.File, error) {
	s.name = name
	s.mime = mime
	s.downloads = downloads
	s.expire = expire
	_, _ = io.Copy(io.Discard, body)
	return &sendvis.File{URL: "https://send.vis.ee/download/abc/#sec", Name: name, Size: size}, nil
}

func TestUploaderUsesHostMaxLimits(t *testing.T) {
	stub := &stubVis{}
	u := NewWithClient(stub)
	got, err := u.Upload(context.Background(), "viewer.html", 12, bytes.NewReader([]byte("<html></html>")))
	if err != nil {
		t.Fatal(err)
	}
	if stub.downloads != 20 || stub.expire != 259200 {
		t.Fatalf("limits %d %d", stub.downloads, stub.expire)
	}
	if stub.mime != "text/html; charset=utf-8" || stub.name != "viewer.html" {
		t.Fatalf("%s %s", stub.mime, stub.name)
	}
	if got.URL == "" {
		t.Fatal("url")
	}
}
