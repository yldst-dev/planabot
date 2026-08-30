package rest

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func NewRouter(h *Handler, apiKey string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(cors)
	r.Get("/healthz", h.Health)
	r.Group(func(r chi.Router) {
		if apiKey != "" {
			r.Use(requireAPIKey(apiKey))
		}
		r.Get("/v1/instance", h.Instance)
		r.Post("/v1/files", h.Upload)
		r.Get("/v1/files", h.List)
		r.Get("/v1/files/{id}", h.Get)
		r.Delete("/v1/files/{id}", h.Delete)
		r.Post("/v1/files/{id}/password", h.Password)
		r.Patch("/v1/files/{id}", h.Limit)
		r.Get("/v1/files/{id}/exists", h.Exists)
		r.Get("/v1/files/{id}/download", h.Download)
		r.Post("/v1/import", h.Import)
		r.Post("/v1/inspect", h.Inspect)
		r.Post("/v1/download", h.Fetch)
	})
	return r
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-Filename, X-Password, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requireAPIKey(key string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-API-Key") != key {
				writeJSON(w, http.StatusUnauthorized, errorBody{Error: "invalid api key", Code: "unauthorized"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
