package history

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
)

func TestJSONStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "history.json")
	s, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	file := &domain.ManagedFile{
		ID:         "0123456789abcdef",
		Name:       "a.txt",
		Size:       3,
		OwnerToken: "tok",
		Secret:     "sec",
		CreatedAt:  time.Now().UTC().Truncate(time.Millisecond),
	}
	if err := s.Save(context.Background(), file); err != nil {
		t.Fatal(err)
	}
	s2, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s2.Get(context.Background(), file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "a.txt" || got.OwnerToken != "tok" {
		t.Fatalf("%+v", got)
	}
	if err := s2.Delete(context.Background(), file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s2.Get(context.Background(), file.ID); err != domain.ErrNotFound {
		t.Fatalf("%v", err)
	}
}
