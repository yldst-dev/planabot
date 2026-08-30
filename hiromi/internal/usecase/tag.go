package usecase

import (
	"context"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type TagService struct {
	tags port.TagRepository
}

func NewTagService(tags port.TagRepository) *TagService {
	return &TagService{tags: tags}
}

func (s *TagService) Search(ctx context.Context, term string) ([]domain.TagCount, error) {
	return s.tags.Search(ctx, term)
}

func (s *TagService) List(ctx context.Context, typ domain.TagType, initial domain.NameInitial) ([]domain.Tag, error) {
	return s.tags.List(ctx, typ, initial)
}

func (s *TagService) Languages(ctx context.Context, typ domain.TagType, name string) ([]domain.Language, error) {
	tag, err := domain.NewTag(typ, name, false)
	if err != nil {
		return nil, err
	}
	return s.tags.Languages(ctx, tag)
}

func (s *TagService) Parse(expr string) ([]domain.Tag, error) {
	return domain.ParseTagExpression(expr)
}
