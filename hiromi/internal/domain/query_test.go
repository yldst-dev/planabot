package domain

import "testing"

func TestParseSort(t *testing.T) {
	cases := map[string]Sort{
		"":          SortAdded,
		"added":     SortAdded,
		"published": SortPublished,
		"today":     SortToday,
		"week":      SortWeek,
		"month":     SortMonth,
		"year":      SortYear,
		"random":    SortRandom,
	}
	for in, want := range cases {
		got, err := ParseSort(in)
		if err != nil || got != want {
			t.Fatalf("%q -> %q %v", in, got, err)
		}
	}
	if _, err := ParseSort("nope"); err == nil {
		t.Fatal("expected error")
	}
}

func TestNormalizePage(t *testing.T) {
	p := NormalizePage(-1, 0)
	if p.Index != 0 || p.Size != DefaultPageSize {
		t.Fatalf("%+v", p)
	}
	p = NormalizePage(2, 1000)
	if p.Size != MaxPageSize {
		t.Fatalf("%+v", p)
	}
	start, end := p.ByteRange()
	if start != 2*MaxPageSize*4 || end != start+MaxPageSize*4-1 {
		t.Fatalf("range %d-%d", start, end)
	}
}
