package httpapi

import (
	"time"

	"hiromi/internal/domain"
)

type languageDTO struct {
	Name      string `json:"name"`
	LocalName string `json:"local_name"`
	URL       string `json:"url"`
}

type tagDTO struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Negative bool   `json:"negative,omitempty"`
	URL      string `json:"url"`
	Query    string `json:"query"`
}

type fileDTO struct {
	Index    int         `json:"index"`
	Name     string      `json:"name"`
	Hash     string      `json:"hash"`
	Width    int         `json:"width"`
	Height   int         `json:"height"`
	HasWebP  bool        `json:"has_webp"`
	HasAVIF  bool        `json:"has_avif"`
	HasJXL   bool        `json:"has_jxl"`
	HasThumb bool        `json:"has_thumbnail"`
	URLs     fileURLsDTO `json:"urls"`
}

type fileURLsDTO struct {
	WebP            string `json:"webp,omitempty"`
	AVIF            string `json:"avif,omitempty"`
	JXL             string `json:"jxl,omitempty"`
	ThumbSmallWebP  string `json:"thumbnail_small_webp,omitempty"`
	ThumbSmallAVIF  string `json:"thumbnail_small_avif,omitempty"`
	ThumbMediumAVIF string `json:"thumbnail_medium_avif,omitempty"`
	ThumbBigWebP    string `json:"thumbnail_big_webp,omitempty"`
	ThumbBigAVIF    string `json:"thumbnail_big_avif,omitempty"`
}

