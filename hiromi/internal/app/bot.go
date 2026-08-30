package app

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"hiromi/internal/infra/hitomi"
	"hiromi/internal/infra/jobstore"
	"hiromi/internal/infra/localfs"
	"hiromi/internal/infra/sendshare"
	"hiromi/internal/infra/telegram"
	"hiromi/internal/infra/viewer"
	"hiromi/internal/usecase"
)

func RunBot() error {
	cfg := LoadConfig()
	if cfg.TelegramToken == "" {
		return fmt.Errorf("TELEGRAM_BOT_TOKEN is required")
	}
	store, err := localfs.New(cfg.DownloadDir)
	if err != nil {
		return err
	}
	hit := hitomi.New(cfg.Hitomi)
	dl := hitomi.New(cfg.DownloadHTTP)
	galleries := usecase.NewGalleryService(hit, hit, hit)
	downloads := usecase.NewDownloadService(dl, dl, dl, store, cfg.Hitomi.Front).WithViewer(viewer.New())
	uploader, err := sendshare.New(cfg.SendHost)
	if err != nil {
		return err
	}
	shares := usecase.NewShareService(galleries, downloads, uploader, store, jobstore.NewMemory())
	bot := telegram.NewBot(telegram.NewAPI(cfg.TelegramToken), shares)
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return bot.Run(ctx)
}
