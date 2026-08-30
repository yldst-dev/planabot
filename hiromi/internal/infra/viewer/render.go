package viewer

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"html"
	"strings"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

//go:embed template.html
var rawTemplate string

type Renderer struct{}

func New() *Renderer {
	return &Renderer{}
}

func (r *Renderer) Render(doc domain.ViewerDocument) ([]byte, error) {
	uris := make([]string, 0, len(doc.Pages))
	for _, page := range doc.Pages {
		if len(page.Data) == 0 {
			continue
		}
		format, data := shrink(page.Format, page.Data)
		uris = append(uris, dataURI(format, data))
	}
	pagesJSON, err := json.Marshal(uris)
	if err != nil {
		return nil, err
	}
	title := html.EscapeString(doc.Title)
	out := rawTemplate
	out = strings.ReplaceAll(out, "__HIROMI_TITLE__", title)
	out = strings.Replace(out, "__HIROMI_PAGES__", string(pagesJSON), 1)
	return []byte(out), nil
}

func dataURI(format domain.ImageFormat, data []byte) string {
	mime := "image/webp"
	switch format {
	case domain.FormatAVIF:
		mime = "image/avif"
	case domain.FormatJXL:
		mime = "image/jxl"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

var _ port.ViewerRenderer = (*Renderer)(nil)
