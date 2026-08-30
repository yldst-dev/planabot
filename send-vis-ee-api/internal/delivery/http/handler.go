package rest

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

type Handler struct {
	svc  *usecase.Service
	host string
}

func NewHandler(svc *usecase.Service, host string) *Handler {
	return &Handler{svc: svc, host: host}
}

func (h *Handler) Health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) Instance(w http.ResponseWriter, r *http.Request) {
	inst, err := h.svc.Instance(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toInstance(h.host, inst))
}

func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	in, closer, err := parseUpload(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if closer != nil {
		defer closer.Close()
	}
	file, err := h.svc.Upload(r.Context(), in)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toFileBody(file))
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	files, err := h.svc.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	out := make([]fileBody, 0, len(files))
	for _, f := range files {
		out = append(out, toFileBody(f))
	}
	writeJSON(w, http.StatusOK, listBody{Files: out})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") != "0"
	file, err := h.svc.Get(r.Context(), chi.URLParam(r, "id"), refresh)
	if err != nil && !errors.Is(err, domain.ErrExpired) {
		writeError(w, err)
		return
	}
	body := toFileBody(file)
	if errors.Is(err, domain.ErrExpired) {
		writeJSON(w, http.StatusOK, map[string]any{"expired": true, "file": body})
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) Password(w http.ResponseWriter, r *http.Request) {
	var req passwordReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, domain.ErrInvalidParameter)
		return
	}
	file, err := h.svc.SetPassword(r.Context(), usecase.PasswordInput{
		ID:       chi.URLParam(r, "id"),
		Password: req.Password,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toFileBody(file))
}

func (h *Handler) Limit(w http.ResponseWriter, r *http.Request) {
	var req limitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, domain.ErrInvalidParameter)
		return
	}
	file, err := h.svc.SetDownloadLimit(r.Context(), usecase.LimitInput{
		ID:    chi.URLParam(r, "id"),
		Limit: req.DownloadLimit,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toFileBody(file))
}

func (h *Handler) Exists(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.Exists(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			writeJSON(w, http.StatusOK, existsBody{Exists: false})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, existsBody{Exists: true, RequiresPassword: res.RequiresPassword})
}

func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	body, meta, err := h.svc.Download(r.Context(), usecase.DownloadInput{
		ID:       chi.URLParam(r, "id"),
		Password: r.URL.Query().Get("password"),
	})
	if err != nil {
		writeError(w, err)
		return
	}
	defer body.Close()
	name := meta.Name
	if name == "" {
		name = "download"
	}
	w.Header().Set("Content-Type", orDefault(meta.MIME, "application/octet-stream"))
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeDisposition(name)+`"`)
	if meta.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(meta.Size, 10))
	}
	io.Copy(w, body)
}

func (h *Handler) Import(w http.ResponseWriter, r *http.Request) {
	var req importReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, domain.ErrInvalidParameter)
		return
	}
	file, err := h.svc.Import(r.Context(), usecase.ImportInput{
		URL:        req.URL,
		OwnerToken: req.OwnerToken,
		Password:   req.Password,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toFileBody(file))
}

func (h *Handler) Inspect(w http.ResponseWriter, r *http.Request) {
	var req inspectReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, domain.ErrInvalidParameter)
		return
	}
	key := req.URL
	if key == "" {
		key = req.ID
	}
	meta, file, err := h.svc.Inspect(r.Context(), key, req.Password)
	if err != nil {
		writeError(w, err)
		return
	}
	out := inspectBody{
		Name:          meta.Name,
		Size:          meta.Size,
		MIME:          meta.MIME,
		TTLMillis:     meta.TTLMillis,
		FinalDownload: meta.FinalDownload,
		Manifest:      meta.Manifest,
	}
	if file != nil {
		b := toFileBody(file)
		out.Managed = &b
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) Fetch(w http.ResponseWriter, r *http.Request) {
	var req inspectReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, domain.ErrInvalidParameter)
		return
	}
	key := req.URL
	if key == "" {
		key = req.ID
	}
	body, meta, err := h.svc.Download(r.Context(), usecase.DownloadInput{
		URL:      key,
		Password: req.Password,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", orDefault(meta.MIME, "application/octet-stream"))
	w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeDisposition(meta.Name)+`"`)
	if meta.Size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(meta.Size, 10))
	}
	io.Copy(w, body)
}

func parseUpload(r *http.Request) (usecase.UploadInput, io.Closer, error) {
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			return usecase.UploadInput{}, nil, domain.ErrInvalidParameter
		}
		fh, hdr, err := r.FormFile("file")
		if err != nil {
			return usecase.UploadInput{}, nil, domain.ErrInvalidParameter
		}
		name := r.FormValue("filename")
		if name == "" {
			name = hdr.Filename
		}
		downloads, _ := strconv.Atoi(r.FormValue("download_limit"))
		expire, _ := strconv.Atoi(r.FormValue("expire_seconds"))
		return usecase.UploadInput{
			Name:      name,
			MIME:      hdr.Header.Get("Content-Type"),
			Size:      hdr.Size,
			Body:      fh,
			Downloads: downloads,
			ExpireSec: expire,
			Password:  r.FormValue("password"),
		}, fh, nil
	}
	if r.ContentLength <= 0 {
		return usecase.UploadInput{}, nil, domain.ErrEmptyFile
	}
	name := r.Header.Get("X-Filename")
	if name == "" {
		name = "file"
	}
	downloads, _ := strconv.Atoi(r.URL.Query().Get("download_limit"))
	expire, _ := strconv.Atoi(r.URL.Query().Get("expire_seconds"))
	return usecase.UploadInput{
		Name:      name,
		MIME:      r.Header.Get("Content-Type"),
		Size:      r.ContentLength,
		Body:      r.Body,
		Downloads: downloads,
		ExpireSec: expire,
		Password:  r.Header.Get("X-Password"),
	}, nil, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	status, code := statusOf(err)
	writeJSON(w, status, errorBody{Error: err.Error(), Code: code})
}

func statusOf(err error) (int, string) {
	switch {
	case errors.Is(err, domain.ErrNotFound), errors.Is(err, domain.ErrExpired):
		return http.StatusNotFound, "not_found"
	case errors.Is(err, domain.ErrUnauthorized), errors.Is(err, domain.ErrInvalidPassword):
		return http.StatusUnauthorized, "unauthorized"
	case errors.Is(err, domain.ErrPasswordRequired):
		return http.StatusUnauthorized, "password_required"
	case errors.Is(err, domain.ErrTooLarge):
		return http.StatusRequestEntityTooLarge, "too_large"
	case errors.Is(err, domain.ErrEmptyFile), errors.Is(err, domain.ErrInvalidURL), errors.Is(err, domain.ErrInvalidID), errors.Is(err, domain.ErrInvalidParameter), errors.Is(err, domain.ErrSecretMissing), errors.Is(err, domain.ErrOwnerTokenMissing):
		return http.StatusBadRequest, "invalid_request"
	case errors.Is(err, domain.ErrLimitExceeded):
		return http.StatusBadRequest, "limit_exceeded"
	default:
		return http.StatusBadGateway, "host_error"
	}
}

func sanitizeDisposition(name string) string {
	name = strings.ReplaceAll(name, `"`, "")
	name = strings.ReplaceAll(name, "\n", "")
	name = strings.ReplaceAll(name, "\r", "")
	if name == "" {
		return "download"
	}
	return name
}

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
