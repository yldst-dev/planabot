package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"hiromi/internal/domain"
	"hiromi/internal/usecase"
)

type Handler struct {
	front     string
	galleries *usecase.GalleryService
	tags      *usecase.TagService
	media     *usecase.MediaService
	catalog   *usecase.CatalogService
	downloads *usecase.DownloadService
}

func NewHandler(front string, g *usecase.GalleryService, t *usecase.TagService, m *usecase.MediaService, c *usecase.CatalogService, d *usecase.DownloadService) *Handler {
	return &Handler{front: strings.TrimRight(front, "/"), galleries: g, tags: t, media: m, catalog: c, downloads: d}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, healthDTO{Status: "ok"})
}

func (h *Handler) GetGallery(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	g, err := h.galleries.Get(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.galleryDTO(*g))
}

func (h *Handler) GetFiles(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	g, err := h.galleries.Get(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":         g.ID,
		"page_count": g.PageCount(),
		"files":      h.filesDTO(g.Files),
	})
}

func (h *Handler) GetFile(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		writeError(w, domain.ErrInvalidQuery)
		return
	}
	g, file, err := h.galleries.File(r.Context(), id, index)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"gallery_id": g.ID,
		"file":       h.fileDTO(*file),
	})
}

func (h *Handler) GetRelated(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := h.galleries.Related(r.Context(), id, boolQuery(r, "embed"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.listDTO(res))
}

func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	q, err := h.parseListQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := h.galleries.List(r.Context(), q, boolQuery(r, "embed"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.listDTO(res))
}

func (h *Handler) Index(w http.ResponseWriter, r *http.Request) {
	h.Search(w, r)
}

func (h *Handler) ListTags(w http.ResponseWriter, r *http.Request) {
	typ := domain.TagType(r.URL.Query().Get("type"))
	if typ == "" {
		writeError(w, domain.ErrInvalidQuery)
		return
	}
	var initial domain.NameInitial
	if s := r.URL.Query().Get("starts_with"); s != "" {
		var err error
		initial, err = domain.ParseNameInitial(s)
		if err != nil {
			writeError(w, err)
			return
		}
	}
	tags, err := h.tags.List(r.Context(), typ, initial)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": h.tagsDTO(tags)})
}

func (h *Handler) SearchTags(w http.ResponseWriter, r *http.Request) {
	term := strings.TrimSpace(r.URL.Query().Get("q"))
	rows, err := h.tags.Search(r.Context(), term)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]tagCountDTO, 0, len(rows))
	for _, row := range rows {
		out = append(out, tagCountDTO{Tag: h.tagDTO(row.Tag), Count: row.Count})
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": out})
}

func (h *Handler) TagLanguages(w http.ResponseWriter, r *http.Request) {
	typ := domain.TagType(r.PathValue("type"))
	name, _ := url.PathUnescape(r.PathValue("name"))
	langs, err := h.tags.Languages(r.Context(), typ, name)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]languageDTO, 0, len(langs))
	for _, lang := range langs {
		out = append(out, h.languageDTO(lang))
	}
	writeJSON(w, http.StatusOK, map[string]any{"languages": out})
}

func (h *Handler) Languages(w http.ResponseWriter, r *http.Request) {
	langs := h.catalog.Languages()
	out := make([]languageDTO, 0, len(langs))
	for _, lang := range langs {
		out = append(out, h.languageDTO(lang))
	}
	writeJSON(w, http.StatusOK, map[string]any{"languages": out})
}

func (h *Handler) Types(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"gallery_types": h.catalog.Types(),
		"tag_types":     h.catalog.TagTypes(),
		"sorts":         h.catalog.Sorts(),
	})
}

func (h *Handler) ResolveMedia(w http.ResponseWriter, r *http.Request) {
	hash := strings.TrimSpace(r.URL.Query().Get("hash"))
	if hash == "" {
		writeError(w, domain.ErrInvalidQuery)
		return
	}
	format, err := domain.ParseImageFormat(r.URL.Query().Get("format"))
	if err != nil {
		writeError(w, err)
		return
	}
	thumb, err := domain.ParseThumbSize(r.URL.Query().Get("thumb"))
	if err != nil {
		writeError(w, err)
		return
	}
	rawURL, err := h.media.Resolve(r.Context(), hash, format, thumb)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": rawURL, "hash": hash, "format": format, "thumb": thumb})
}

func (h *Handler) ProxyFile(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil {
		writeError(w, domain.ErrInvalidQuery)
		return
	}
	format, err := domain.ParseImageFormat(r.URL.Query().Get("format"))
	if err != nil {
		writeError(w, err)
		return
	}
	thumb, err := domain.ParseThumbSize(r.URL.Query().Get("thumb"))
	if err != nil {
		writeError(w, err)
		return
	}
	body, contentType, err := h.media.OpenFile(r.Context(), id, index, format, thumb)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		writeError(w, err)
		return
	}
	defer body.Close()
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}

func (h *Handler) DownloadGallery(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	opt, err := parseDownloadOptions(r)
	if err != nil {
		writeError(w, err)
		return
	}
	res, err := h.downloads.Download(r.Context(), id, opt)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, downloadDTOFrom(res))
}

