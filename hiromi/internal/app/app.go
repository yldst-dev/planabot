package app

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"hiromi/internal/infra/hitomi"
	"hiromi/internal/infra/httpapi"
	"hiromi/internal/infra/localfs"
	"hiromi/internal/infra/viewer"
	"hiromi/internal/usecase"
)

func Run(args []string) error {
	if len(args) > 0 && args[0] == "download" {
		return RunDownload(args[1:])
	}
	if len(args) > 0 && args[0] == "bot" {
		return RunBot()
	}
	if len(args) > 0 && args[0] == "share" {
		return RunShare(args[1:])
	}
	cfg := LoadConfig()
	client := hitomi.New(cfg.Hitomi)
	dlClient := hitomi.New(cfg.DownloadHTTP)
	store, err := localfs.New(cfg.DownloadDir)
	if err != nil {
		return err
	}
	galleries := usecase.NewGalleryService(client, client, client)
	tags := usecase.NewTagService(client)
	media := usecase.NewMediaService(client, client, client, cfg.Hitomi.Front)
	catalog := usecase.NewCatalogService()
	downloads := usecase.NewDownloadService(dlClient, dlClient, dlClient, store, cfg.Hitomi.Front).WithViewer(viewer.New())
	handler := httpapi.NewHandler(cfg.Hitomi.Front, galleries, tags, media, catalog, downloads)
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.NewMux(handler),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("hiromi listening on %s", cfg.Addr)
		errCh <- srv.ListenAndServe()
	}()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case sig := <-sigCh:
		log.Printf("shutdown signal %s", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(ctx)
	}
}
