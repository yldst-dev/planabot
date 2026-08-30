package domain

import (
	"path/filepath"
	"strings"
	"time"
)

type ManifestFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Type string `json:"type"`
}

type Manifest struct {
	Files []ManifestFile `json:"files"`
}

type ManagedFile struct {
	ID            string    `json:"id"`
	Host          string    `json:"host"`
	URL           string    `json:"url"`
	DownloadURL   string    `json:"download_url"`
	Name          string    `json:"name"`
	Size          int64     `json:"size"`
	MIME          string    `json:"mime"`
	Secret        string    `json:"secret"`
	OwnerToken    string    `json:"owner_token"`
	DownloadMax   int       `json:"download_limit"`
	DownloadCount int       `json:"download_count"`
	HasPassword   bool      `json:"has_password"`
	ExpireSeconds int       `json:"expire_seconds"`
	Manifest      Manifest  `json:"manifest"`
	CreatedAt     time.Time `json:"created_at"`
	ExpiresAt     time.Time `json:"expires_at"`
}

func (f ManagedFile) BaseName() string {
	name := filepath.Base(strings.ReplaceAll(f.Name, "\\", "/"))
	if name == "." || name == string(filepath.Separator) || name == "" {
		return "download"
	}
	return name
}

func SingleManifest(name string, size int64, mime string) Manifest {
	return Manifest{
		Files: []ManifestFile{{
			Name: name,
			Size: size,
			Type: mime,
		}},
	}
}