func (h *Handler) DownloadMany(w http.ResponseWriter, r *http.Request) {
	opt, err := parseDownloadOptions(r)
	if err != nil {
		writeError(w, err)
		return
	}
	var ids []uint64
	if r.Method == http.MethodPost && r.Body != nil {
		var body struct {
			IDs    []uint64 `json:"ids"`
			Format string   `json:"format"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil && err != io.EOF {
			writeError(w, domain.ErrInvalidQuery)
			return
		}
		ids = body.IDs
		if body.Format != "" {
			format, err := domain.ParseImageFormat(body.Format)
			if err != nil {
				writeError(w, err)
				return
			}
			opt.Format = format
		}
	}
	if len(ids) == 0 {
		if s := r.URL.Query().Get("ids"); s != "" {
			for _, part := range strings.Split(s, ",") {
				id, err := parseID(strings.TrimSpace(part))
				if err != nil {
					writeError(w, err)
					return
				}
				ids = append(ids, id)
			}
		}
	}
	res, err := h.downloads.DownloadMany(r.Context(), ids, opt)
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]galleryDownloadDTO, 0, len(res))
	for i := range res {
		out = append(out, downloadDTOFrom(&res[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"downloads": out})
}

func parseDownloadOptions(r *http.Request) (domain.DownloadOptions, error) {
	opt := domain.DefaultDownloadOptions()
	format, err := domain.ParseImageFormat(r.URL.Query().Get("format"))
	if err != nil {
		return opt, err
	}
	opt.Format = format
	if s := r.URL.Query().Get("workers"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil {
			return opt, domain.ErrInvalidQuery
		}
		opt.Workers = n
	}
	if r.URL.Query().Has("video") {
		opt.IncludeVideo = boolQuery(r, "video")
	}
	if r.URL.Query().Has("skip") {
		opt.SkipExisting = boolQuery(r, "skip")
	}
	return opt.Normalize(), nil
}

func (h *Handler) parseListQuery(r *http.Request) (domain.ListQuery, error) {
	q := r.URL.Query()
	sort, err := domain.ParseSort(q.Get("sort"))
	if err != nil {
		return domain.ListQuery{}, err
	}
	page := 0
	if s := q.Get("page"); s != "" {
		page, err = strconv.Atoi(s)
		if err != nil {
			return domain.ListQuery{}, domain.ErrInvalidQuery
		}
	}
	size := domain.DefaultPageSize
	if s := q.Get("size"); s != "" {
		size, err = strconv.Atoi(s)
		if err != nil {
			return domain.ListQuery{}, domain.ErrInvalidQuery
		}
	}
	var tags []domain.Tag
	if expr := strings.TrimSpace(q.Get("q")); expr != "" {
		tags, err = domain.ParseTagExpression(expr)
		if err != nil {
			return domain.ListQuery{}, err
		}
	}
	if typ := q.Get("type"); typ != "" {
		tag, err := domain.NewTag(domain.TagTypeKind, typ, false)
		if err != nil {
			return domain.ListQuery{}, err
		}
		tags = append(tags, tag)
	}
	if artist := q.Get("artist"); artist != "" {
		tag, err := domain.NewTag(domain.TagArtist, artist, false)
		if err != nil {
			return domain.ListQuery{}, err
		}
		tags = append(tags, tag)
	}
	if series := q.Get("series"); series != "" {
		tag, err := domain.NewTag(domain.TagSeries, series, false)
		if err != nil {
			return domain.ListQuery{}, err
		}
		tags = append(tags, tag)
	}
	if character := q.Get("character"); character != "" {
		tag, err := domain.NewTag(domain.TagCharacter, character, false)
		if err != nil {
			return domain.ListQuery{}, err
		}
		tags = append(tags, tag)
	}
	if group := q.Get("group"); group != "" {
		tag, err := domain.NewTag(domain.TagGroup, group, false)
		if err != nil {
			return domain.ListQuery{}, err
		}
		tags = append(tags, tag)
	}
	if tagName := q.Get("tag"); tagName != "" {
		parsed, err := domain.ParseTagExpression(tagName)
		if err != nil {
			return domain.ListQuery{}, err
		}
		if len(parsed) == 0 {
			t, err := domain.NewTag(domain.TagGeneric, tagName, false)
			if err != nil {
				return domain.ListQuery{}, err
			}
			tags = append(tags, t)
		} else {
			tags = append(tags, parsed...)
		}
	}
	return domain.ListQuery{
		Tags:     tags,
		Title:    strings.TrimSpace(q.Get("title")),
		Language: strings.TrimSpace(q.Get("language")),
		Sort:     sort,
		Page:     domain.NormalizePage(page, size),
	}, nil
}

func parseID(s string) (uint64, error) {
	id, err := strconv.ParseUint(s, 10, 64)
	if err != nil || id == 0 {
		return 0, domain.ErrInvalidID
	}
	return id, nil
}

func boolQuery(r *http.Request, key string) bool {
	v := strings.ToLower(r.URL.Query().Get(key))
	return v == "1" || v == "true" || v == "yes"
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	msg := err.Error()
	switch {
	case errors.Is(err, domain.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, domain.ErrInvalidID), errors.Is(err, domain.ErrInvalidQuery), errors.Is(err, domain.ErrInvalidTag), errors.Is(err, domain.ErrUnavailableFormat), errors.Is(err, domain.ErrUnavailableThumb):
		status = http.StatusBadRequest
	case errors.Is(err, domain.ErrStorage):
		status = http.StatusInternalServerError
	case errors.Is(err, domain.ErrRemote), errors.Is(err, domain.ErrUnparsableScript), errors.Is(err, domain.ErrEmptyIndex):
		status = http.StatusBadGateway
	}
	writeJSON(w, status, errorDTO{Error: msg})
}
