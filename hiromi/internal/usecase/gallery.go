package usecase

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type GalleryService struct {
	galleries port.GalleryRepository
	listing   port.ListingRepository
	urls      port.URLResolver
	embedN    int
}

func NewGalleryService(g port.GalleryRepository, l port.ListingRepository, u port.URLResolver) *GalleryService {
	return &GalleryService{galleries: g, listing: l, urls: u, embedN: 8}
}

func (s *GalleryService) Get(ctx context.Context, id uint64) (*domain.Gallery, error) {
	if id == 0 {
		return nil, domain.ErrInvalidID
	}
	return s.galleries.GetByID(ctx, id)
}

func (s *GalleryService) File(ctx context.Context, id uint64, index int) (*domain.Gallery, *domain.File, error) {
	g, err := s.galleries.GetByID(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	f, ok := g.FileByIndex(index)
	if !ok {
		return nil, nil, domain.ErrNotFound
	}
	return g, &f, nil
}

func (s *GalleryService) List(ctx context.Context, q domain.ListQuery, embed bool) (*domain.ListResult, error) {
	page, err := s.listing.ListIDs(ctx, q)
	if err != nil {
		return nil, err
	}
	res := &domain.ListResult{IDs: page.IDs, Total: page.Total, Page: page.Page}
	if !embed {
		return res, nil
	}
	res.Galleries, err = s.embed(ctx, page.IDs)
	return res, err
}

func (s *GalleryService) Related(ctx context.Context, id uint64, embed bool) (*domain.ListResult, error) {
	g, err := s.galleries.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	res := &domain.ListResult{
		IDs:   g.Related,
		Total: len(g.Related),
		Page:  domain.Page{Index: 0, Size: len(g.Related)},
	}
	if !embed {
		return res, nil
	}
	res.Galleries, err = s.embed(ctx, g.Related)
	return res, err
}

func (s *GalleryService) embed(ctx context.Context, ids []uint64) ([]domain.Gallery, error) {
	out := make([]domain.Gallery, len(ids))
	errCh := make(chan error, 1)
	sem := make(chan struct{}, s.embedN)
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id uint64) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				select {
				case errCh <- ctx.Err():
				default:
				}
				return
			}
			defer func() { <-sem }()
			g, err := s.galleries.GetByID(ctx, id)
			if err != nil {
				if errors.Is(err, domain.ErrNotFound) {
					return
				}
				select {
				case errCh <- fmt.Errorf("gallery %d: %w", id, err):
				default:
				}
				return
			}
			out[i] = *g
		}(i, id)
	}
	wg.Wait()
	select {
	case err := <-errCh:
		return nil, err
	default:
	}
	filled := make([]domain.Gallery, 0, len(out))
	for _, g := range out {
		if g.ID != 0 {
			filled = append(filled, g)
		}
	}
	return filled, nil
}
