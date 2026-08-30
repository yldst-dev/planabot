package hitomi

import (
	"context"
	"encoding/json"
	"fmt"

	"hiromi/internal/domain"
)

func (c *Client) GetByID(ctx context.Context, id uint64) (*domain.Gallery, error) {
	if id == 0 {
		return nil, domain.ErrInvalidID
	}
	body, _, _, err := c.getBytes(ctx, c.ltnURL(fmt.Sprintf("/galleries/%d.js", id)), "", "")
	if err != nil {
		return nil, err
	}
	var raw rawGallery
	if err := json.Unmarshal(stripGalleryJS(body), &raw); err != nil {
		return nil, fmt.Errorf("%w: gallery json: %v", domain.ErrRemote, err)
	}
	g := raw.toDomain()
	if g.ID == 0 {
		g.ID = id
	}
	if g.ReaderPath == "" {
		g.ReaderPath = fmt.Sprintf("/reader/%d.html", g.ID)
	}
	for i := range g.Files {
		if err := c.ResolveFile(ctx, &g.Files[i]); err != nil {
			return nil, err
		}
	}
	if g.Video != nil {
		c.ResolveVideo(g.Video)
		if g.Video.PosterURL == "" {
			hash := ""
			if len(g.Files) > 1 {
				hash = g.Files[1].Hash
			} else if len(g.Files) == 1 {
				hash = g.Files[0].Hash
			}
			if hash != "" {
				g.Video.PosterURL = c.posterURL(hash)
			}
		}
	}
	return g, nil
}
