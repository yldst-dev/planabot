package domain

import "testing"

func TestParseGalleryID(t *testing.T) {
	cases := []struct {
		in  string
		id  uint64
		err bool
	}{
		{"1234567", 1234567, false},
		{"  1234567  ", 1234567, false},
		{"https://hitomi.la/galleries/1234567.html", 1234567, false},
		{"https://hitomi.la/reader/1234567.html", 1234567, false},
		{"https://hitomi.la/manga/sample-title-1234567.html", 1234567, false},
		{"https://hitomi.la/doujinshi/foo-4106847.html", 4106847, false},
		{"not-an-id", 0, true},
		{"https://example.com/1234567", 0, true},
		{"12", 0, true},
	}
	for _, tc := range cases {
		id, err := ParseGalleryID(tc.in)
		if tc.err {
			if err == nil {
				t.Fatalf("%q: expected error", tc.in)
			}
			continue
		}
		if err != nil || id != tc.id {
			t.Fatalf("%q: id=%d err=%v", tc.in, id, err)
		}
	}
}
