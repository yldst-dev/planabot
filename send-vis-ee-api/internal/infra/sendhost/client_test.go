package sendhost

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestInstanceIsCachedBetweenCalls(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/__version__":
			_, _ = w.Write([]byte(`{"version":"v3.4.27"}`))
		default:
			_, _ = w.Write([]byte(`{"LIMITS":{"MAX_DOWNLOADS":7}}`))
		}
	}))
	defer srv.Close()
	c, err := New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		inst, err := c.Instance(context.Background())
		if err != nil || inst.Limits.MaxDownloads != 7 {
			t.Fatalf("%+v %v", inst, err)
		}
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("requests %d", got)
	}
}

func TestInstanceFailureIsNotCached(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c, err := New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Instance(context.Background()); err == nil {
		t.Fatal("expected error")
	}
	fail.Store(false)
	if _, err := c.Instance(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRequestTimeoutBoundsAStalledHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()
	c, err := New(srv.URL, WithRequestTimeout(100*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := c.Exists(context.Background(), "0123456789abcdef"); err == nil {
		t.Fatal("expected error")
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("took %s", time.Since(started))
	}
}
