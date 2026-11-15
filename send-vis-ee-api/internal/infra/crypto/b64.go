package crypto

import (
	"encoding/base64"
	"strings"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
)

func Encode(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func Decode(s string) ([]byte, error) {
	return domain.DecodeBase64(s)
}

func DecodeNonce(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return Decode(s)
}
