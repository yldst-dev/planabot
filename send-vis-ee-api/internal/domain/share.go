package domain

import (
	"net/url"
	"path"
	"regexp"
	"strings"
)

var fileIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{10,16}$`)

func ValidFileID(id string) bool {
	return fileIDPattern.MatchString(id)
}

type ShareRef struct {
	Host   string
	ID     string
	Secret string
}

func ParseShareURL(raw string) (ShareRef, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ShareRef{}, ErrInvalidURL
	}
	if ValidFileID(raw) {
		return ShareRef{ID: raw}, nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return ShareRef{}, ErrInvalidURL
	}
	secret := strings.TrimPrefix(u.Fragment, "#")
	u.Fragment = ""
	u.RawQuery = ""
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	var id string
	for i, p := range parts {
		if strings.EqualFold(p, "download") && i+1 < len(parts) {
			id = parts[i+1]
			break
		}
	}
	if id == "" && len(parts) == 1 {
		id = parts[0]
	}
	if !ValidFileID(id) {
		return ShareRef{}, ErrInvalidID
	}
	base := *u
	base.Path = ""
	host := strings.TrimRight(base.String(), "/")
	return ShareRef{
		Host:   host,
		ID:     id,
		Secret: secret,
	}, nil
}

func BuildShareURL(host, id, secret string) string {
	host = strings.TrimRight(host, "/")
	u := host + "/download/" + id + "/"
	if secret != "" {
		return u + "#" + secret
	}
	return u
}

func BuildDownloadURL(host, id string) string {
	host = strings.TrimRight(host, "/")
	return host + "/download/" + id + "/"
}

func NormalizeHost(host string) (string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		host = DefaultHost
	}
	u, err := url.Parse(host)
	if err != nil || u.Host == "" {
		return "", ErrInvalidURL
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", ErrInvalidURL
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if u.Path == "/" {
		u.Path = ""
	}
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func WebSocketURL(host string) (string, error) {
	u, err := url.Parse(host)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", ErrInvalidURL
	}
	u.Path = path.Join("/", "api", "ws")
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}
