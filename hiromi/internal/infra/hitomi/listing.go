package hitomi

import (
	"context"
	"math/rand/v2"
	"sort"

	"hiromi/internal/domain"
)

func (c *Client) ListIDs(ctx context.Context, q domain.ListQuery) (*domain.IDPage, error) {
	q.Page = domain.NormalizePage(q.Page.Index, q.Page.Size)
	tags := append([]domain.Tag(nil), q.Tags...)
	sort.SliceStable(tags, func(i, j int) bool {
		if tags[i].Negative != tags[j].Negative {
			return !tags[i].Negative
		}
		return false
	})
	language := q.Language
	var positives []domain.Tag
	var negatives []domain.Tag
	for _, t := range tags {
		if t.Type == domain.TagLanguage {
			if !t.Negative {
				language = t.Name
			}
			continue
		}
		if t.Negative {
			negatives = append(negatives, t)
		} else {
			positives = append(positives, t)
		}
	}
	titleTerms := splitTitleTerms(q.Title)
	canRange := len(titleTerms) == 0 && len(negatives) == 0 && len(positives) <= 1
	if canRange {
		var tag *domain.Tag
		if len(positives) == 1 {
			tag = &positives[0]
		}
		ids, total, err := c.fetchNozomi(ctx, nozomiPath(tag, language, q.Sort), rangeHeader(q.Page))
		if err != nil {
			return nil, err
		}
		if q.Sort == domain.SortRandom {
			rand.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
		}
		return &domain.IDPage{IDs: ids, Total: total, Page: q.Page}, nil
	}
	var base map[uint64]struct{}
	if len(positives) == 0 {
		ids, _, err := c.fetchNozomi(ctx, nozomiPath(nil, language, q.Sort), "")
		if err != nil {
			return nil, err
		}
		base = idSet(ids)
	} else {
		ids, _, err := c.fetchNozomi(ctx, nozomiPath(&positives[0], language, q.Sort), "")
		if err != nil {
			return nil, err
		}
		base = idSet(ids)
		for i := 1; i < len(positives); i++ {
			if len(base) == 0 {
				break
			}
			ids, _, err := c.fetchNozomi(ctx, nozomiPath(&positives[i], language, domain.SortAdded), "")
			if err != nil {
				return nil, err
			}
			intersectIDs(base, idSet(ids))
		}
	}
	for i := range negatives {
		if len(base) == 0 {
			break
		}
		ids, _, err := c.fetchNozomi(ctx, nozomiPath(&negatives[i], language, domain.SortAdded), "")
		if err != nil {
			return nil, err
		}
		subtractIDs(base, idSet(ids))
	}
	if len(titleTerms) > 0 {
		titleIDs, err := c.SearchTitle(ctx, titleTerms)
		if err != nil {
			return nil, err
		}
		if base == nil {
			base = idSet(titleIDs)
		} else {
			intersectIDs(base, idSet(titleIDs))
		}
	}
	ids := setToIDs(base)
	sort.Slice(ids, func(i, j int) bool { return ids[i] > ids[j] })
	if q.Sort == domain.SortRandom {
		rand.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
	}
	total := len(ids)
	return &domain.IDPage{IDs: paginateIDs(ids, q.Page), Total: total, Page: q.Page}, nil
}

func (c *Client) fetchNozomi(ctx context.Context, path, byteRange string) ([]uint64, int, error) {
	body, header, _, err := c.getBytes(ctx, c.ltnURL(path), byteRange, "")
	if err != nil {
		return nil, 0, err
	}
	ids := decodeNozomi(body)
	total := parseContentRangeTotal(header.Get("Content-Range"))
	if total == 0 {
		total = len(ids)
	}
	return ids, total, nil
}
