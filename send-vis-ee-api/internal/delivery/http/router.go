package rest

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func NewRouter(h *Handler, apiKey string) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Get("/healthz", h.Health)
	r.Group(func(r chi.Router) {
		if apiKey != "" {
			r.Use(requireAPIKey(apiKey))
		} else {
			r.Use(localOnly)
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

func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" || !loopbackHost(r.Host) {
			writeJSON(w, http.StatusForbidden, errorBody{Error: "set SENDVIS_API_KEY to call this api from a browser or a non-loopback host name", Code: "forbidden"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func loopbackHost(hostPort string) bool {
	host, _, err := net.SplitHostPort(hostPort)
	if err != nil {
		host = hostPort
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func requireAPIKey(key string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-API-Key")), []byte(key)) != 1 {
				writeJSON(w, http.StatusUnauthorized, errorBody{Error: "invalid api key", Code: "unauthorized"})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
