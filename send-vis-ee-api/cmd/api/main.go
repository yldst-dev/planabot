package main

import (
	"log"
	"net/http"
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/config"
	rest "github.com/yldst-dev/send.vis.ee-api/internal/delivery/http"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/history"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/sendhost"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

func main() {
	cfg := config.FromEnv()
	host, err := sendhost.New(cfg.Host, sendhost.WithUserAgent(cfg.UserAgent))
	if err != nil {
		log.Fatalf("host: %v", err)
	}
	store, err := history.OpenJSON(cfg.HistoryPath)
	if err != nil {
		log.Fatalf("history: %v", err)
	}
	svc := usecase.New(host, store)
	handler := rest.NewHandler(svc, host.Host())
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           rest.NewRouter(handler, cfg.APIKey),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("send.vis.ee unofficial api listening on %s (host %s, history %s)", cfg.Listen, host.Host(), cfg.HistoryPath)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
