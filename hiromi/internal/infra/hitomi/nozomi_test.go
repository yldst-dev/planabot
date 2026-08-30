package hitomi

import (
	"encoding/binary"
	"testing"

	"hiromi/internal/domain"
)

func TestDecodeNozomi(t *testing.T) {
	buf := make([]byte, 12)
	binary.BigEndian.PutUint32(buf[0:], 4154840)
	binary.BigEndian.PutUint32(buf[4:], 4154839)
	binary.BigEndian.PutUint32(buf[8:], 123)
	ids := decodeNozomi(buf)
	if len(ids) != 3 || ids[0] != 4154840 || ids[2] != 123 {
		t.Fatalf("%v", ids)
	}
}

func TestParseContentRangeTotal(t *testing.T) {
	n := parseContentRangeTotal("bytes 0-31/4801896")
	if n != 1200474 {
		t.Fatalf("got %d", n)
	}
}

func TestNozomiPath(t *testing.T) {
	female, err := domain.NewTag(domain.TagFemale, "ahegao", false)
	if err != nil {
		t.Fatal(err)
	}
	artist, err := domain.NewTag(domain.TagArtist, "aoi hitori", false)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		tag  *domain.Tag
		lang string
		sort domain.Sort
		want string
	}{
		{nil, "all", domain.SortAdded, "/n/index-all.nozomi"},
		{nil, "korean", domain.SortToday, "/n/popular/today-korean.nozomi"},
		{&female, "all", domain.SortAdded, "/n/tag/female:ahegao-all.nozomi"},
		{&female, "all", domain.SortToday, "/n/tag/popular/today/female:ahegao-all.nozomi"},
		{&artist, "all", domain.SortAdded, "/n/artist/aoi%20hitori-all.nozomi"},
	}
	for _, c := range cases {
		got := nozomiPath(c.tag, c.lang, c.sort)
		if got != c.want {
			t.Fatalf("%q != %q", got, c.want)
		}
	}
}

func TestIntersectSubtract(t *testing.T) {
	a := idSet([]uint64{1, 2, 3, 4})
	intersectIDs(a, idSet([]uint64{2, 3, 9}))
	subtractIDs(a, idSet([]uint64{3}))
	ids := setToIDs(a)
	if len(ids) != 1 || ids[0] != 2 {
		t.Fatalf("%v", ids)
	}
}
