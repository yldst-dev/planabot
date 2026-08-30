package usecase

import "hiromi/internal/domain"

type CatalogService struct{}

func NewCatalogService() *CatalogService {
	return &CatalogService{}
}

func (s *CatalogService) Languages() []domain.Language {
	return domain.AllLanguages()
}

func (s *CatalogService) Types() []domain.GalleryType {
	return domain.AllGalleryTypes()
}

func (s *CatalogService) TagTypes() []domain.TagType {
	return domain.AllTagTypes()
}

func (s *CatalogService) Sorts() []domain.Sort {
	return []domain.Sort{
		domain.SortAdded,
		domain.SortPublished,
		domain.SortRandom,
		domain.SortToday,
		domain.SortWeek,
		domain.SortMonth,
		domain.SortYear,
	}
}
