package domain

import "fmt"

const (
	DefaultDownloadWorkers = 2
	MaxDownloadWorkers     = 8
	DownloadAttempts       = 8
	TelegramDirectMaxBytes = 40 * 1024 * 1024
)

type DownloadOptions struct {
	Format       ImageFormat
	Workers      int
	IncludeVideo bool
	SkipExisting bool
}

func DefaultDownloadOptions() DownloadOptions {
	return DownloadOptions{
		Format:       FormatWebP,
		Workers:      DefaultDownloadWorkers,
		IncludeVideo: true,
		SkipExisting: true,
	}
}

func (o DownloadOptions) Normalize() DownloadOptions {
	if o.Format == "" {
		o.Format = FormatWebP
	}
	if o.Workers <= 0 {
		o.Workers = DefaultDownloadWorkers
	}
	if o.Workers > MaxDownloadWorkers {
		o.Workers = MaxDownloadWorkers
	}
	return o
}

type DownloadedFile struct {
	Index  int
	Name   string
	Path   string
	Bytes  int64
	Format ImageFormat
	Kind   string
}

type DownloadFailure struct {
	Index int
	Name  string
	Error string
}

type GalleryDownload struct {
	GalleryID uint64
	Title     string
	Type      GalleryType
	Language  string
	Dir       string
	PageCount int
	Saved     []DownloadedFile
	Skipped   []DownloadedFile
	Failed    []DownloadFailure
	Viewer    string
}

func DownloadFileName(index int, format ImageFormat) string {
	return fmt.Sprintf("%03d.%s", index+1, format)
}

func GalleryDirName(id uint64) string {
	return fmt.Sprintf("%d", id)
}

const ViewerFileName = "viewer.html"

type ViewerDocument struct {
	Title    string
	Language string
	Pages    []ViewerPage
}

type ViewerPage struct {
	Format ImageFormat
	Data   []byte
}
