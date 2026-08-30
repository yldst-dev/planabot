package hitomi

import (
	"fmt"
	"strings"
	"time"

	"hiromi/internal/domain"
)

type rawGallery struct {
	ID                flexID           `json:"id"`
	Title             string           `json:"title"`
	JapaneseTitle     *string          `json:"japanese_title"`
	Type              string           `json:"type"`
	Language          *string          `json:"language"`
	LanguageLocalName *string          `json:"language_localname"`
	LanguageURL       string           `json:"language_url"`
	GalleryURL        string           `json:"galleryurl"`
	Date              string           `json:"date"`
	DatePublished     *string          `json:"datepublished"`
	Blocked           flag             `json:"blocked"`
	Video             *string          `json:"video"`
	VideoFileName     *string          `json:"videofilename"`
	Related           []uint64         `json:"related"`
	SceneIndexes      []int            `json:"scene_indexes"`
	Artists           []rawNamed       `json:"artists"`
	Groups            []rawNamed       `json:"groups"`
	Parodys           []rawNamed       `json:"parodys"`
	Characters        []rawNamed       `json:"characters"`
	Tags              []rawTag         `json:"tags"`
	Files             []rawFile        `json:"files"`
	Languages         []rawTranslation `json:"languages"`
}

type rawNamed struct {
	Artist    string `json:"artist"`
	Group     string `json:"group"`
	Parody    string `json:"parody"`
	Character string `json:"character"`
	URL       string `json:"url"`
}

type rawTag struct {
	Tag    string `json:"tag"`
	URL    string `json:"url"`
	Male   flag   `json:"male"`
	Female flag   `json:"female"`
}

type rawFile struct {
	Name    string `json:"name"`
	Hash    string `json:"hash"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	HasWebP *flag  `json:"haswebp"`
	HasAVIF flag   `json:"hasavif"`
	HasJXL  flag   `json:"hasjxl"`
}

type rawTranslation struct {
	GalleryID         flexID `json:"galleryid"`
	Name              string `json:"name"`
	LanguageLocalName string `json:"language_localname"`
	URL               string `json:"url"`
}

func (r rawGallery) toDomain() *domain.Gallery {
	g := &domain.Gallery{
		ID:           uint64(r.ID),
		Title:        r.Title,
		Type:         domain.GalleryType(r.Type),
		GalleryPath:  r.GalleryURL,
		ReaderPath:   fmt.Sprintf("/reader/%d.html", r.ID),
		Related:      r.Related,
		SceneIndexes: r.SceneIndexes,
		Blocked:      bool(r.Blocked),
		LanguagePath: r.LanguageURL,
	}
	if r.JapaneseTitle != nil {
		g.JapaneseTitle = *r.JapaneseTitle
	}
	if r.Language != nil && *r.Language != "" {
		local := ""
		if r.LanguageLocalName != nil {
			local = *r.LanguageLocalName
		}
		if lang, ok := domain.LookupLanguage(*r.Language); ok {
			if local != "" {
				lang.LocalName = local
			}
			g.Language = &lang
		} else {
			g.Language = &domain.Language{Name: *r.Language, LocalName: local}
		}
	}
	g.AddedAt = parseHitomiTime(r.Date)
	if r.DatePublished != nil && *r.DatePublished != "" {
		t := parseHitomiTime(*r.DatePublished)
		if !t.IsZero() {
			g.PublishedAt = &t
		}
	}
	g.Artists = namedTags(domain.TagArtist, r.Artists, func(n rawNamed) string { return n.Artist })
	g.Groups = namedTags(domain.TagGroup, r.Groups, func(n rawNamed) string { return n.Group })
	g.Series = namedTags(domain.TagSeries, r.Parodys, func(n rawNamed) string { return n.Parody })
	g.Characters = namedTags(domain.TagCharacter, r.Characters, func(n rawNamed) string { return n.Character })
	g.Tags = make([]domain.Tag, 0, len(r.Tags))
	for _, t := range r.Tags {
		typ := domain.TagGeneric
		if t.Female {
			typ = domain.TagFemale
		} else if t.Male {
			typ = domain.TagMale
		}
		tag, err := domain.NewTag(typ, t.Tag, false)
		if err != nil {
			continue
		}
		if t.URL != "" {
			tag.URLPath = t.URL
		}
		g.Tags = append(g.Tags, tag)
	}
	thumbIndex := 0
	if n := len(r.Files); n > 0 {
		thumbIndex = n / 2
	}
	g.Files = make([]domain.File, 0, len(r.Files))
	for i, f := range r.Files {
		hasWebP := true
		if f.HasWebP != nil {
			hasWebP = bool(*f.HasWebP)
		}
		g.Files = append(g.Files, domain.File{
			Index:    i,
			Name:     f.Name,
			Hash:     f.Hash,
			Width:    f.Width,
			Height:   f.Height,
			HasWebP:  hasWebP,
			HasAVIF:  bool(f.HasAVIF),
			HasJXL:   bool(f.HasJXL),
			HasThumb: i == 0 || i == thumbIndex,
		})
	}
	g.Translations = make([]domain.Translation, 0, len(r.Languages))
	for _, tr := range r.Languages {
		lang, ok := domain.LookupLanguage(tr.Name)
		if !ok {
			lang = domain.Language{Name: tr.Name, LocalName: tr.LanguageLocalName}
		} else if tr.LanguageLocalName != "" {
			lang.LocalName = tr.LanguageLocalName
		}
		g.Translations = append(g.Translations, domain.Translation{
			ID:       uint64(tr.GalleryID),
			Language: lang,
			URLPath:  tr.URL,
		})
	}
	if r.VideoFileName != nil && *r.VideoFileName != "" {
		w, h := 0, 0
		if len(g.Files) > 1 {
			w, h = g.Files[1].Width, g.Files[1].Height
		} else if len(g.Files) == 1 {
			w, h = g.Files[0].Width, g.Files[0].Height
		}
		g.Video = &domain.Video{
			FileName: *r.VideoFileName,
			Width:    w,
			Height:   h,
		}
	}
	return g
}

func namedTags(typ domain.TagType, items []rawNamed, name func(rawNamed) string) []domain.Tag {
	out := make([]domain.Tag, 0, len(items))
	for _, it := range items {
		n := name(it)
		if n == "" {
			continue
		}
		tag, err := domain.NewTag(typ, n, false)
		if err != nil {
			continue
		}
		if it.URL != "" {
			tag.URLPath = it.URL
		}
		out = append(out, tag)
	}
	return out
}

func parseHitomiTime(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	if strings.Count(s, ":") == 2 && (strings.HasSuffix(s, "-05") || len(s) >= 3 && (s[len(s)-3] == '-' || s[len(s)-3] == '+') && s[len(s)-2] != ':') {
		if len(s) >= 3 {
			tz := s[len(s)-3:]
			if len(tz) == 3 && (tz[0] == '-' || tz[0] == '+') && tz[1] >= '0' && tz[1] <= '9' {
				s = s + ":00"
			}
		}
	}
	layouts := []string{
		"2006-01-02 15:04:05-07:00",
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func stripGalleryJS(body []byte) []byte {
	const prefix = "var galleryinfo = "
	s := strings.TrimSpace(string(body))
	if strings.HasPrefix(s, prefix) {
		return []byte(s[len(prefix):])
	}
	if i := strings.Index(s, "{"); i >= 0 {
		return []byte(s[i:])
	}
	return []byte(s)
}
