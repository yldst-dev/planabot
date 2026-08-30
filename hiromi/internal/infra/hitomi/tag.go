package hitomi

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net/url"
	"strings"

	"hiromi/internal/domain"
)

func (c *Client) Search(ctx context.Context, term string) ([]domain.TagCount, error) {
	term = strings.TrimSpace(term)
	if term == "" {
		return nil, domain.ErrInvalidQuery
	}
	if strings.HasPrefix(term, "-") {
		term = term[1:]
	}
	path := "/global"
	i := strings.IndexByte(term, ':')
	if i > 0 {
		typ := domain.TagType(term[:i])
		if !typ.Valid() {
			return nil, fmt.Errorf("%w: type %q", domain.ErrInvalidTag, typ)
		}
		path = "/" + string(typ)
		term = term[i+1:]
	}
	for _, r := range term {
		if r == ':' {
			break
		}
		path += "/"
		switch r {
		case '.':
			path += "dot"
		case '/':
			path += "slash"
		default:
			path += string(r)
		}
	}
	body, _, _, err := c.getBytes(ctx, c.tagIndexURL(path+".json"), "", "")
	if err != nil {
		return nil, err
	}
	var rows [][]any
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, fmt.Errorf("%w: tag json: %v", domain.ErrRemote, err)
	}
	out := make([]domain.TagCount, 0, len(rows))
	for _, row := range rows {
		if len(row) < 3 {
			continue
		}
		name, _ := row[0].(string)
		count := 0
		switch v := row[1].(type) {
		case float64:
			count = int(v)
		case json.Number:
			n, _ := v.Int64()
			count = int(n)
		}
		typ, _ := row[2].(string)
		tag, err := domain.NewTag(domain.TagType(typ), name, false)
		if err != nil {
			continue
		}
		out = append(out, domain.TagCount{Tag: tag, Count: count})
	}
	return out, nil
}

func (c *Client) List(ctx context.Context, typ domain.TagType, initial domain.NameInitial) ([]domain.Tag, error) {
	if !typ.Valid() {
		return nil, fmt.Errorf("%w: type %q", domain.ErrInvalidTag, typ)
	}
	if typ == domain.TagLanguage {
		langs := domain.AllLanguages()
		out := make([]domain.Tag, 0, len(langs))
		for _, lang := range langs {
			tag, err := domain.NewTag(domain.TagLanguage, lang.Name, false)
			if err != nil {
				continue
			}
			out = append(out, tag)
		}
		return out, nil
	}
	if typ == domain.TagTypeKind {
		out := make([]domain.Tag, 0, 6)
		for _, name := range domain.AllGalleryTypes() {
			tag, err := domain.NewTag(domain.TagTypeKind, string(name), false)
			if err != nil {
				continue
			}
			out = append(out, tag)
		}
		return out, nil
	}
	if initial == "" {
		return nil, fmt.Errorf("%w: startsWith required", domain.ErrInvalidQuery)
	}
	area := ""
	target := "href=\"/" + string(typ) + "/"
	switch typ {
	case domain.TagMale, domain.TagFemale:
		target = "href=\"/tag/" + string(typ) + "%3A"
		area = "tags"
	case domain.TagGeneric:
		area = "tags"
	case domain.TagSeries:
		area = "series"
	case domain.TagArtist:
		area = "artists"
	case domain.TagCharacter:
		area = "characters"
	case domain.TagGroup:
		area = "groups"
	default:
		return nil, fmt.Errorf("%w: type %q", domain.ErrInvalidTag, typ)
	}
	body, _, _, err := c.getBytes(ctx, c.frontURL("/all"+area+"-"+string(initial)+".html"), "", "")
	if err != nil {
		return nil, err
	}
	htmlBody := string(body)
	var tags []domain.Tag
	searchFrom := 0
	for {
		idx := strings.Index(htmlBody[searchFrom:], target)
		if idx < 0 {
			break
		}
		start := searchFrom + idx + len(target)
		dot := strings.IndexByte(htmlBody[start:], '.')
		if dot < 0 {
			break
		}
		end := start + dot
		raw := htmlBody[start:end]
		if typ == domain.TagGeneric && (strings.HasPrefix(raw, "male") || strings.HasPrefix(raw, "female")) {
			searchFrom = end
			continue
		}
		if len(raw) < 4 {
			searchFrom = end
			continue
		}
		nameEnc := raw[:len(raw)-4]
		name, err := url.QueryUnescape(nameEnc)
		if err != nil {
			name = html.UnescapeString(nameEnc)
		}
		tag, err := domain.NewTag(typ, name, false)
		if err != nil {
			searchFrom = end
			continue
		}
		tags = append(tags, tag)
		searchFrom = end
	}
	return tags, nil
}

func (c *Client) Languages(ctx context.Context, tag domain.Tag) ([]domain.Language, error) {
	if tag.Type == domain.TagLanguage {
		if lang, ok := domain.LookupLanguage(tag.Name); ok {
			return []domain.Language{lang}, nil
		}
		return nil, domain.ErrInvalidTag
	}
	term := ""
	switch tag.Type {
	case domain.TagMale, domain.TagFemale:
		term = "tag/" + string(tag.Type) + ":" + tag.Name
	default:
		term = string(tag.Type) + "/" + tag.Name
	}
	mask, err := c.languageMask(ctx, term)
	if err != nil {
		return nil, err
	}
	return domain.LanguagesFromMask(mask), nil
}
