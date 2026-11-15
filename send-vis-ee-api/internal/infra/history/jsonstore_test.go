package history

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
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

func record(id, token string) *domain.ManagedFile {
	return &domain.ManagedFile{ID: id, Name: id + ".txt", Size: 1, OwnerToken: token, Secret: "sec", CreatedAt: time.Now().UTC()}
}

func TestJSONStoresSharingOneFileKeepEveryRecord(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "history.json")
	api, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	cli, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := api.Save(ctx, record("aaaaaaaaaaaaaaaa", "token-a")); err != nil {
		t.Fatal(err)
	}
	if err := cli.Save(ctx, record("bbbbbbbbbbbbbbbb", "token-b")); err != nil {
		t.Fatal(err)
	}
	if err := api.Save(ctx, record("cccccccccccccccc", "token-c")); err != nil {
		t.Fatal(err)
	}
	got, err := api.Get(ctx, "bbbbbbbbbbbbbbbb")
	if err != nil || got.OwnerToken != "token-b" {
		t.Fatalf("api sees cli upload: %+v %v", got, err)
	}
	if err := cli.Delete(ctx, "aaaaaaaaaaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	files, err := reopened.List(ctx)
	if err != nil || len(files) != 2 {
		t.Fatalf("%d %v", len(files), err)
	}
	for id, token := range map[string]string{"bbbbbbbbbbbbbbbb": "token-b", "cccccccccccccccc": "token-c"} {
		f, err := reopened.Get(ctx, id)
		if err != nil || f.OwnerToken != token {
			t.Fatalf("%s: %+v %v", id, f, err)
		}
	}
}

func TestJSONStoreConcurrentWritersLoseNothing(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "history.json")
	stores := make([]*JSONStore, 2)
	for i := range stores {
		s, err := OpenJSON(path)
		if err != nil {
			t.Fatal(err)
		}
		stores[i] = s
	}
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < 5; n++ {
				id := fmt.Sprintf("%016x", w*100+n+1)
				if err := stores[w%2].Save(ctx, record(id, "token-"+id)); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	files, err := stores[0].List(ctx)
	if err != nil || len(files) != 40 {
		t.Fatalf("%d %v", len(files), err)
	}
	for _, f := range files {
		if f.OwnerToken != "token-"+f.ID {
			t.Fatalf("%+v", f)
		}
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp")); len(left) != 0 {
		t.Fatalf("temp files left %v", left)
	}
}

func TestJSONStoreNeverOverwritesAnUnreadableFile(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "history.json")
	s, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(ctx, record("aaaaaaaaaaaaaaaa", "token-a")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"files": [`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(ctx, record("bbbbbbbbbbbbbbbb", "token-b")); err == nil {
		t.Fatal("expected error")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != `{"files": [` {
		t.Fatalf("%q %v", raw, err)
	}
}

func TestSavingARecordWithoutATokenKeepsTheStoredToken(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "history.json")
	a, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := OpenJSON(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Save(ctx, record("aaaaaaaaaaaaaaaa", "token-a")); err != nil {
		t.Fatal(err)
	}
	if err := b.Save(ctx, record("aaaaaaaaaaaaaaaa", "")); err != nil {
		t.Fatal(err)
	}
	got, err := a.Get(ctx, "aaaaaaaaaaaaaaaa")
	if err != nil || got.OwnerToken != "token-a" {
		t.Fatalf("%+v %v", got, err)
	}
}
