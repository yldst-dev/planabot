package viewer

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"hiromi/internal/domain"
)

const viewerMaxHeight = 1280

func shrink(format domain.ImageFormat, data []byte) (domain.ImageFormat, []byte) {
	if len(data) == 0 {
		return format, data
	}
	dir, err := os.MkdirTemp("", "hiromi-view-*")
	if err != nil {
		return format, data
	}
	defer os.RemoveAll(dir)
	in := filepath.Join(dir, "in"+extFor(format))
	if err := os.WriteFile(in, data, 0o600); err != nil {
		return format, data
	}
	if avif, ok := encodeAVIF(dir, in); ok {
		return domain.FormatAVIF, avif
	}
	if webp, ok := encodeWebP(dir, in); ok {
		return domain.FormatWebP, webp
	}
	return format, data
}

func encodeAVIF(dir, in string) ([]byte, bool) {
	avifenc, err1 := exec.LookPath("avifenc")
	magick, err2 := exec.LookPath("magick")
	if err1 != nil || err2 != nil {
		return nil, false
	}
	png := filepath.Join(dir, "in.png")
	out := filepath.Join(dir, "out.avif")
	if err := exec.Command(magick, in, "-resize", "x"+strconv.Itoa(viewerMaxHeight)+">", png).Run(); err != nil {
		return nil, false
	}
	if err := exec.Command(avifenc, "-s", "8", "-q", "40", png, out).Run(); err != nil {
		return nil, false
	}
	b, err := os.ReadFile(out)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return b, true
}

func encodeWebP(dir, in string) ([]byte, bool) {
	cwebp, err := exec.LookPath("cwebp")
	if err != nil {
		return nil, false
	}
	out := filepath.Join(dir, "out.webp")
	if err := exec.Command(cwebp, "-quiet", "-resize", "0", strconv.Itoa(viewerMaxHeight), "-q", "70", in, "-o", out).Run(); err != nil {
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