type videoDTO struct {
	FileName  string `json:"file_name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	URL       string `json:"url"`
	PosterURL string `json:"poster_url,omitempty"`
}

type translationDTO struct {
	ID       uint64      `json:"id"`
	Language languageDTO `json:"language"`
	URL      string      `json:"url"`
}

type galleryDTO struct {
	ID            uint64           `json:"id"`
	Title         string           `json:"title"`
	JapaneseTitle string           `json:"japanese_title,omitempty"`
	Type          string           `json:"type"`
	Language      *languageDTO     `json:"language,omitempty"`
	URLs          galleryURLsDTO   `json:"urls"`
	Artists       []tagDTO         `json:"artists"`
	Groups        []tagDTO         `json:"groups"`
	Series        []tagDTO         `json:"series"`
	Characters    []tagDTO         `json:"characters"`
	Tags          []tagDTO         `json:"tags"`
	Files         []fileDTO        `json:"files"`
	PageCount     int              `json:"page_count"`
	Translations  []translationDTO `json:"translations"`
	Related       []uint64         `json:"related"`
	SceneIndexes  []int            `json:"scene_indexes,omitempty"`
	Blocked       bool             `json:"blocked"`
	AddedAt       *time.Time       `json:"added_at,omitempty"`
	PublishedAt   *time.Time       `json:"published_at,omitempty"`
	Video         *videoDTO        `json:"video,omitempty"`
	Thumbnails    []fileDTO        `json:"thumbnails,omitempty"`
}

type galleryURLsDTO struct {
	Gallery string `json:"gallery"`
	Reader  string `json:"reader"`
	Page    string `json:"page"`
}

type listDTO struct {
	IDs       []uint64     `json:"ids"`
	Galleries []galleryDTO `json:"galleries,omitempty"`
	Total     int          `json:"total"`
	Page      int          `json:"page"`
	Size      int          `json:"size"`
}

type tagCountDTO struct {
	Tag   tagDTO `json:"tag"`
	Count int    `json:"count"`
}

type errorDTO struct {
	Error string `json:"error"`
}

type healthDTO struct {
	Status string `json:"status"`
}

type downloadedFileDTO struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	Format string `json:"format,omitempty"`
	Kind   string `json:"kind"`
}

type downloadFailureDTO struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Error string `json:"error"`
}

type galleryDownloadDTO struct {
	ID        uint64               `json:"id"`
	Title     string               `json:"title"`
	Type      string               `json:"type"`
	Language  string               `json:"language,omitempty"`
	Dir       string               `json:"dir"`
	PageCount int                  `json:"page_count"`
	Saved     []downloadedFileDTO  `json:"saved"`
	Skipped   []downloadedFileDTO  `json:"skipped"`
	Failed    []downloadFailureDTO `json:"failed"`
	Viewer    string               `json:"viewer,omitempty"`
}

func downloadDTOFrom(r *domain.GalleryDownload) galleryDownloadDTO {
	dto := galleryDownloadDTO{
		ID:        r.GalleryID,
		Title:     r.Title,
		Type:      string(r.Type),
		Language:  r.Language,
		Dir:       r.Dir,
		PageCount: r.PageCount,
		Saved:     make([]downloadedFileDTO, 0, len(r.Saved)),
		Skipped:   make([]downloadedFileDTO, 0, len(r.Skipped)),
		Failed:    make([]downloadFailureDTO, 0, len(r.Failed)),
		Viewer:    r.Viewer,
	}
	for _, f := range r.Saved {
		dto.Saved = append(dto.Saved, downloadedFileDTO{Index: f.Index, Name: f.Name, Path: f.Path, Bytes: f.Bytes, Format: string(f.Format), Kind: f.Kind})
	}
	for _, f := range r.Skipped {
		dto.Skipped = append(dto.Skipped, downloadedFileDTO{Index: f.Index, Name: f.Name, Path: f.Path, Bytes: f.Bytes, Format: string(f.Format), Kind: f.Kind})
	}
	for _, f := range r.Failed {
		dto.Failed = append(dto.Failed, downloadFailureDTO{Index: f.Index, Name: f.Name, Error: f.Error})
	}
	return dto
}

func (h *Handler) abs(path string) string {
	if path == "" {
		return ""
	}
	if len(path) >= 4 && path[:4] == "http" {
		return path
	}
	if path[0] != '/' {
		path = "/" + path
	}
	return h.front + path
}

func (h *Handler) languageDTO(l domain.Language) languageDTO {
	return languageDTO{Name: l.Name, LocalName: l.LocalName, URL: h.abs(l.URLPath())}
}

func (h *Handler) tagDTO(t domain.Tag) tagDTO {
	return tagDTO{
		Type:     string(t.Type),
		Name:     t.Name,
		Negative: t.Negative,
		URL:      h.abs(t.URLPath),
		Query:    t.String(),
	}
}

func (h *Handler) tagsDTO(tags []domain.Tag) []tagDTO {
	if tags == nil {
		return []tagDTO{}
	}
	out := make([]tagDTO, 0, len(tags))
	for _, t := range tags {
		out = append(out, h.tagDTO(t))
	}
	return out
}

func (h *Handler) fileDTO(f domain.File) fileDTO {
	return fileDTO{
		Index:    f.Index,
		Name:     f.Name,
		Hash:     f.Hash,
		Width:    f.Width,
		Height:   f.Height,
		HasWebP:  f.HasWebP,
		HasAVIF:  f.HasAVIF,
		HasJXL:   f.HasJXL,
		HasThumb: f.HasThumb,
		URLs: fileURLsDTO{
			WebP:            f.URLs.WebP,
			AVIF:            f.URLs.AVIF,
			JXL:             f.URLs.JXL,
			ThumbSmallWebP:  f.URLs.ThumbSmallWebP,
			ThumbSmallAVIF:  f.URLs.ThumbSmallAVIF,
			ThumbMediumAVIF: f.URLs.ThumbMediumAVIF,
			ThumbBigWebP:    f.URLs.ThumbBigWebP,
			ThumbBigAVIF:    f.URLs.ThumbBigAVIF,
		},
	}
}

func (h *Handler) filesDTO(files []domain.File) []fileDTO {
	if files == nil {
		return []fileDTO{}
	}
	out := make([]fileDTO, 0, len(files))
	for _, f := range files {
		out = append(out, h.fileDTO(f))
	}
	return out
}

func (h *Handler) galleryDTO(g domain.Gallery) galleryDTO {
	dto := galleryDTO{
		ID:            g.ID,
		Title:         g.Title,
		JapaneseTitle: g.JapaneseTitle,
		Type:          string(g.Type),
		URLs: galleryURLsDTO{
			Gallery: h.abs(g.GalleryPath),
			Reader:  h.abs(g.ReaderPath),
			Page:    h.abs(g.GalleryPath),
		},
		Artists:      h.tagsDTO(g.Artists),
		Groups:       h.tagsDTO(g.Groups),
		Series:       h.tagsDTO(g.Series),
		Characters:   h.tagsDTO(g.Characters),
		Tags:         h.tagsDTO(g.Tags),
		Files:        h.filesDTO(g.Files),
		PageCount:    g.PageCount(),
		Related:      g.Related,
		SceneIndexes: g.SceneIndexes,
		Blocked:      g.Blocked,
		PublishedAt:  g.PublishedAt,
		Thumbnails:   h.filesDTO(g.ThumbnailFiles()),
	}
	if g.Related == nil {
		dto.Related = []uint64{}
	}
	if !g.AddedAt.IsZero() {
		t := g.AddedAt
		dto.AddedAt = &t
	}
	if g.Language != nil {
		l := h.languageDTO(*g.Language)
		dto.Language = &l
	}
	dto.Translations = make([]translationDTO, 0, len(g.Translations))
	for _, tr := range g.Translations {
		dto.Translations = append(dto.Translations, translationDTO{
			ID:       tr.ID,
			Language: h.languageDTO(tr.Language),
			URL:      h.abs(tr.URLPath),
		})
	}
	if g.Video != nil {
		dto.Video = &videoDTO{
			FileName:  g.Video.FileName,
			Width:     g.Video.Width,
			Height:    g.Video.Height,
			URL:       g.Video.URL,
			PosterURL: g.Video.PosterURL,
		}
	}
	return dto
}

func (h *Handler) listDTO(r *domain.ListResult) listDTO {
	dto := listDTO{
		IDs:   r.IDs,
		Total: r.Total,
		Page:  r.Page.Index,
		Size:  r.Page.Size,
	}
	if dto.IDs == nil {
		dto.IDs = []uint64{}
	}
	if len(r.Galleries) > 0 {
		dto.Galleries = make([]galleryDTO, 0, len(r.Galleries))
		for _, g := range r.Galleries {
			dto.Galleries = append(dto.Galleries, h.galleryDTO(g))
		}
	}
	return dto
}
