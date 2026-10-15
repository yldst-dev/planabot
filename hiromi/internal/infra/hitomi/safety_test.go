package hitomi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hiromi/internal/domain"
)

func TestRedirectPolicyAllowsOnlyExpectedHTTPSHosts(t *testing.T) {
	policy := redirectPolicy(DefaultConfig())
	cases := map[string]bool{
		"https://ltn.gold-usergeneratedcontent.net/galleries/1.js": true,
		"https://w1.gold-usergeneratedcontent.net/a/b.webp":        true,
		"https://hitomi.la/reader/1.html":                          true,
		"http://w1.gold-usergeneratedcontent.net/a/b.webp":         false,
		"https://192.168.0.6:18080/":                               false,
		"https://evilgold-usergeneratedcontent.net/x":              false,
		"https://169.254.169.254/latest/meta-data":                 false,
	}
	for raw, allowed := range cases {
		req, err := http.NewRequest(http.MethodGet, raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := policy(req, nil) == nil; got != allowed {
			t.Fatalf("%s allowed=%v", raw, got)
		}
	}
}

func TestGetByIDRejectsADifferentGallery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`var galleryinfo = {"id":"222222","title":"t","type":"manga","files":[]}`))
	}))
	defer srv.Close()
	c := New(Config{LTN: srv.URL, HTTPClient: srv.Client()})
	_, err := c.GetByID(context.Background(), 111111)
	if !errors.Is(err, domain.ErrRemote) || !strings.Contains(err.Error(), "mismatch") {
		t.Fatalf("err %v", err)
	}
}
