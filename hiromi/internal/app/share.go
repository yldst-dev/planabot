package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"hiromi/internal/domain"
	"hiromi/internal/infra/hitomi"
	"hiromi/internal/infra/jobstore"
	"hiromi/internal/infra/localfs"
	"hiromi/internal/infra/sendshare"
	"hiromi/internal/infra/viewer"
	"hiromi/internal/usecase"
)

type shareOutput struct {
	Ok        bool   `json:"ok"`
	Token     string `json:"token,omitempty"`
	GalleryID uint64 `json:"gallery_id,omitempty"`
	Title     string `json:"title,omitempty"`
	Pages     int    `json:"pages,omitempty"`
	URL       string `json:"url,omitempty"`
	Path      string `json:"path,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Error     string `json:"error,omitempty"`
}

func RunShare(args []string) error {
	if len(args) != 1 {
		return writeShareErr(fmt.Errorf("%w: 품번이 필요합니다", domain.ErrInvalidID))
	}
	id, err := domain.ParseGalleryID(args[0])
	if err != nil {
		return writeShareErr(err)
	}
	cfg := LoadConfig()
	store, err := localfs.New(cfg.DownloadDir)
	if err != nil {
		return writeShareErr(err)
	}
	hit := hitomi.New(cfg.Hitomi)
	dl := hitomi.New(cfg.DownloadHTTP)
	galleries := usecase.NewGalleryService(hit, hit, hit)
	downloads := usecase.NewDownloadService(dl, dl, dl, store, cfg.Hitomi.Front).WithViewer(viewer.New())
	uploader, err := sendshare.New(cfg.SendHost)
	if err != nil {
		return writeShareErr(err)
	}
	shares := usecase.NewShareService(galleries, downloads, uploader, store, jobstore.NewMemory())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	share, err := shares.Deliver(ctx, id)
	if err != nil {
		return writeShareErr(err)
	}
	return json.NewEncoder(os.Stdout).Encode(shareOutput{
		Ok:        true,
		Token:     share.Token,
		GalleryID: share.GalleryID,
		Title:     share.Title,
		Pages:     share.Pages,
		URL:       share.URL,
		Path:      share.Path,
		Size:      share.Size,
	})
}

func writeShareErr(err error) error {
	_ = json.NewEncoder(os.Stdout).Encode(shareOutput{Ok: false, Error: err.Error()})
	return err
}
