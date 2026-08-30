package sendhost

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	scrypto "github.com/yldst-dev/send.vis.ee-api/internal/infra/crypto"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

const defaultUA = "sendvis-unofficial/1.0"

type Client struct {
	base   string
	http   *http.Client
	dialer *websocket.Dialer
	ua     string
	origin string
	nonces sync.Map
}

type Option func(*Client)

func WithHTTPClient(c *http.Client) Option {
	return func(cl *Client) { cl.http = c }
}

func WithUserAgent(ua string) Option {
	return func(cl *Client) { cl.ua = ua }
}

func WithDialer(d *websocket.Dialer) Option {
	return func(cl *Client) { cl.dialer = d }
}

func New(host string, opts ...Option) (*Client, error) {
	normalized, err := domain.NormalizeHost(host)
	if err != nil {
		return nil, err
	}
	origin := normalized
	c := &Client{
		base:   normalized,
		http:   &http.Client{Timeout: 0},
		ua:     defaultUA,
		origin: origin,
		dialer: &websocket.Dialer{
			Proxy:             http.ProxyFromEnvironment,
			HandshakeTimeout:  30 * time.Second,
			EnableCompression: false,
			WriteBufferSize:   70 * 1024,
			ReadBufferSize:    70 * 1024,
		},
	}
	for _, opt := range opts {
		opt(c)
	}
	if c.http == nil {
		c.http = &http.Client{Timeout: 0}
	}
	if c.dialer == nil {
		c.dialer = websocket.DefaultDialer
	}
	if t, ok := c.http.Transport.(*http.Transport); ok && t != nil {
		c.dialer.TLSClientConfig = t.TLSClientConfig
	}
	return c, nil
}

func (c *Client) Host() string {
	return c.base
}

func (c *Client) Instance(ctx context.Context) (usecase.Instance, error) {
	var ver struct {
		Commit  string `json:"commit"`
		Source  string `json:"source"`
		Version string `json:"version"`
	}
	if err := c.getJSON(ctx, "/__version__", &ver); err != nil {
		return usecase.Instance{}, err
	}
	var cfg struct {
		Limits struct {
			MaxFileSize        int64 `json:"MAX_FILE_SIZE"`
			MaxDownloads       int   `json:"MAX_DOWNLOADS"`
			MaxExpireSeconds   int   `json:"MAX_EXPIRE_SECONDS"`
			MaxFilesPerArchive int   `json:"MAX_FILES_PER_ARCHIVE"`
		} `json:"LIMITS"`
		Defaults struct {
			Downloads          int   `json:"DOWNLOADS"`
			DownloadCounts     []int `json:"DOWNLOAD_COUNTS"`
			ExpireTimesSeconds []int `json:"EXPIRE_TIMES_SECONDS"`
			ExpireSeconds      int   `json:"EXPIRE_SECONDS"`
		} `json:"DEFAULTS"`
	}
	if err := c.getJSON(ctx, "/config", &cfg); err != nil {
		return usecase.Instance{}, err
	}
	limits := domain.Limits{
		MaxFileSize:      cfg.Limits.MaxFileSize,
		MaxDownloads:     cfg.Limits.MaxDownloads,
		MaxExpireSeconds: cfg.Limits.MaxExpireSeconds,
		DownloadCounts:   cfg.Defaults.DownloadCounts,
		ExpireSeconds:    cfg.Defaults.ExpireTimesSeconds,
		DefaultDownloads: cfg.Defaults.Downloads,
		DefaultExpire:    cfg.Defaults.ExpireSeconds,
	}.WithDefaults()
	return usecase.Instance{
		Version: ver.Version,
		Commit:  ver.Commit,
		Source:  ver.Source,
		Limits:  limits,
	}, nil
}

