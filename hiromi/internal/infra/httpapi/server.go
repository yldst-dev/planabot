package httpapi

import (
	"net/http"
)

func NewMux(h *Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.Health)
	mux.HandleFunc("GET /v1/galleries/{id}", h.GetGallery)
	mux.HandleFunc("GET /v1/galleries/{id}/files", h.GetFiles)
	mux.HandleFunc("GET /v1/galleries/{id}/files/{index}", h.GetFile)
	mux.HandleFunc("GET /v1/galleries/{id}/related", h.GetRelated)
	mux.HandleFunc("GET /v1/search", h.Search)
	mux.HandleFunc("GET /v1/index", h.Index)
	mux.HandleFunc("GET /v1/tags", h.ListTags)
	mux.HandleFunc("GET /v1/tags/search", h.SearchTags)
	mux.HandleFunc("GET /v1/tags/{type}/{name}/languages", h.TagLanguages)
	mux.HandleFunc("GET /v1/languages", h.Languages)
	mux.HandleFunc("GET /v1/types", h.Types)
	mux.HandleFunc("GET /v1/media", h.ResolveMedia)
	mux.HandleFunc("GET /v1/proxy/galleries/{id}/files/{index}", h.ProxyFile)
	mux.HandleFunc("POST /v1/galleries/{id}/download", h.DownloadGallery)
	mux.HandleFunc("GET /v1/galleries/{id}/download", h.DownloadGallery)
	mux.HandleFunc("POST /v1/downloads", h.DownloadMany)
	mux.HandleFunc("GET /v1/downloads", h.DownloadMany)
	return withLog(withCORS(mux))
}
