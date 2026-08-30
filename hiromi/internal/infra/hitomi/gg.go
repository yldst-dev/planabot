package hitomi

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"hiromi/internal/domain"
)

type routing struct {
	cases      map[int]int
	defaultVal int
	basePath   string
}

var (
	reCase     = regexp.MustCompile(`case\s+(\d+):(?:\s*o\s*=\s*(\d+))?`)
	reIfG      = regexp.MustCompile(`if\s+\(g\s*===?\s*(\d+)\)[\s{]*o\s*=\s*(\d+)`)
	reDefaultO = regexp.MustCompile(`(?:var\s|default:)\s*o\s*=\s*(\d+)`)
	reB        = regexp.MustCompile(`b:\s*['"]([^'"]+)['"]`)
)

func parseGG(src string) (*routing, error) {
	r := &routing{cases: map[int]int{}}
	keys := make([]int, 0, 64)
	for _, m := range reCase.FindAllStringSubmatch(src, -1) {
		key, err := strconv.Atoi(m[1])
		if err != nil {
			return nil, fmt.Errorf("%w: case key", domain.ErrUnparsableScript)
		}
		keys = append(keys, key)
		if m[2] != "" {
			val, err := strconv.Atoi(m[2])
			if err != nil {
				return nil, fmt.Errorf("%w: case value", domain.ErrUnparsableScript)
			}
			for _, k := range keys {
				r.cases[k] = val
			}
			keys = keys[:0]
		}
	}
	for _, m := range reIfG.FindAllStringSubmatch(src, -1) {
		key, err := strconv.Atoi(m[1])
		if err != nil {
			return nil, fmt.Errorf("%w: if key", domain.ErrUnparsableScript)
		}
		val, err := strconv.Atoi(m[2])
		if err != nil {
			return nil, fmt.Errorf("%w: if value", domain.ErrUnparsableScript)
		}
		r.cases[key] = val
	}
	if m := reDefaultO.FindStringSubmatch(src); len(m) == 2 {
		v, err := strconv.Atoi(m[1])
		if err != nil {
			return nil, fmt.Errorf("%w: default o", domain.ErrUnparsableScript)
		}
		r.defaultVal = v
	}
	if m := reB.FindStringSubmatch(src); len(m) == 2 {
		r.basePath = strings.Trim(m[1], "/")
	}
	if r.basePath == "" || len(r.cases) == 0 {
		return nil, domain.ErrUnparsableScript
	}
	return r, nil
}

func (r *routing) subdomainNum(hashCode int) int {
	if v, ok := r.cases[hashCode]; ok {
		return v + 1
	}
	return r.defaultVal + 1
}

func hashCode(hash string) (int, error) {
	if len(hash) < 3 {
		return 0, domain.ErrInvalidQuery
	}
	s := hash[len(hash)-1:] + hash[len(hash)-3:len(hash)-1]
	n, err := strconv.ParseInt(s, 16, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: hash", domain.ErrInvalidQuery)
	}
	return int(n), nil
}

func thumbDir(hash string) (string, error) {
	if len(hash) < 3 {
		return "", domain.ErrInvalidQuery
	}
	return hash[len(hash)-1:] + "/" + hash[len(hash)-3:len(hash)-1], nil
}
