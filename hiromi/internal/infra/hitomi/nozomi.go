package hitomi

import (
	"encoding/binary"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"hiromi/internal/domain"
)

func decodeNozomi(data []byte) []uint64 {
	n := len(data) / 4
	ids := make([]uint64, 0, n)
	for i := 0; i+4 <= len(data); i += 4 {
		ids = append(ids, uint64(binary.BigEndian.Uint32(data[i:i+4])))
	}
	return ids
}

func parseContentRangeTotal(h string) int {
	slash := strings.LastIndexByte(h, '/')
	if slash < 0 || slash+1 >= len(h) {
		return 0
	}
	n, err := strconv.Atoi(h[slash+1:])
	if err != nil {
		return 0
	}
	return n / 4
}

func encodeComponent(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func nozomiPath(tag *domain.Tag, language string, sort domain.Sort) string {
	if language == "" {
		language = "all"
	}
	order := ""
	switch sort {
	case domain.SortPublished:
		order = "date/published"
	case domain.SortToday:
		order = "popular/today"
	case domain.SortWeek:
		order = "popular/week"
	case domain.SortMonth:
		order = "popular/month"
	case domain.SortYear:
		order = "popular/year"
	}
	if tag == nil || tag.Type == domain.TagLanguage {
		if tag != nil && tag.Type == domain.TagLanguage {
			language = tag.Name
		}
		if order == "" {
			return "/n/index-" + language + ".nozomi"
		}
		return "/n/" + order + "-" + language + ".nozomi"
	}
	prefix := ""
	if order != "" {
		prefix = order + "/"
	}
	name := encodeComponent(tag.Name)
	switch tag.Type {
	case domain.TagMale, domain.TagFemale:
		return "/n/tag/" + prefix + string(tag.Type) + ":" + name + "-" + language + ".nozomi"
	default:
		return "/n/" + string(tag.Type) + "/" + prefix + name + "-" + language + ".nozomi"
	}
}

func splitTitleTerms(title string) []string {
	title = strings.ToLower(strings.TrimSpace(title))
	if title == "" {
		return nil
	}
	var terms []string
	for _, t := range strings.Fields(title) {
		if t != "" {
			terms = append(terms, t)
		}
	}
	return terms
}

func intersectIDs(base, other map[uint64]struct{}) {
	for id := range base {
		if _, ok := other[id]; !ok {
			delete(base, id)
		}
	}
}

func subtractIDs(base, other map[uint64]struct{}) {
	for id := range other {
		delete(base, id)
	}
}

func idSet(ids []uint64) map[uint64]struct{} {
	m := make(map[uint64]struct{}, len(ids))
	for _, id := range ids {
		if id != 0 {
			m[id] = struct{}{}
		}
	}
	return m
}

func setToIDs(m map[uint64]struct{}) []uint64 {
	out := make([]uint64, 0, len(m))
	for id := range m {
		out = append(out, id)
	}
	return out
}

func paginateIDs(ids []uint64, page domain.Page) []uint64 {
	start := page.Index * page.Size
	if start >= len(ids) {
		return []uint64{}
	}
	end := start + page.Size
	if end > len(ids) {
		end = len(ids)
	}
	out := make([]uint64, end-start)
	copy(out, ids[start:end])
	return out
}

func rangeHeader(page domain.Page) string {
	start, end := page.ByteRange()
	return fmt.Sprintf("bytes=%d-%d", start, end)
}
