package viewer

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"hiromi/internal/domain"
)

const viewerMaxHeight = 1280

type toolPaths struct {
	avifenc string
	magick  string
	cwebp   string
}

var lookupTools = sync.OnceValue(func() toolPaths {
	var t toolPaths
	t.avifenc, _ = exec.LookPath("avifenc")
	t.magick, _ = exec.LookPath("magick")
	t.cwebp, _ = exec.LookPath("cwebp")
	return t
})

var encodeTimeout = 2 * time.Minute

func shrink(format domain.ImageFormat, data []byte) (domain.ImageFormat, []byte) {
	tools := lookupTools()
	canAVIF := tools.avifenc != "" && tools.magick != ""
	if len(data) == 0 || (!canAVIF && tools.cwebp == "") {
		return format, data
	}
	ctx, cancel := context.WithTimeout(context.Background(), encodeTimeout)
	defer cancel()
	dir, err := os.MkdirTemp("", "hiromi-view-*")
	if err != nil {
		return format, data
	}
	defer os.RemoveAll(dir)
	in := filepath.Join(dir, "in"+extFor(format))
	if err := os.WriteFile(in, data, 0o600); err != nil {
		return format, data
	}
	if canAVIF {
		if avif, ok := encodeAVIF(ctx, tools, dir, in); ok {
			return domain.FormatAVIF, avif
		}
	}
	if tools.cwebp != "" {
		if webp, ok := encodeWebP(ctx, tools.cwebp, dir, in); ok {
			return domain.FormatWebP, webp
		}
	}
	return format, data
}

func encodeAVIF(ctx context.Context, tools toolPaths, dir, in string) ([]byte, bool) {
	png := filepath.Join(dir, "in.png")
	out := filepath.Join(dir, "out.avif")
	if err := exec.CommandContext(ctx, tools.magick, in, "-resize", "x"+strconv.Itoa(viewerMaxHeight)+">", png).Run(); err != nil {
		return nil, false
	}
	if err := exec.CommandContext(ctx, tools.avifenc, "-s", "8", "-q", "40", png, out).Run(); err != nil {
		return nil, false
	}
	b, err := os.ReadFile(out)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return b, true
}

func encodeWebP(ctx context.Context, cwebp, dir, in string) ([]byte, bool) {
	out := filepath.Join(dir, "out.webp")
	if err := exec.CommandContext(ctx, cwebp, "-quiet", "-resize", "0", strconv.Itoa(viewerMaxHeight), "-q", "70", in, "-o", out).Run(); err != nil {
		return nil, false
	}
	b, err := os.ReadFile(out)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return b, true
}

func extFor(format domain.ImageFormat) string {
	switch format {
	case domain.FormatAVIF:
		return ".avif"
	case domain.FormatJXL:
		return ".jxl"
	default:
		return ".webp"
	}
}
