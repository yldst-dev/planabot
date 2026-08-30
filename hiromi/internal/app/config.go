package app

import (
	"os"
	"strconv"
	"time"

	"hiromi/internal/infra/hitomi"
)

type Config struct {
	Addr          string
	DownloadDir   string
	TelegramToken string
	SendHost      string
	Hitomi        hitomi.Config
	DownloadHTTP  hitomi.Config
}

func LoadConfig() Config {
	cfg := Config{
		Addr:          env("HIROMI_ADDR", ":8080"),
		DownloadDir:   env("HIROMI_DOWNLOAD_DIR", "downloads"),
		TelegramToken: os.Getenv("TELEGRAM_BOT_TOKEN"),
		SendHost:      env("SENDVIS_HOST", "https://send.vis.ee"),
		Hitomi:        hitomi.DefaultConfig(),
	}
	if v := os.Getenv("HIROMI_FRONT"); v != "" {
		cfg.Hitomi.Front = v
	}
	if v := os.Getenv("HIROMI_LTN"); v != "" {
		cfg.Hitomi.LTN = v
	}
	if v := os.Getenv("HIROMI_CDN"); v != "" {
		cfg.Hitomi.CDN = v
	}
	if v := os.Getenv("HIROMI_TAGINDEX"); v != "" {
		cfg.Hitomi.TagIndex = v
	}
	if v := os.Getenv("HIROMI_USER_AGENT"); v != "" {
		cfg.Hitomi.UserAgent = v
	}
	if v := os.Getenv("HIROMI_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.Hitomi.Timeout = d
		}
	}
	if v := os.Getenv("HIROMI_GG_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.Hitomi.GGTTL = d
		}
	}
	if v := os.Getenv("HIROMI_INDEX_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.Hitomi.IndexTTL = d
		}
	}
	if v := os.Getenv("HIROMI_DISABLE_SNI"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			cfg.Hitomi.DisableSNI = b
		}
	}
	cfg.DownloadHTTP = cfg.Hitomi
	if v := os.Getenv("HIROMI_DOWNLOAD_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.DownloadHTTP.Timeout = d
		}
	} else {
		cfg.DownloadHTTP.Timeout = 10 * time.Minute
	}
	return cfg
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
