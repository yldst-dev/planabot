package domain

type Sort string

const (
	SortAdded     Sort = "added"
	SortPublished Sort = "published"
	SortRandom    Sort = "random"
	SortToday     Sort = "today"
	SortWeek      Sort = "week"
	SortMonth     Sort = "month"
	SortYear      Sort = "year"
)

func ParseSort(s string) (Sort, error) {
	switch s {
	case "", "added", "date", "index":
		return SortAdded, nil
	case "published", "date_published":
		return SortPublished, nil
	case "random":
		return SortRandom, nil
	case "today", "popular_day", "day":
		return SortToday, nil
	case "week", "popular_week":
		return SortWeek, nil
	case "month", "popular_month":
		return SortMonth, nil
	case "year", "popular_year":
		return SortYear, nil
	default:
		return "", ErrInvalidQuery
	}
}

const (
	DefaultPageSize = 25
	MaxPageSize     = 100
)

type Page struct {
	Index int
	Size  int
}

func NormalizePage(index, size int) Page {
	if index < 0 {
		index = 0
	}
	if size <= 0 {
		size = DefaultPageSize
	}
	if size > MaxPageSize {
		size = MaxPageSize
	}
	return Page{Index: index, Size: size}
}

func (p Page) ByteRange() (start, end int) {
	start = p.Index * p.Size * 4
	end = start + p.Size*4 - 1
	return start, end
}

type ListQuery struct {
	Tags     []Tag
	Title    string
	Language string
	Sort     Sort
	Page     Page
}

type IDPage struct {
	IDs   []uint64
	Total int
	Page  Page
}

type ListResult struct {
	IDs       []uint64
	Galleries []Gallery
	Total     int
	Page      Page
}
