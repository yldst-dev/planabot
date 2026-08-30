package config

import (
	"os"
	"path/filepath"
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
)

type Config struct {
	Host           string
	Listen         string
	HistoryPath    string
	APIKey         string
	UserAgent      string
	RequestTimeout time.Duration
}

func FromEnv() Config {
	cfg := Config{
		Host:           env("SENDVIS_HOST", domain.DefaultHost),
		Listen:         env("SENDVIS_LISTEN", "127.0.0.1:8080"),
		APIKey:         os.Getenv("SENDVIS_API_KEY"),
		UserAgent:      env("SENDVIS_USER_AGENT", "sendvis-unofficial/1.0"),
		RequestTimeout: 30 * time.Second,
		HistoryPath:    os.Getenv("SENDVIS_HISTORY"),
	}
	if cfg.HistoryPath == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			dir = "."
		}
		cfg.HistoryPath = filepath.Join(dir, "sendvis", "history.json")
	}
	return cfg
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
