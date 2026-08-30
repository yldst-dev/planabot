package domain

import (
	"fmt"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

type TagType string

const (
	TagArtist    TagType = "artist"
	TagGroup     TagType = "group"
	TagTypeKind  TagType = "type"
	TagLanguage  TagType = "language"
	TagSeries    TagType = "series"
	TagCharacter TagType = "character"
	TagMale      TagType = "male"
	TagFemale    TagType = "female"
	TagGeneric   TagType = "tag"
)

func (t TagType) Valid() bool {
	switch t {
	case TagArtist, TagGroup, TagTypeKind, TagLanguage, TagSeries, TagCharacter, TagMale, TagFemale, TagGeneric:
		return true
	default:
		return false
	}
}

func AllTagTypes() []TagType {
	return []TagType{
		TagArtist, TagGroup, TagTypeKind, TagLanguage, TagSeries, TagCharacter, TagMale, TagFemale, TagGeneric,
	}
}

type Tag struct {
	Type       TagType
	Name       string
	Negative   bool
	URLPath    string
	GalleryURL string
}

func (t Tag) String() string {
	prefix := ""
	if t.Negative {
		prefix = "-"
	}
	return prefix + string(t.Type) + ":" + strings.ReplaceAll(t.Name, " ", "_")
}

func (t Tag) NormalizedName() string {
	return strings.ReplaceAll(t.Name, "_", " ")
}

func NewTag(typ TagType, name string, negative bool) (Tag, error) {
	if !typ.Valid() {
		return Tag{}, fmt.Errorf("%w: type %q", ErrInvalidTag, typ)
	}
	name = strings.TrimSpace(strings.ReplaceAll(name, "_", " "))
	if name == "" {
		return Tag{}, fmt.Errorf("%w: empty name", ErrInvalidTag)
	}
	if typ == TagLanguage && !KnownLanguage(name) {
		return Tag{}, fmt.Errorf("%w: unknown language %q", ErrInvalidTag, name)
	}
	if typ == TagTypeKind && !ValidGalleryType(GalleryType(name)) {
		return Tag{}, fmt.Errorf("%w: unknown gallery type %q", ErrInvalidTag, name)
	}
	tag := Tag{Type: typ, Name: name, Negative: negative}
	tag.URLPath = tagPath(tag)
	return tag, nil
}

func tagPath(t Tag) string {
	switch t.Type {
	case TagMale, TagFemale:
		return "/tag/" + string(t.Type) + "%3A" + encodeURIComponent(t.Name) + "-all.html"
	case TagLanguage:
		return "/index-" + t.Name + ".html"
	default:
		return "/" + string(t.Type) + "/" + encodeURIComponent(t.Name) + "-all.html"
	}
}

func ParseTagExpression(expr string) ([]Tag, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil, nil
	}
	seen := map[string]struct{}{}
	var tags []Tag
	for _, token := range strings.Fields(expr) {
		colon := strings.IndexByte(token, ':')
		if colon <= 0 {
			continue
		}
		if _, ok := seen[token]; ok {
			continue
		}
		seen[token] = struct{}{}
		negative := strings.HasPrefix(token, "-")
		start := 0
		if negative {
			start = 1
		}
		typ := TagType(token[start:colon])
		name := token[colon+1:]
		tag, err := NewTag(typ, name, negative)
		if err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, nil
}

type NameInitial string

const (
	Initial123 NameInitial = "123"
)

func ParseNameInitial(s string) (NameInitial, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "123" || s == "#" || s == "other" {
		return Initial123, nil
	}
	if len(s) != 1 {
		return "", fmt.Errorf("%w: initial %q", ErrInvalidQuery, s)
	}
	r, _ := utf8.DecodeRuneInString(s)
	if r < 'a' || r > 'z' {
		return "", fmt.Errorf("%w: initial %q", ErrInvalidQuery, s)
	}
	return NameInitial(s), nil
}

func InitialOf(name string) NameInitial {
	name = strings.TrimSpace(strings.ToLower(name))
	if name == "" {
		return Initial123
	}
	r, _ := utf8.DecodeRuneInString(name)
	if unicode.IsLetter(r) && r < 128 {
		return NameInitial(strings.ToLower(string(r)))
	}
	return Initial123
}

type TagCount struct {
	Tag   Tag
	Count int
}

func encodeURIComponent(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}
