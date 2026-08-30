package domain

import "time"

type GalleryType string

const (
	TypeDoujinshi GalleryType = "doujinshi"
	TypeManga     GalleryType = "manga"
	TypeArtistCG  GalleryType = "artistcg"
	TypeGameCG    GalleryType = "gamecg"
	TypeImageSet  GalleryType = "imageset"
	TypeAnime     GalleryType = "anime"
)

func ValidGalleryType(t GalleryType) bool {
	switch t {
	case TypeDoujinshi, TypeManga, TypeArtistCG, TypeGameCG, TypeImageSet, TypeAnime:
		return true
	default:
		return false
	}
}

func AllGalleryTypes() []GalleryType {
	return []GalleryType{TypeDoujinshi, TypeManga, TypeArtistCG, TypeGameCG, TypeImageSet, TypeAnime}
}

type Translation struct {
	ID       uint64
	Language Language
	URLPath  string
}

type Gallery struct {
	ID            uint64
	Title         string
	JapaneseTitle string
	Type          GalleryType
	Language      *Language
	LanguagePath  string
	GalleryPath   string
	ReaderPath    string
	Artists       []Tag
	Groups        []Tag
	Series        []Tag
	Characters    []Tag
	Tags          []Tag
	Files         []File
	Translations  []Translation
	Related       []uint64
	SceneIndexes  []int
	Blocked       bool
	AddedAt       time.Time
	PublishedAt   *time.Time
	Video         *Video
}

func (g Gallery) PageCount() int {
	return len(g.Files)
}

func (g Gallery) ThumbnailFiles() []File {
	if len(g.Files) == 0 {
		return nil
	}
	mid := len(g.Files) / 2
	if mid == 0 {
		return []File{g.Files[0]}
	}
	return []File{g.Files[0], g.Files[mid]}
}

func (g Gallery) FileByIndex(index int) (File, bool) {
	if index < 0 || index >= len(g.Files) {
		return File{}, false
	}
	return g.Files[index], true
}
