package viewer

import (
	"strings"
	"testing"

	"hiromi/internal/domain"
)

func TestRenderFillsTemplate(t *testing.T) {
	r := New()
	html, err := r.Render(domain.ViewerDocument{
		Title:    "테스트 <작품>",
		Language: "korean",
		Pages: []domain.ViewerPage{
			{Format: domain.FormatWebP, Data: []byte("abc")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := string(html)
	if !strings.Contains(s, "테스트 &lt;작품&gt;") {
		t.Fatal("title")
	}
	if strings.Contains(s, "한국어") || strings.Contains(s, "badge") {
		t.Fatal("lang badge")
	}
	if strings.Contains(s, "__HIROMI_PAGES__") {
		t.Fatal("placeholder left")
	}
	if !strings.Contains(s, "data:image/webp;base64,") {
		t.Fatal("data uri")
	}
	if !strings.Contains(s, "class=\"dark\"") {
		t.Fatal("theme")
	}
}

func TestShrinkFallsBackOnGarbage(t *testing.T) {
	format, data := shrink(domain.FormatWebP, []byte("not-an-image"))
	if format != domain.FormatWebP || string(data) != "not-an-image" {
		t.Fatalf("%s %q", format, data)
	}
}
