package usecase

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"path"
	"path/filepath"
	"sync"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type SharePreview struct {
	ID       uint64
	Title    string
	Type     domain.GalleryType
	Language string
	Pages    int
}

type Share struct {
	Token     string
	GalleryID uint64
	Title     string
	Pages     int
	URL       string
	Path      string
	Size      int64
}

type ShareService struct {
	galleries     *GalleryService
	downloads     *DownloadService
	uploader      port.ShareUploader
	store         port.FileStore
	claims        port.ClaimStore
	busy          sync.Map
	telegramLimit int64
}

func NewShareService(g *GalleryService, d *DownloadService, u port.ShareUploader, store port.FileStore, claims port.ClaimStore) *ShareService {
	return &ShareService{
		galleries:     g,
		downloads:     d,
		uploader:      u,
		store:         store,
		claims:        claims,
		telegramLimit: domain.TelegramDirectMaxBytes,
	}
}

func (s *ShareService) Preview(ctx context.Context, id uint64) (*SharePreview, error) {
	g, err := s.galleries.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	lang := ""
	if g.Language != nil {
		lang = g.Language.Name
	}
	return &SharePreview{
		ID:       g.ID,
		Title:    g.Title,
		Type:     g.Type,
		Language: lang,
		Pages:    g.PageCount(),
	}, nil
}

func (s *ShareService) Deliver(ctx context.Context, id uint64) (*Share, error) {
	if id == 0 {
		return nil, domain.ErrInvalidID
	}
	if _, loaded := s.busy.LoadOrStore(id, struct{}{}); loaded {
		return nil, domain.ErrBusy
	}
	defer s.busy.Delete(id)
	dir := domain.GalleryDirName(id)
	_ = s.store.RemoveAll(dir)
	defer s.store.RemoveAll(dir)
	opt := domain.DefaultDownloadOptions()
	opt.SkipExisting = false
	opt.IncludeVideo = false
	res, err := s.downloads.Download(ctx, id, opt)
	if err != nil {
		return nil, err
	}
	rel := path.Join(dir, domain.ViewerFileName)
	html, err := s.store.Read(rel)
	if err != nil || len(html) == 0 {
		return nil, domain.ErrNoViewer
	}
	token, err := newClaimToken()
	if err != nil {
		return nil, err
	}
	size := int64(len(html))
	share := &Share{
		Token:     token,
		GalleryID: res.GalleryID,
		Title:     res.Title,
		Pages:     res.PageCount,
		Size:      size,
	}
	if size <= s.telegramLimit {
		staged := path.Join("shares", token+".html")
		if _, err := s.store.Write(staged, bytes.NewReader(html)); err != nil {
			return nil, err
		}
		share.Path = filepath.Join(s.store.Root(), filepath.FromSlash(staged))
	} else {
		up, err := s.uploader.Upload(ctx, domain.ViewerFileName, size, bytes.NewReader(html))
		if err != nil {
			return nil, err
		}
		share.URL = up.URL
		if up.Size > 0 {
			share.Size = up.Size
		}
	}
	if err := s.claims.Put(port.ShareClaim{
		Token:     token,
		GalleryID: share.GalleryID,
		Title:     share.Title,
		URL:       share.URL,
		Path:      share.Path,
		Size:      share.Size,
		Pages:     share.Pages,
	}); err != nil {
		return nil, err
	}
	return share, nil
}

func (s *ShareService) Claim(token string) (*Share, error) {
	c, err := s.claims.Get(token)
	if err != nil {
		return nil, err
	}
	return &Share{
		Token:     c.Token,
		GalleryID: c.GalleryID,
		Title:     c.Title,
		Pages:     c.Pages,
		URL:       c.URL,
		Path:      c.Path,
		Size:      c.Size,
	}, nil
}

func newClaimToken() (string, error) {
	var b [16]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
