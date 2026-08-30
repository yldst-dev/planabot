package usecase

import (
	"context"
	"io"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type MediaService struct {
	galleries port.GalleryRepository
	urls      port.URLResolver
	fetch     port.MediaFetcher
	front     string
}

func NewMediaService(g port.GalleryRepository, u port.URLResolver, f port.MediaFetcher, front string) *MediaService {
	return &MediaService{galleries: g, urls: u, fetch: f, front: front}
}

func (s *MediaService) Resolve(ctx context.Context, hash string, format domain.ImageFormat, thumb domain.ThumbSize) (string, error) {
	if thumb == domain.ThumbNone {
		return s.urls.ImageURL(ctx, hash, format)
	}
	if thumb == domain.ThumbMedium && format != domain.FormatAVIF {
		return "", domain.ErrUnavailableThumb
	}
	return s.urls.ThumbnailURL(hash, format, thumb)
}

func (s *MediaService) OpenFile(ctx context.Context, id uint64, index int, format domain.ImageFormat, thumb domain.ThumbSize) (io.ReadCloser, string, error) {
	g, err := s.galleries.GetByID(ctx, id)
	if err != nil {
		return nil, "", err
	}
	file, ok := g.FileByIndex(index)
	if !ok {
		return nil, "", domain.ErrNotFound
	}
	if !file.Supports(format) {
		return nil, "", domain.ErrUnavailableFormat
	}
	if thumb != domain.ThumbNone {
		if !file.HasThumb && thumb != domain.ThumbSmall {
			return nil, "", domain.ErrUnavailableThumb
		}
		if thumb == domain.ThumbMedium && format != domain.FormatAVIF {
			return nil, "", domain.ErrUnavailableThumb
		}
	}
	rawURL, err := s.Resolve(ctx, file.Hash, format, thumb)
	if err != nil {
		return nil, "", err
	}
	referer := s.front + g.ReaderPath
	return s.fetch.Fetch(ctx, rawURL, referer)
}
