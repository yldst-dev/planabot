package viewer

import (
	_ "embed"
	"encoding/base64"
	"html"
	"io"
	"strings"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

//go:embed template.html
var rawTemplate string

var templateHead, templateTail, _ = strings.Cut(rawTemplate, "__HIROMI_PAGES__")

type Renderer struct{}

func New() *Renderer {
	return &Renderer{}
}

func (r *Renderer) Render(w io.Writer, doc domain.ViewerDocument) error {
	title := strings.NewReplacer("__HIROMI_TITLE__", html.EscapeString(doc.Title))
	if _, err := title.WriteString(w, templateHead+"["); err != nil {
		return err
	}
	separator := ""
	for _, page := range doc.Pages {
		data, err := page.Load()
		if err != nil {
			return err
		}
		if len(data) == 0 {
			continue
		}
		format, data := shrink(page.Format, data)
		if _, err := io.WriteString(w, separator+`"data:`+mimeType(format)+";base64,"); err != nil {
			return err
		}
		encoder := base64.NewEncoder(base64.StdEncoding, w)
		if _, err := encoder.Write(data); err != nil {
			return err
		}
		if err := encoder.Close(); err != nil {
			return err
		}
		if _, err := io.WriteString(w, `"`); err != nil {
			return err
		}
		separator = ","
	}
	_, err := title.WriteString(w, "]"+templateTail)
	return err
}

func mimeType(format domain.ImageFormat) string {
	switch format {
	case domain.FormatAVIF:
		return "image/avif"
	case domain.FormatJXL:
		return "image/jxl"
	}
	return "image/webp"
}

var _ port.ViewerRenderer = (*Renderer)(nil)
