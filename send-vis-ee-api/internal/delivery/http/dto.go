package rest

import (
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

type errorBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

type fileBody struct {
	ID            string    `json:"id"`
	URL           string    `json:"url"`
	DownloadURL   string    `json:"download_url"`
	Name          string    `json:"name"`
	Size          int64     `json:"size"`
	MIME          string    `json:"mime"`
	Secret        string    `json:"secret"`
	OwnerToken    string    `json:"owner_token"`
	DownloadLimit int       `json:"download_limit"`
	DownloadCount int       `json:"download_count"`
	HasPassword   bool      `json:"has_password"`
	ExpireSeconds int       `json:"expire_seconds"`
	CreatedAt     time.Time `json:"created_at"`
	ExpiresAt     time.Time `json:"expires_at"`
}

type listBody struct {
	Files []fileBody `json:"files"`
}

type instanceBody struct {
	Host             string `json:"host"`
	Version          string `json:"version"`
	Commit           string `json:"commit"`
	Source           string `json:"source"`
	MaxFileSize      int64  `json:"max_file_size"`
	MaxDownloads     int    `json:"max_downloads"`
	MaxExpireSeconds int    `json:"max_expire_seconds"`
	DownloadCounts   []int  `json:"download_counts"`
	ExpireSeconds    []int  `json:"expire_seconds"`
	DefaultDownloads int    `json:"default_downloads"`
	DefaultExpire    int    `json:"default_expire"`
}

type existsBody struct {
	Exists           bool `json:"exists"`
	RequiresPassword bool `json:"requires_password"`
}

type inspectBody struct {
	Name          string          `json:"name"`
	Size          int64           `json:"size"`
	MIME          string          `json:"mime"`
	TTLMillis     int64           `json:"ttl_millis"`
	FinalDownload bool            `json:"final_download"`
	Manifest      domain.Manifest `json:"manifest"`
	Managed       *fileBody       `json:"managed,omitempty"`
}

type passwordReq struct {
	Password string `json:"password"`
}

type limitReq struct {
	DownloadLimit int `json:"download_limit"`
}

type importReq struct {
	URL        string `json:"url"`
	OwnerToken string `json:"owner_token"`
	Password   string `json:"password"`
}

type inspectReq struct {
	URL      string `json:"url"`
	ID       string `json:"id"`
	Password string `json:"password"`
}

func toFileBody(f *domain.ManagedFile) fileBody {
	if f == nil {
		return fileBody{}
	}
	return fileBody{
		ID:            f.ID,
		URL:           f.URL,
		DownloadURL:   f.DownloadURL,
		Name:          f.Name,
		Size:          f.Size,
		MIME:          f.MIME,
		Secret:        f.Secret,
		OwnerToken:    f.OwnerToken,
		DownloadLimit: f.DownloadMax,
		DownloadCount: f.DownloadCount,
		HasPassword:   f.HasPassword,
		ExpireSeconds: f.ExpireSeconds,
		CreatedAt:     f.CreatedAt,
		ExpiresAt:     f.ExpiresAt,
	}
}

func toInstance(host string, inst usecase.Instance) instanceBody {
	l := inst.Limits.WithDefaults()
	return instanceBody{
		Host:             host,
		Version:          inst.Version,
		Commit:           inst.Commit,
		Source:           inst.Source,
		MaxFileSize:      l.MaxFileSize,
		MaxDownloads:     l.MaxDownloads,
		MaxExpireSeconds: l.MaxExpireSeconds,
		DownloadCounts:   l.DownloadCounts,
		ExpireSeconds:    l.ExpireSeconds,
		DefaultDownloads: l.DefaultDownloads,
		DefaultExpire:    l.DefaultExpire,
	}
}
