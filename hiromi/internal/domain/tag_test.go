package domain

import "testing"

func TestParseTagExpression(t *testing.T) {
	tags, err := ParseTagExpression("male:sole_male -female:netorare series:blue_archive language:korean")
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 4 {
		t.Fatalf("len=%d", len(tags))
	}
	if tags[0].Type != TagMale || tags[0].Name != "sole male" || tags[0].Negative {
		t.Fatalf("tag0=%+v", tags[0])
	}
	if tags[1].Type != TagFemale || !tags[1].Negative {
		t.Fatalf("tag1=%+v", tags[1])
	}
	if tags[2].Type != TagSeries || tags[2].Name != "blue archive" {
		t.Fatalf("tag2=%+v", tags[2])
	}
	if tags[3].Type != TagLanguage || tags[3].Name != "korean" {
		t.Fatalf("tag3=%+v", tags[3])
	}
}

func TestNewTagLanguageRejectsUnknown(t *testing.T) {
	if _, err := NewTag(TagLanguage, "klingon", false); err == nil {
		t.Fatal("expected error")
	}
}

func TestTagString(t *testing.T) {
	tag, err := NewTag(TagFemale, "big breasts", true)
	if err != nil {
		t.Fatal(err)
	}
	if tag.String() != "-female:big_breasts" {
		t.Fatalf("got %q", tag.String())
	}
}

func TestParseNameInitial(t *testing.T) {
	v, err := ParseNameInitial("A")
	if err != nil || v != "a" {
		t.Fatalf("got %q %v", v, err)
	}
	v, err = ParseNameInitial("123")
	if err != nil || v != Initial123 {
		t.Fatalf("got %q %v", v, err)
	}
}