func (c *Client) Upload(ctx context.Context, req usecase.UploadRequest) (*domain.ManagedFile, error) {
	kc, err := scrypto.Generate()
	if err != nil {
		return nil, err
	}
	manifest, err := json.Marshal(domain.SingleManifest(req.Name, req.Size, req.MIME))
	if err != nil {
		return nil, err
	}
	metaCT, err := kc.EncryptMetadata(scrypto.Metadata{
		Name:     req.Name,
		Size:     req.Size,
		Type:     req.MIME,
		Manifest: manifest,
	})
	if err != nil {
		return nil, err
	}
	wsURL, err := domain.WebSocketURL(c.base)
	if err != nil {
		return nil, err
	}
	header := http.Header{}
	header.Set("Origin", c.origin)
	header.Set("User-Agent", c.ua)
	conn, _, err := c.dialer.DialContext(ctx, wsURL, header)
	if err != nil {
		return nil, fmt.Errorf("websocket dial: %w", err)
	}
	defer conn.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()

	fileInfo := map[string]any{
		"fileMetadata":  scrypto.Encode(metaCT),
		"authorization": "send-v1 " + kc.AuthKeyEncoded(),
		"timeLimit":     req.ExpireSec,
		"dlimit":        req.Downloads,
	}
	if err := conn.WriteJSON(fileInfo); err != nil {
		return nil, fmt.Errorf("file info: %w", err)
	}
	var handshake wsResponse
	if err := readWSJSON(conn, &handshake); err != nil {
		return nil, fmt.Errorf("upload handshake: %w", err)
	}
	if handshake.Error != 0 {
		return nil, mapStatus(handshake.Error)
	}
	if handshake.ID == "" || handshake.OwnerToken == "" {
		return nil, fmt.Errorf("%w: missing upload credentials", domain.ErrHost)
	}

	type result struct {
		resp wsResponse
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		var resp wsResponse
		err := readWSJSON(conn, &resp)
		resCh <- result{resp: resp, err: err}
	}()

	if err := scrypto.EncryptEach(req.Body, kc.Secret(), func(p []byte) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return conn.WriteMessage(websocket.BinaryMessage, p)
	}); err != nil {
		return nil, fmt.Errorf("encrypt upload: %w", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte{0}); err != nil {
		return nil, fmt.Errorf("eof: %w", err)
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-resCh:
		if r.err != nil {
			return nil, fmt.Errorf("upload complete: %w", r.err)
		}
		if r.resp.Error != 0 {
			return nil, mapStatus(r.resp.Error)
		}
		if !r.resp.OK {
			return nil, fmt.Errorf("%w: upload not confirmed", domain.ErrHost)
		}
	}

	now := time.Now()
	secret := kc.SecretEncoded()
	file := &domain.ManagedFile{
		ID:            handshake.ID,
		Host:          c.base,
		URL:           domain.BuildShareURL(c.base, handshake.ID, secret),
		DownloadURL:   strings.TrimRight(handshake.URL, "/") + "/",
		Name:          req.Name,
		Size:          req.Size,
		MIME:          req.MIME,
		Secret:        secret,
		OwnerToken:    handshake.OwnerToken,
		DownloadMax:   req.Downloads,
		Manifest:      domain.SingleManifest(req.Name, req.Size, req.MIME),
		ExpireSeconds: req.ExpireSec,
		CreatedAt:     now,
		ExpiresAt:     now.Add(time.Duration(req.ExpireSec) * time.Second),
	}
	if file.DownloadURL == "/" {
		file.DownloadURL = domain.BuildDownloadURL(c.base, handshake.ID)
	}
	return file, nil
}

type wsResponse struct {
	URL        string `json:"url"`
	OwnerToken string `json:"ownerToken"`
	ID         string `json:"id"`
	OK         bool   `json:"ok"`
	Error      int    `json:"error"`
}

func readWSJSON(conn *websocket.Conn, dest any) error {
	_, data, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dest)
}

func (c *Client) Download(ctx context.Context, id string, secret []byte, password, shareURL string) (io.ReadCloser, error) {
	kc, err := authKeychain(secret, password, shareURL)
	if err != nil {
		return nil, err
	}
	resp, err := c.doHMAC(ctx, http.MethodGet, "/api/download/"+id, kc, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, mapStatus(resp.StatusCode)
	}
	plain := scrypto.Decrypt(resp.Body, secret)
	return &downloadCloser{ReadCloser: plain, raw: resp.Body}, nil
}

type downloadCloser struct {
	io.ReadCloser
	raw io.Closer
}

func (d *downloadCloser) Close() error {
	_ = d.ReadCloser.Close()
	return d.raw.Close()
}

