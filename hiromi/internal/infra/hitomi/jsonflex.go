package hitomi

import (
	"encoding/json"
	"strconv"
	"strings"
)

type flexID uint64

func (id *flexID) UnmarshalJSON(b []byte) error {
	b = bytesTrim(b)
	if len(b) == 0 || string(b) == "null" {
		*id = 0
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		s = strings.TrimSpace(s)
		if s == "" {
			*id = 0
			return nil
		}
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return err
		}
		*id = flexID(n)
		return nil
	}
	var n uint64
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*id = flexID(n)
	return nil
}

type flag bool

func (f *flag) UnmarshalJSON(b []byte) error {
	b = bytesTrim(b)
	if len(b) == 0 || string(b) == "null" || string(b) == `""` || string(b) == "0" || string(b) == `"0"` || string(b) == "false" {
		*f = false
		return nil
	}
	if string(b) == "1" || string(b) == `"1"` || string(b) == "true" {
		*f = true
		return nil
	}
	var n int
	if err := json.Unmarshal(b, &n); err == nil {
		*f = n != 0
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*f = s != "" && s != "0"
		return nil
	}
	*f = false
	return nil
}

func bytesTrim(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && (b[i] == ' ' || b[i] == '\n' || b[i] == '\r' || b[i] == '\t') {
		i++
	}
	for j > i && (b[j-1] == ' ' || b[j-1] == '\n' || b[j-1] == '\r' || b[j-1] == '\t') {
		j--
	}
	return b[i:j]
}
