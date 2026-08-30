//go:build live

package sendhost

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	scrypto "github.com/yldst-dev/send.vis.ee-api/internal/infra/crypto"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

func TestLiveSendVisEE(t *testing.T) {
	c, err := New(domain.DefaultHost)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	inst, err := c.Instance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if inst.Version == "" {
		t.Fatal("empty version")
	}
	plain := []byte("sendvis live probe " + time.Now().Format(time.RFC3339Nano))
	file, err := c.Upload(ctx, usecase.UploadRequest{
		Name:      "sendvis-live.txt",
		MIME:      "text/plain",
		Size:      int64(len(plain)),
		Body:      bytes.NewReader(plain),
		Downloads: 2,
		ExpireSec: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Log(file.URL)
	defer c.Delete(context.Background(), file.ID, file.OwnerToken)
	secret, err := scrypto.Decode(file.Secret)
	if err != nil {
		t.Fatal(err)
	}
	meta, err := c.Metadata(ctx, file.ID, secret, "", file.URL)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "sendvis-live.txt" {
		t.Fatalf("name %s", meta.Name)
	}
	rc, err := c.Download(ctx, file.ID, secret, "", file.URL)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("download mismatch %q", got)
	}
}
