package hitomi

import (
	"context"
	"fmt"
	"strconv"

	"hiromi/internal/domain"
)

func (c *Client) ImageURL(ctx context.Context, hash string, format domain.ImageFormat) (string, error) {
	if !format.Valid() {
		return "", domain.ErrUnavailableFormat
	}
	code, err := hashCode(hash)
	if err != nil {
		return "", err
	}
	r, err := c.routing(ctx)
	if err != nil {
		return "", err
	}
	sub := string(format[0]) + strconv.Itoa(r.subdomainNum(code))
	return fmt.Sprintf("https://%s.%s/%s/%d/%s.%s", sub, c.cfg.CDN, r.basePath, code, hash, format), nil
}

func (c *Client) ThumbnailURL(hash string, format domain.ImageFormat, size domain.ThumbSize) (string, error) {
	if !format.Valid() {
		return "", domain.ErrUnavailableFormat
	}
	if !size.Valid() || size == domain.ThumbNone {
		return "", domain.ErrUnavailableThumb
	}
	dir, err := thumbDir(hash)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("https://tn.%s/%s%stn/%s/%s.%s", c.cfg.CDN, format, size, dir, hash, format), nil
}

func (c *Client) ResolveFile(ctx context.Context, file *domain.File) error {
	if file == nil || file.Hash == "" {
		return nil
	}
	var err error
	if file.HasWebP {
		file.URLs.WebP, err = c.ImageURL(ctx, file.Hash, domain.FormatWebP)
		if err != nil {
			return err
		}
		file.URLs.ThumbSmallWebP, _ = c.ThumbnailURL(file.Hash, domain.FormatWebP, domain.ThumbSmall)
		if file.HasThumb {
			file.URLs.ThumbBigWebP, _ = c.ThumbnailURL(file.Hash, domain.FormatWebP, domain.ThumbBig)
		}
	}
	if file.HasAVIF {
		file.URLs.AVIF, err = c.ImageURL(ctx, file.Hash, domain.FormatAVIF)
		if err != nil {
			return err
		}
		file.URLs.ThumbSmallAVIF, _ = c.ThumbnailURL(file.Hash, domain.FormatAVIF, domain.ThumbSmall)
		if file.HasThumb {
			file.URLs.ThumbMediumAVIF, _ = c.ThumbnailURL(file.Hash, domain.FormatAVIF, domain.ThumbMedium)
			file.URLs.ThumbBigAVIF, _ = c.ThumbnailURL(file.Hash, domain.FormatAVIF, domain.ThumbBig)
		}
	}
	if file.HasJXL {
		file.URLs.JXL, err = c.ImageURL(ctx, file.Hash, domain.FormatJXL)
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) ResolveVideo(video *domain.Video) {
	if video == nil {
		return
	}
	if video.FileName != "" {
		video.URL = fmt.Sprintf("https://streaming.%s/videos/%s", c.cfg.CDN, video.FileName)
	}
}

func (c *Client) posterURL(hash string) string {
	dir, err := thumbDir(hash)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("https://a.%s/videos/posters/%s/%s.webp", c.cfg.CDN, dir, hash)
}

func (c *Client) absolute(path string) string {
	if path == "" {
		return ""
	}
	if len(path) >= 4 && (path[:4] == "http") {
		return path
	}
	if path[0] != '/' {
		path = "/" + path
	}
	return c.cfg.Front + path
}