func (c *Client) Metadata(ctx context.Context, id string, secret []byte, password, shareURL string) (*usecase.RemoteMetadata, error) {
	kc, err := authKeychain(secret, password, shareURL)
	if err != nil {
		return nil, err
	}
	resp, err := c.doHMAC(ctx, http.MethodGet, "/api/metadata/"+id, kc, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, mapStatus(resp.StatusCode)
	}
	var payload struct {
		Metadata      string `json:"metadata"`
		FinalDownload bool   `json:"finalDownload"`
		TTL           int64  `json:"ttl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	raw, err := scrypto.Decode(payload.Metadata)
	if err != nil {
		return nil, err
	}
	meta, err := kc.DecryptMetadata(raw)
	if err != nil {
		return nil, err
	}
	out := &usecase.RemoteMetadata{
		Name:          meta.Name,
		Size:          meta.Size,
		MIME:          meta.Type,
		TTLMillis:     payload.TTL,
		FinalDownload: payload.FinalDownload,
	}
	if len(meta.Manifest) > 0 {
		_ = json.Unmarshal(meta.Manifest, &out.Manifest)
	}
	return out, nil
}

func (c *Client) OwnerInfo(ctx context.Context, id, ownerToken string) (*usecase.OwnerInfo, error) {
	var payload struct {
		DLimit int   `json:"dlimit"`
		DTotal int   `json:"dtotal"`
		TTL    int64 `json:"ttl"`
	}
	if err := c.postOwner(ctx, "/api/info/"+id, ownerToken, nil, &payload); err != nil {
		return nil, err
	}
	return &usecase.OwnerInfo{
		DownloadLimit: payload.DLimit,
		DownloadCount: payload.DTotal,
		TTLMillis:     payload.TTL,
	}, nil
}

func (c *Client) Delete(ctx context.Context, id, ownerToken string) error {
	return c.postOwner(ctx, "/api/delete/"+id, ownerToken, nil, nil)
}

func (c *Client) SetPassword(ctx context.Context, id, ownerToken string, secret []byte, password, shareURL string) error {
	kc, err := authKeychain(secret, password, shareURL)
	if err != nil {
		return err
	}
	body := map[string]any{"auth": kc.AuthKeyEncoded()}
	return c.postOwner(ctx, "/api/password/"+id, ownerToken, body, nil)
}

func (c *Client) SetDownloadLimit(ctx context.Context, id, ownerToken string, limit int) error {
	body := map[string]any{"dlimit": limit}
	return c.postOwner(ctx, "/api/params/"+id, ownerToken, body, nil)
}

func (c *Client) Exists(ctx context.Context, id string) (*usecase.ExistsResult, error) {
	resp, err := c.do(ctx, http.MethodGet, "/api/exists/"+id, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	c.rememberNonce(id, resp.Header)
	if resp.StatusCode != http.StatusOK {
		return nil, mapStatus(resp.StatusCode)
	}
	var payload struct {
		RequiresPassword bool `json:"requiresPassword"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return &usecase.ExistsResult{RequiresPassword: payload.RequiresPassword}, nil
}

func authKeychain(secret []byte, password, shareURL string) (*scrypto.Keychain, error) {
	kc, err := scrypto.FromSecret(secret)
	if err != nil {
		return nil, err
	}
	if password != "" {
		if err := kc.SetPassword(password, shareURL); err != nil {
			return nil, err
		}
	}
	return kc, nil
}

func (c *Client) doHMAC(ctx context.Context, method, path string, kc *scrypto.Keychain, body []byte) (*http.Response, error) {
	id := idFromPath(path)
	nonce, err := c.nonceFor(ctx, id)
	if err != nil {
		return nil, err
	}
	var last *http.Response
	for i := 0; i < 3; i++ {
		headers := map[string]string{
			"Authorization": kc.AuthHeader(nonce),
		}
		resp, err := c.do(ctx, method, path, headers, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		if n := nonceFrom(resp.Header); len(n) > 0 {
			c.nonces.Store(id, n)
			nonce = n
		}
		if resp.StatusCode != http.StatusUnauthorized {
			return resp, nil
		}
		if last != nil {
			last.Body.Close()
		}
		last = resp
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if len(nonce) == 0 {
			break
		}
	}
	if last != nil {
		return last, nil
	}
	return nil, domain.ErrUnauthorized
}

func (c *Client) nonceFor(ctx context.Context, id string) ([]byte, error) {
	if v, ok := c.nonces.Load(id); ok {
		if n, ok := v.([]byte); ok && len(n) > 0 {
			return n, nil
		}
	}
	resp, err := c.do(ctx, http.MethodGet, "/api/exists/"+id, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	c.rememberNonce(id, resp.Header)
	if resp.StatusCode == http.StatusNotFound {
		return nil, domain.ErrNotFound
	}
	if v, ok := c.nonces.Load(id); ok {
		if n, ok := v.([]byte); ok {
			return n, nil
		}
	}
	return nil, nil
}

func (c *Client) rememberNonce(id string, h http.Header) {
	if n := nonceFrom(h); len(n) > 0 {
		c.nonces.Store(id, n)
	}
}

func nonceFrom(h http.Header) []byte {
	v := h.Get("WWW-Authenticate")
	if v == "" {
		return nil
	}
	parts := strings.SplitN(v, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "send-v1") {
		return nil
	}
	b, err := scrypto.DecodeNonce(parts[1])
	if err != nil {
		return nil
	}
	return b
}

func (c *Client) postOwner(ctx context.Context, path, ownerToken string, extra map[string]any, dest any) error {
	payload := map[string]any{"owner_token": ownerToken}
	for k, v := range extra {
		payload[k] = v
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := c.do(ctx, http.MethodPost, path, map[string]string{"Content-Type": "application/json"}, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return mapStatus(resp.StatusCode)
	}
	if dest == nil {
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(dest)
}

func (c *Client) getJSON(ctx context.Context, path string, dest any) error {
	resp, err := c.do(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return mapStatus(resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dest)
}

func (c *Client) do(ctx context.Context, method, path string, headers map[string]string, body io.Reader) (*http.Response, error) {
	u, err := url.JoinPath(c.base, path)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.ua)
	req.Header.Set("Accept", "application/json, application/octet-stream;q=0.9, */*;q=0.8")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return c.http.Do(req)
}

func idFromPath(path string) string {
	path = strings.Trim(path, "/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func mapStatus(code int) error {
	switch code {
	case http.StatusNotFound:
		return domain.ErrNotFound
	case http.StatusUnauthorized:
		return domain.ErrUnauthorized
	case http.StatusRequestEntityTooLarge:
		return domain.ErrTooLarge
	case http.StatusBadRequest:
		return domain.ErrInvalidParameter
	default:
		return fmt.Errorf("%w: status %d", domain.ErrHost, code)
	}
}
