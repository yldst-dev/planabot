package sendhost

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	scrypto "github.com/yldst-dev/send.vis.ee-api/internal/infra/crypto"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

type memFile struct {
	cipher []byte
	meta   string
	auth   []byte
	owner  string
	nonce  []byte
	dlimit int
	dl     int
	pwd    bool
}

type fakeSend struct {
	mu    sync.Mutex
	files map[string]*memFile
}

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func newFakeSend() *httptest.Server {
	s := &fakeSend{files: map[string]*memFile{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/__version__", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"version": "v3.4.27", "commit": "test", "source": "fake"})
	})
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"LIMITS": map[string]any{
				"MAX_FILE_SIZE":      2684354560,
				"MAX_DOWNLOADS":      20,
				"MAX_EXPIRE_SECONDS": 259200,
			},
			"DEFAULTS": map[string]any{
				"DOWNLOADS":            1,
				"DOWNLOAD_COUNTS":      []int{1, 2, 3, 5, 10, 20},
				"EXPIRE_TIMES_SECONDS": []int{300, 3600, 86400, 259200},
				"EXPIRE_SECONDS":       86400,
			},
		})
	})
	mux.HandleFunc("/api/ws", s.handleWS)
	mux.HandleFunc("/api/exists/", s.handleExists)
	mux.HandleFunc("/api/metadata/", s.handleMetadata)
	mux.HandleFunc("/api/download/", s.handleDownload)
	mux.HandleFunc("/api/info/", s.handleInfo)
	mux.HandleFunc("/api/delete/", s.handleDelete)
	mux.HandleFunc("/api/password/", s.handlePassword)
	mux.HandleFunc("/api/params/", s.handleParams)
	return httptest.NewServer(mux)
}

func (s *fakeSend) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return
	}
	var info struct {
		FileMetadata  string `json:"fileMetadata"`
		Authorization string `json:"authorization"`
		TimeLimit     int    `json:"timeLimit"`
		DLimit        int    `json:"dlimit"`
	}
	if err := json.Unmarshal(msg, &info); err != nil {
		_ = conn.WriteJSON(map[string]int{"error": 400})
		return
	}
	auth := strings.TrimPrefix(info.Authorization, "send-v1 ")
	authKey, _ := scrypto.Decode(auth)
	id := "0123456789abcdef"
	owner := "ownertoken01"
	nonce := bytes.Repeat([]byte{0x11}, 16)
	if err := conn.WriteJSON(map[string]string{
		"id":         id,
		"url":        "http://example/download/" + id + "/",
		"ownerToken": owner,
	}); err != nil {
		return
	}
	var blob bytes.Buffer
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if len(data) == 1 && data[0] == 0 {
			break
		}
		blob.Write(data)
	}
	s.mu.Lock()
	s.files[id] = &memFile{
		cipher: blob.Bytes(),
		meta:   info.FileMetadata,
		auth:   authKey,
		owner:  owner,
		nonce:  nonce,
		dlimit: info.DLimit,
	}
	s.mu.Unlock()
	_ = conn.WriteJSON(map[string]bool{"ok": true})
}

func (s *fakeSend) file(id string) *memFile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.files[id]
}

func (s *fakeSend) handleExists(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/exists/")
	f := s.file(id)
	if f == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("WWW-Authenticate", "send-v1 "+base64.StdEncoding.EncodeToString(f.nonce))
	_ = json.NewEncoder(w).Encode(map[string]bool{"requiresPassword": f.pwd})
}

func hmacOK(f *memFile, header string) bool {
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 {
		return false
	}
	sig, err := scrypto.Decode(parts[1])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, f.auth)
	mac.Write(f.nonce)
	return hmac.Equal(mac.Sum(nil), sig)
}

func (s *fakeSend) authorize(w http.ResponseWriter, r *http.Request, prefix string) (*memFile, bool) {
	id := strings.TrimPrefix(r.URL.Path, prefix)
	f := s.file(id)
	if f == nil {
		w.WriteHeader(http.StatusNotFound)
		return nil, false
	}
	ok := hmacOK(f, r.Header.Get("Authorization"))
	next := bytes.Repeat([]byte{0x22}, 16)
	w.Header().Set("WWW-Authenticate", "send-v1 "+base64.StdEncoding.EncodeToString(next))
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		return nil, false
	}
	s.mu.Lock()
	f.nonce = next
	s.mu.Unlock()
	return f, true
}

func (s *fakeSend) handleMetadata(w http.ResponseWriter, r *http.Request) {
	f, ok := s.authorize(w, r, "/api/metadata/")
	if !ok {
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"metadata":      f.meta,
		"finalDownload": false,
		"ttl":           3600000,
	})
}

