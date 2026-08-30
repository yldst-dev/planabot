package domain

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	bareID      = regexp.MustCompile(`^[0-9]{5,12}$`)
	pathID      = regexp.MustCompile(`/(?:galleries|reader|cg|doujinshi|manga|imageset|gamecg|anime)/[^/]*?([0-9]{5,12})(?:\.html)?/?$`)
	anyHitomiID = regexp.MustCompile(`(?:^|/)([0-9]{5,12})(?:\.html)?/?$`)
)

func ParseGalleryID(raw string) (uint64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, ErrInvalidID
	}
	if i := strings.IndexAny(raw, " \n\t"); i >= 0 {
		raw = strings.TrimSpace(raw[:i])
	}
	if bareID.MatchString(raw) {
		id, err := strconv.ParseUint(raw, 10, 64)
		if err != nil || id == 0 {
			return 0, ErrInvalidID
		}
		return id, nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return 0, ErrInvalidID
	}
	host := strings.ToLower(u.Hostname())
	if host != "hitomi.la" && !strings.HasSuffix(host, ".hitomi.la") {
		return 0, ErrInvalidID
	}
	path := u.Path
	if m := pathID.FindStringSubmatch(path); len(m) == 2 {
		id, err := strconv.ParseUint(m[1], 10, 64)
		if err != nil || id == 0 {
			return 0, ErrInvalidID
		}
		return id, nil
	}
	if m := anyHitomiID.FindStringSubmatch(path); len(m) == 2 {
		id, err := strconv.ParseUint(m[1], 10, 64)
		if err != nil || id == 0 {
			return 0, ErrInvalidID
		}
		return id, nil
	}
	return 0, ErrInvalidID
}
