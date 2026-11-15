package hitomi

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func emptySNIServer(t *testing.T) (*httptest.Server, chan string) {
	t.Helper()
	sni := make(chan string, 8)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	srv.TLS = &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		sni <- hello.ServerName
		return nil, nil
	}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, sni
}

func serverPort(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	_, port, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func TestEmptySNIDialSendsNoServerName(t *testing.T) {
	srv, sni := emptySNIServer(t)
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := dialEmptySNI(context.Background(), dialer, "tcp", "example.com", []string{"127.0.0.1"}, serverPort(t, srv))
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if got := <-sni; got != "" {
		t.Fatalf("server saw SNI %q", got)
	}
}

func TestEmptySNIDialTriesEveryAddress(t *testing.T) {
	srv, _ := emptySNIServer(t)
	port := serverPort(t, srv)
	dialer := &net.Dialer{Timeout: 5 * time.Second}

	conn, err := dialEmptySNI(context.Background(), dialer, "tcp", "example.com", []string{"::1", "127.0.0.1"}, port)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()

	if _, err := dialEmptySNI(context.Background(), dialer, "tcp", "example.com", nil, port); err == nil {
		t.Fatal("no addresses should be an error")
	}
}

func TestEmptySNIDialWorksAsAnHTTPTransport(t *testing.T) {
	srv, _ := emptySNIServer(t)
	port := serverPort(t, srv)
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	client := &http.Client{Transport: &http.Transport{
		ForceAttemptHTTP2: true,
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialEmptySNI(ctx, dialer, network, "example.com", []string{"127.0.0.1"}, port)
		},
	}}
	resp, err := client.Get("https://example.com/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
