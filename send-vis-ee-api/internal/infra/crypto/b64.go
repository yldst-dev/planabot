package crypto

import (
	"encoding/base64"
	"strings"
)

func Encode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func Decode(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	encodings := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.StdEncoding,
		base64.RawStdEncoding,
	}
	var last error
	for _, enc := range encodings {
		out, err := enc.DecodeString(s)
		if err == nil {
			return out, nil
		}
		last = err
	}
	return nil, last
}

func DecodeNonce(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return Decode(s)
}
