package hitomi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"hiromi/internal/domain"
)

func emptyNode() []byte {
	return make([]byte, 8+17*8)
}

func TestIndexNodesAreFetchedOncePerVersionAndAddress(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write(emptyNode())
	}))
	defer srv.Close()
	c := New(Config{LTN: srv.URL, HTTPClient: srv.Client()})
	ctx := context.Background()
	for range 3 {
		if _, err := c.nodeAt(ctx, "galleries", "100", 0); err != nil {
			t.Fatal(err)
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("requests %d", got)
	}
	if _, err := c.nodeAt(ctx, "galleries", "101", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := c.nodeAt(ctx, "galleries", "100", 464); err != nil {
		t.Fatal(err)
	}
	if got := hits.Load(); got != 3 {
		t.Fatalf("requests %d", got)
	}
}

func TestIndexNodeCacheDoesNotKeepFailures(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "gone", http.StatusNotFound)
			return
		}
		_, _ = w.Write(emptyNode())
	}))
	defer srv.Close()
	c := New(Config{LTN: srv.URL, HTTPClient: srv.Client()})
	if _, err := c.nodeAt(context.Background(), "galleries", "100", 0); err == nil {
		t.Fatal("expected error")
	}
	fail.Store(false)
	n, err := c.nodeAt(context.Background(), "galleries", "100", 0)
	if err != nil || n == nil {
		t.Fatalf("%v %v", n, err)
	}
}

func TestRoutingRefreshDoesNotBlockIndexVersion(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var ggHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/gg.js" {
			if ggHits.Add(1) == 1 {
				close(started)
			}
			<-release
			_, _ = w.Write([]byte(sampleGG))
			return
		}
		_, _ = w.Write([]byte("100"))
	}))
	defer srv.Close()
	c := New(Config{LTN: srv.URL, HTTPClient: srv.Client()})

	var wg sync.WaitGroup
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.routing(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	<-started

	done := make(chan error, 1)
	go func() {
		_, err := c.indexVersion(context.Background(), "galleries")
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("indexVersion waited for the gg.js refresh")
	}
	close(release)
	wg.Wait()
	if got := ggHits.Load(); got != 1 {
		t.Fatalf("gg.js fetched %d times", got)
	}
}

func TestRoutingKeepsServingTheStaleCopyWhenARefreshFails(t *testing.T) {
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(sampleGG))
	}))
	defer srv.Close()
	c := New(Config{LTN: srv.URL, HTTPClient: srv.Client(), GGTTL: time.Millisecond})
	first, err := c.routing(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	fail.Store(true)
	time.Sleep(5 * time.Millisecond)
	again, err := c.routing(context.Background())
	if err != nil || again != first {
		t.Fatalf("%v %v", again, err)
	}
}

func TestOversizedResponseIsAnErrorAndIsNotRetried(t *testing.T) {
	maxBodyBytes = 16
	defer func() { maxBodyBytes = 32 << 20 }()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(strings.Repeat("x", 17)))
	}))
	defer srv.Close()
	c := New(Config{LTN: srv.URL, HTTPClient: srv.Client()})
	_, _, _, err := c.getBytes(context.Background(), srv.URL+"/n/index-all.nozomi", "", "")
	if !errors.Is(err, domain.ErrTooLarge) || !errors.Is(err, domain.ErrRemote) {
		t.Fatalf("err %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("requests %d", got)
	}
}

func TestResponseAtTheLimitIsAccepted(t *testing.T) {
	maxBodyBytes = 16
	defer func() { maxBodyBytes = 32 << 20 }()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 16)))
	}))
	defer srv.Close()
	c := New(Config{LTN: srv.URL, HTTPClient: srv.Client()})
	body, _, _, err := c.getBytes(context.Background(), srv.URL+"/n/index-all.nozomi", "", "")
	if err != nil || len(body) != 16 {
		t.Fatalf("%d %v", len(body), err)
	}
}

func TestTagSearchEscapesEveryCharacterInThePath(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.RequestURI
		_, _ = w.Write([]byte("[]"))
	}))
	defer srv.Close()
	c := New(Config{TagIndex: srv.URL, HTTPClient: srv.Client()})
	if _, err := c.Search(context.Background(), "a?b#c%d e.f/g"); err != nil {
		t.Fatal(err)
	}
	want := "/global/a/%3F/b/%23/c/%25/d/%20/e/dot/f/slash/g.json"
	if got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}
