package port

import (
	"context"
	"io"

	"hiromi/internal/domain"
)

type GalleryRepository interface {
	GetByID(ctx context.Context, id uint64) (*domain.Gallery, error)
}

type ListingRepository interface {
	ListIDs(ctx context.Context, q domain.ListQuery) (*domain.IDPage, error)
}

type SearchRepository interface {
	SearchTitle(ctx context.Context, terms []string) ([]uint64, error)
}

type TagRepository interface {
	Search(ctx context.Context, term string) ([]domain.TagCount, error)
	List(ctx context.Context, typ domain.TagType, initial domain.NameInitial) ([]domain.Tag, error)
	Languages(ctx context.Context, tag domain.Tag) ([]domain.Language, error)
}

type URLResolver interface {
	ResolveFile(ctx context.Context, file *domain.File) error
	ResolveVideo(video *domain.Video)
	ImageURL(ctx context.Context, hash string, format domain.ImageFormat) (string, error)
	ThumbnailURL(hash string, format domain.ImageFormat, size domain.ThumbSize) (string, error)
}

type MediaFetcher interface {
	Fetch(ctx context.Context, rawURL, referer string) (body io.ReadCloser, contentType string, err error)
}

type FileStore interface {
	Root() string
	Exists(relPath string) (bool, int64, error)
	Read(relPath string) ([]byte, error)
	Write(relPath string, r io.Reader) (int64, error)
	RemoveAll(relPath string) error
}

type ShareLimits struct {
	Downloads int
	ExpireSec int
}

type UploadedShare struct {
	URL  string
	Name string
	Size int64
}

type ShareUploader interface {
	Limits(ctx context.Context) (ShareLimits, error)
	Upload(ctx context.Context, name string, size int64, body io.Reader) (*UploadedShare, error)
}

type ShareClaim struct {
	Token     string
	GalleryID uint64
	Title     string
	URL       string
	Path      string
	Size      int64
	Pages     int
}

type ClaimStore interface {
	Put(claim ShareClaim) error
	Get(token string) (ShareClaim, error)
}

type ViewerRenderer interface {
	Render(doc domain.ViewerDocument) ([]byte, error)
}
