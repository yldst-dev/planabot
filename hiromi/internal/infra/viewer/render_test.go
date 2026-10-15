package viewer

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"hiromi/internal/domain"
)

func page(format domain.ImageFormat, data string) domain.ViewerPage {
	return domain.ViewerPage{Format: format, Load: func() ([]byte, error) { return []byte(data), nil }}
}

func render(t *testing.T, doc domain.ViewerDocument) string {
	t.Helper()
	var out bytes.Buffer
	if err := New().Render(&out, doc); err != nil {
		t.Fatal(err)
	}
	return out.String()
}

func TestRenderFillsTemplate(t *testing.T) {
	s := render(t, domain.ViewerDocument{
		Title:    "테스트 <작품>",
		Language: "korean",
		Pages:    []domain.ViewerPage{page(domain.FormatWebP, "abc")},
	})
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

func TestRenderStreamsPagesAsJSONAndIgnoresPlaceholderInTitle(t *testing.T) {
	s := render(t, domain.ViewerDocument{
		Title: "__HIROMI_PAGES__ 제목",
		Pages: []domain.ViewerPage{page(domain.FormatWebP, "one"), page(domain.FormatAVIF, ""), page(domain.FormatAVIF, "two")},
	})
	start := strings.Index(s, "const pages = ")
	end := strings.Index(s[start:], "];")
	if start < 0 || end < 0 {
		t.Fatal("pages script missing")
	}
	var uris []string
	if err := json.Unmarshal([]byte(s[start+len("const pages = "):start+end+1]), &uris); err != nil {
		t.Fatalf("pages json %v", err)
	}
	if len(uris) != 2 || !strings.HasPrefix(uris[0], "data:image/webp;base64,") {
		t.Fatalf("uris %q", uris)
	}
	if !strings.Contains(s, "<title>__HIROMI_PAGES__ 제목</title>") {
		t.Fatal("title should stay literal")
	}
}
