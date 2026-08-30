//go:build live

package sendshare

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

func TestLiveUploadViewerHTML(t *testing.T) {
	u, err := New("https://send.vis.ee")
	if err != nil {
		t.Fatal(err)
	}
	html := []byte("<!doctype html><meta charset=utf-8><title>hiromi</title><p>ok</p>")
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	lim, err := u.Limits(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if lim.Downloads < 1 || lim.ExpireSec < 1 {
		t.Fatalf("%+v", lim)
	}
	got, err := u.Upload(ctx, "viewer.html", int64(len(html)), bytes.NewReader(html))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.URL, "https://send.vis.ee/download/") || !strings.Contains(got.URL, "#") {
		t.Fatalf("%s", got.URL)
	}
	t.Log(got.URL)
}