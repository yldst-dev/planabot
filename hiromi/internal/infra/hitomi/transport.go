package hitomi

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"strings"
	"time"
)

func newHTTPClient(timeout time.Duration, disableSNI bool) *http.Client {
	dialer := &net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}
	gold := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          64,
		MaxConnsPerHost:       4,
		MaxIdleConnsPerHost:   2,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	if !disableSNI {
		return &http.Client{Transport: gold, Timeout: timeout}
	}
	front := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        32,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupHost(ctx, host)
			if err != nil {
				return nil, err
			}
			if len(ips) == 0 {
				return nil, &net.DNSError{Err: "no records", Name: host, IsNotFound: true}
			}
			raw, err := dialer.DialContext(ctx, network, net.JoinHostPort(ips[0], port))
			if err != nil {
				return nil, err
			}
			cfg := &tls.Config{
				InsecureSkipVerify: true,
				MinVersion:         tls.VersionTLS12,
				NextProtos:         []string{"h2", "http/1.1"},
			}
			c := tls.Client(raw, cfg)
			if err := c.HandshakeContext(ctx); err != nil {
				_ = raw.Close()
				return nil, err
			}
			return c, nil
		},
	}
	return &http.Client{
		Transport: &hostSwitch{gold: gold, front: front},
		Timeout:   timeout,
	}
}

type hostSwitch struct {
	gold  http.RoundTripper
	front http.RoundTripper
}

func (h *hostSwitch) RoundTrip(req *http.Request) (*http.Response, error) {
	if needsEmptySNI(req.URL.Hostname()) {
		return h.front.RoundTrip(req)
	}
	return h.gold.RoundTrip(req)
}

func needsEmptySNI(host string) bool {
	host = strings.ToLower(host)
	return host == "hitomi.la" || strings.HasSuffix(host, ".hitomi.la")
}
