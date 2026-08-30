package hitomi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type Config struct {
	Front      string
	LTN        string
	CDN        string
	TagIndex   string
	UserAgent  string
	Timeout    time.Duration
	GGTTL      time.Duration
	IndexTTL   time.Duration
	DisableSNI bool
	HTTPClient *http.Client
}

func DefaultConfig() Config {
	return Config{
		Front:      "https://hitomi.la",
		LTN:        "https://ltn.gold-usergeneratedcontent.net",
		CDN:        "gold-usergeneratedcontent.net",
		TagIndex:   "https://tagindex.hitomi.la",
		UserAgent:  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		Timeout:    30 * time.Second,
		GGTTL:      30 * time.Minute,
		IndexTTL:   10 * time.Minute,
		DisableSNI: true,
	}
}

type Client struct {
	cfg    Config
	http   *http.Client
	mu     sync.Mutex
	gg     *routing
	ggAt   time.Time
	idxVer map[string]cachedString
}

type cachedString struct {
	value string
	at    time.Time
}

func New(cfg Config) *Client {
	def := DefaultConfig()
	if cfg.Front == "" {
		cfg.Front = def.Front
	}
	if cfg.LTN == "" {
		cfg.LTN = def.LTN
	}
	if cfg.CDN == "" {
		cfg.CDN = def.CDN
	}
	if cfg.TagIndex == "" {
		cfg.TagIndex = def.TagIndex
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = def.UserAgent
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = def.Timeout
	}
	if cfg.GGTTL <= 0 {
		cfg.GGTTL = def.GGTTL
	}
	if cfg.IndexTTL <= 0 {
		cfg.IndexTTL = def.IndexTTL
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = newHTTPClient(cfg.Timeout, cfg.DisableSNI)
	}
	return &Client{
		cfg:    cfg,
		http:   httpClient,
		idxVer: map[string]cachedString{},
	}
}

var (
	_ port.GalleryRepository = (*Client)(nil)
	_ port.ListingRepository = (*Client)(nil)
	_ port.SearchRepository  = (*Client)(nil)
	_ port.TagRepository     = (*Client)(nil)
	_ port.URLResolver       = (*Client)(nil)
	_ port.MediaFetcher      = (*Client)(nil)
)

func (c *Client) do(ctx context.Context, method, rawURL, rangeHeader, referer string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	if referer == "" {
		referer = c.cfg.Front + "/"
	}
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	req.Header.Set("Referer", referer)
	req.Header.Set("Origin", c.cfg.Front)
	req.Header.Set("Accept", "*/*")
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrRemote, err)
	}
	return resp, nil
}

func (c *Client) getBytes(ctx context.Context, rawURL, rangeHeader, referer string) ([]byte, http.Header, int, error) {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		body, header, status, err := c.getBytesOnce(ctx, rawURL, rangeHeader, referer)
		if err == nil || errors.Is(err, domain.ErrNotFound) {
			return body, header, status, err
		}
		if status >= 400 && status < 500 && status != http.StatusRequestTimeout && status != http.StatusTooManyRequests {
			return body, header, status, err
		}
		last = err
		if attempt == 2 {
			break
		}
		wait := time.Duration(attempt+1) * 250 * time.Millisecond
		if domain.StatusOf(err) == http.StatusServiceUnavailable || domain.StatusOf(err) == http.StatusTooManyRequests {
			wait = time.Duration(attempt+1) * 1500 * time.Millisecond
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, nil, 0, last
		case <-timer.C:
		}
	}
	return nil, nil, 0, last
}

func (c *Client) getBytesOnce(ctx context.Context, rawURL, rangeHeader, referer string) ([]byte, http.Header, int, error) {
	resp, err := c.do(ctx, http.MethodGet, rawURL, rangeHeader, referer)
	if err != nil {
		return nil, nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, resp.Header, resp.StatusCode, fmt.Errorf("%w: read: %v", domain.ErrRemote, err)
	}
	if resp.StatusCode == http.StatusNotFound {
		return body, resp.Header, resp.StatusCode, domain.ErrNotFound
	}
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusPartialContent {
		return body, resp.Header, resp.StatusCode, &domain.RemoteStatusError{Status: resp.StatusCode}
	}
	return body, resp.Header, resp.StatusCode, nil
}

func (c *Client) ltnURL(path string) string {
	return strings.TrimRight(c.cfg.LTN, "/") + path
}

func (c *Client) frontURL(path string) string {
	return strings.TrimRight(c.cfg.Front, "/") + path
}

func (c *Client) tagIndexURL(path string) string {
	return strings.TrimRight(c.cfg.TagIndex, "/") + path
}

func (c *Client) routing(ctx context.Context) (*routing, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gg != nil && time.Since(c.ggAt) < c.cfg.GGTTL {
		return c.gg, nil
	}
	body, _, _, err := c.getBytes(ctx, c.ltnURL("/gg.js"), "", "")
	if err != nil {
		if c.gg != nil {
			return c.gg, nil
		}
		return nil, err
	}
	r, err := parseGG(string(body))
	if err != nil {
		if c.gg != nil {
			return c.gg, nil
		}
		return nil, err
	}
	c.gg = r
	c.ggAt = time.Now()
	return r, nil
}

func (c *Client) indexVersion(ctx context.Context, name string) (string, error) {
	c.mu.Lock()
	cached, ok := c.idxVer[name]
	if ok && time.Since(cached.at) < c.cfg.IndexTTL {
		c.mu.Unlock()
		return cached.value, nil
	}
	c.mu.Unlock()
	body, _, _, err := c.getBytes(ctx, c.ltnURL("/"+name+"index/version"), "", "")
	if err != nil {
		return "", err
	}
	ver := strings.TrimSpace(string(body))
	if ver == "" {
		return "", domain.ErrEmptyIndex
	}
	c.mu.Lock()
	c.idxVer[name] = cachedString{value: ver, at: time.Now()}
	c.mu.Unlock()
	return ver, nil
}

func (c *Client) Fetch(ctx context.Context, rawURL, referer string) (io.ReadCloser, string, error) {
	resp, err := c.do(ctx, http.MethodGet, rawURL, "", referer)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode == http.StatusNotFound {
		drainAndClose(resp.Body)
		return nil, "", domain.ErrNotFound
	}
	if resp.StatusCode >= 400 {
		drainAndClose(resp.Body)
		return nil, "", &domain.RemoteStatusError{Status: resp.StatusCode}
	}
	ct := resp.Header.Get("Content-Type")
	return resp.Body, ct, nil
}

func drainAndClose(body io.ReadCloser) {
	if body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 1<<20))
	_ = body.Close()
}
