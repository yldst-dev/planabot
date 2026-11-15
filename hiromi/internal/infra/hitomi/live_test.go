//go:build live

package hitomi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"hiromi/internal/domain"
)

func TestLiveGalleryAndIndex(t *testing.T) {
	c := New(DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	g, err := c.GetByID(ctx, 1234567)
	if err != nil {
		t.Fatal(err)
	}
	if g.Title == "" || len(g.Files) == 0 || g.Files[0].URLs.WebP == "" {
		t.Fatalf("incomplete gallery %+v", g)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, g.Files[0].URLs.WebP, nil)
	req.Header.Set("Referer", "https://hitomi.la/reader/1234567.html")
	req.Header.Set("User-Agent", DefaultConfig().UserAgent)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("image status %d url %s", resp.StatusCode, g.Files[0].URLs.WebP)
	}
	page, err := c.ListIDs(ctx, domain.ListQuery{
		Language: "korean",
		Sort:     domain.SortAdded,
		Page:     domain.NormalizePage(0, 5),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.IDs) == 0 || page.Total == 0 {
		t.Fatalf("empty index %+v", page)
	}
}
