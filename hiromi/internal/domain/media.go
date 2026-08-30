package domain

type ImageFormat string

const (
	FormatWebP ImageFormat = "webp"
	FormatAVIF ImageFormat = "avif"
	FormatJXL  ImageFormat = "jxl"
)

func (f ImageFormat) Valid() bool {
	switch f {
	case FormatWebP, FormatAVIF, FormatJXL:
		return true
	default:
		return false
	}
}

func ParseImageFormat(s string) (ImageFormat, error) {
	if s == "" {
		return FormatWebP, nil
	}
	f := ImageFormat(s)
	if !f.Valid() {
		return "", ErrUnavailableFormat
	}
	return f, nil
}

type ThumbSize string

const (
	ThumbNone   ThumbSize = ""
	ThumbSmall  ThumbSize = "small"
	ThumbMedium ThumbSize = "smallbig"
	ThumbBig    ThumbSize = "big"
)

func (s ThumbSize) Valid() bool {
	switch s {
	case ThumbNone, ThumbSmall, ThumbMedium, ThumbBig:
		return true
	default:
		return false
	}
}

func ParseThumbSize(s string) (ThumbSize, error) {
	switch s {
	case "", "none", "full":
		return ThumbNone, nil
	case "small":
		return ThumbSmall, nil
	case "medium", "smallbig":
		return ThumbMedium, nil
	case "big":
		return ThumbBig, nil
	default:
		return "", ErrUnavailableThumb
	}
}

type File struct {
	Index    int
	Name     string
	Hash     string
	Width    int
	Height   int
	HasWebP  bool
	HasAVIF  bool
	HasJXL   bool
	HasThumb bool
	URLs     FileURLs
}

func (f File) Supports(format ImageFormat) bool {
	switch format {
	case FormatWebP:
		return f.HasWebP
	case FormatAVIF:
		return f.HasAVIF
	case FormatJXL:
		return f.HasJXL
	default:
		return false
	}
}

func (f File) ChooseFormat(want ImageFormat) (ImageFormat, error) {
	if want == "" {
		want = FormatWebP
	}
	candidates := []ImageFormat{want, FormatWebP, FormatAVIF, FormatJXL}
	seen := map[ImageFormat]struct{}{}
	for _, c := range candidates {
		if _, ok := seen[c]; ok {
			continue
		}
		seen[c] = struct{}{}
		if f.Supports(c) {
			return c, nil
		}
	}
	return "", ErrUnavailableFormat
}

func (f File) URLFor(format ImageFormat) string {
	switch format {
	case FormatWebP:
		return f.URLs.WebP
	case FormatAVIF:
		return f.URLs.AVIF
	case FormatJXL:
		return f.URLs.JXL
	default:
		return ""
	}
}

type FileURLs struct {
	WebP            string
	AVIF            string
	JXL             string
	ThumbSmallWebP  string
	ThumbSmallAVIF  string
	ThumbMediumAVIF string
	ThumbBigWebP    string
	ThumbBigAVIF    string
}

type Video struct {
	FileName  string
	Width     int
	Height    int
	URL       string
	PosterURL string
}

type MediaRequest struct {
	Hash   string
	Format ImageFormat
	Thumb  ThumbSize
}