func (s *fakeSend) handleDownload(w http.ResponseWriter, r *http.Request) {
	f, ok := s.authorize(w, r, "/api/download/")
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(f.cipher)
}

func (s *fakeSend) owner(w http.ResponseWriter, r *http.Request, prefix string) (*memFile, map[string]any, bool) {
	id := strings.TrimPrefix(r.URL.Path, prefix)
	f := s.file(id)
	if f == nil {
		w.WriteHeader(http.StatusNotFound)
		return nil, nil, false
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	token, _ := body["owner_token"].(string)
	if token != f.owner {
		w.WriteHeader(http.StatusUnauthorized)
		return nil, nil, false
	}
	return f, body, true
}

func (s *fakeSend) handleInfo(w http.ResponseWriter, r *http.Request) {
	f, _, ok := s.owner(w, r, "/api/info/")
	if !ok {
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"dlimit": f.dlimit, "dtotal": f.dl, "ttl": 3600000})
}

func (s *fakeSend) handleDelete(w http.ResponseWriter, r *http.Request) {
	_, _, ok := s.owner(w, r, "/api/delete/")
	if !ok {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/delete/")
	s.mu.Lock()
	delete(s.files, id)
	s.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (s *fakeSend) handlePassword(w http.ResponseWriter, r *http.Request) {
	f, body, ok := s.owner(w, r, "/api/password/")
	if !ok {
		return
	}
	auth, _ := body["auth"].(string)
	key, _ := scrypto.Decode(auth)
	s.mu.Lock()
	f.auth = key
	f.pwd = true
	s.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (s *fakeSend) handleParams(w http.ResponseWriter, r *http.Request) {
	f, body, ok := s.owner(w, r, "/api/params/")
	if !ok {
		return
	}
	if n, ok := body["dlimit"].(float64); ok {
		s.mu.Lock()
		f.dlimit = int(n)
		s.mu.Unlock()
	}
	w.WriteHeader(http.StatusOK)
}

func TestProtocolUploadDownload(t *testing.T) {
	srv := newFakeSend()
	defer srv.Close()
	c, err := New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("send vis ee unofficial api")
	file, err := c.Upload(context.Background(), usecase.UploadRequest{
		Name:      "note.txt",
		MIME:      "text/plain",
		Size:      int64(len(plain)),
		Body:      bytes.NewReader(plain),
		Downloads: 5,
		ExpireSec: 3600,
	})
	if err != nil {
		t.Fatal(err)
	}
	if file.ID != "0123456789abcdef" {
		t.Fatalf("id %s", file.ID)
	}
	secret, err := scrypto.Decode(file.Secret)
	if err != nil {
		t.Fatal(err)
	}
	ex, err := c.Exists(context.Background(), file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ex.RequiresPassword {
		t.Fatal("password")
	}
	meta, err := c.Metadata(context.Background(), file.ID, secret, "", file.URL)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "note.txt" || meta.Size != int64(len(plain)) {
		t.Fatalf("%+v", meta)
	}
	rc, err := c.Download(context.Background(), file.ID, secret, "", file.URL)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("got %q", got)
	}
	info, err := c.OwnerInfo(context.Background(), file.ID, file.OwnerToken)
	if err != nil {
		t.Fatal(err)
	}
	if info.DownloadLimit != 5 {
		t.Fatalf("%+v", info)
	}
	if err := c.SetDownloadLimit(context.Background(), file.ID, file.OwnerToken, 10); err != nil {
		t.Fatal(err)
	}
	if err := c.SetPassword(context.Background(), file.ID, file.OwnerToken, secret, "pw", file.URL); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Metadata(context.Background(), file.ID, secret, "", file.URL); err != domain.ErrUnauthorized {
		t.Fatalf("want unauthorized got %v", err)
	}
	meta, err = c.Metadata(context.Background(), file.ID, secret, "pw", file.URL)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "note.txt" {
		t.Fatal(meta.Name)
	}
	if err := c.Delete(context.Background(), file.ID, file.OwnerToken); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exists(context.Background(), file.ID); err != domain.ErrNotFound {
		t.Fatalf("deleted: %v", err)
	}
}

func TestInstance(t *testing.T) {
	srv := newFakeSend()
	defer srv.Close()
	c, err := New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	inst, err := c.Instance(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if inst.Version != "v3.4.27" || inst.Limits.MaxDownloads != 20 {
		t.Fatalf("%+v", inst)
	}
}

func TestNormalizeHost(t *testing.T) {
	h, err := domain.NormalizeHost("https://send.vis.ee/")
	if err != nil || h != "https://send.vis.ee" {
		t.Fatalf("%s %v", h, err)
	}
}
