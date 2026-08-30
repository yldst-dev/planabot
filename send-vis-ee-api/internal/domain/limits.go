package domain

const (
	DefaultHost              = "https://send.vis.ee"
	DefaultDownloads         = 1
	DefaultExpireSeconds     = 86400
	FallbackMaxFileSize      = 2684354560
	FallbackMaxDownloads     = 20
	FallbackMaxExpireSeconds = 259200
)

func FallbackLimits() Limits {
	return Limits{
		MaxFileSize:      FallbackMaxFileSize,
		MaxDownloads:     FallbackMaxDownloads,
		MaxExpireSeconds: FallbackMaxExpireSeconds,
		DownloadCounts:   []int{1, 2, 3, 5, 10, 20},
		ExpireSeconds:    []int{300, 3600, 86400, 259200},
		DefaultDownloads: DefaultDownloads,
		DefaultExpire:    DefaultExpireSeconds,
	}
}

type Limits struct {
	MaxFileSize      int64
	MaxDownloads     int
	MaxExpireSeconds int
	DownloadCounts   []int
	ExpireSeconds    []int
	DefaultDownloads int
	DefaultExpire    int
}

func (l Limits) WithDefaults() Limits {
	out := l
	if out.MaxFileSize <= 0 {
		out.MaxFileSize = FallbackMaxFileSize
	}
	if out.MaxDownloads <= 0 {
		out.MaxDownloads = FallbackMaxDownloads
	}
	if out.MaxExpireSeconds <= 0 {
		out.MaxExpireSeconds = FallbackMaxExpireSeconds
	}
	if out.DefaultDownloads <= 0 {
		out.DefaultDownloads = DefaultDownloads
	}
	if out.DefaultExpire <= 0 {
		out.DefaultExpire = DefaultExpireSeconds
	}
	if len(out.DownloadCounts) == 0 {
		out.DownloadCounts = []int{1, 2, 3, 5, 10, 20}
	}
	if len(out.ExpireSeconds) == 0 {
		out.ExpireSeconds = []int{300, 3600, 86400, 259200}
	}
	return out
}

func (l Limits) ValidateUpload(size int64, downloads, expireSeconds int) error {
	if size <= 0 {
		return ErrEmptyFile
	}
	if size > l.MaxFileSize {
		return ErrTooLarge
	}
	if downloads <= 0 || downloads > l.MaxDownloads {
		return ErrLimitExceeded
	}
	if expireSeconds <= 0 || expireSeconds > l.MaxExpireSeconds {
		return ErrLimitExceeded
	}
	return nil
}
