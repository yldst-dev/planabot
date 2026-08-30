package hitomi

import (
	"context"
	"testing"
	"time"

	"hiromi/internal/domain"
)

func TestImageURLUsesRouting(t *testing.T) {
	c := New(Config{
		CDN:     "gold-usergeneratedcontent.net",
		Timeout: time.Second,
	})
	r, err := parseGG(sampleGG)
	if err != nil {
		t.Fatal(err)
	}
	c.gg = r
	c.ggAt = time.Now()
	hash := "8d0f5c4f040555966b1d757828071b7a68b2106df1bd27a428740ed993eb8292"
	u, err := c.ImageURL(context.Background(), hash, domain.FormatWebP)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://w2.gold-usergeneratedcontent.net/1788012002/553/" + hash + ".webp"
	if u != want {
		t.Fatalf("got %s want %s", u, want)
	}
	thumb, err := c.ThumbnailURL(hash, domain.FormatWebP, domain.ThumbSmall)
	if err != nil {
		t.Fatal(err)
	}
	wantThumb := "https://tn.gold-usergeneratedcontent.net/webpsmalltn/2/29/" + hash + ".webp"
	if thumb != wantThumb {
		t.Fatalf("got %s want %s", thumb, wantThumb)
	}
}
