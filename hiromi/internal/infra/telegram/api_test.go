package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hiromi/internal/domain"
)

func TestAPIForbidden(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":          false,
			"error_code":  403,
			"description": "Forbidden: bot can't initiate conversation with a user",
		})
	}))
	defer srv.Close()
	api := NewAPIWithBase(srv.URL, "token", srv.Client())
	_, err := api.SendMessage(context.Background(), 1, "hi", nil)
	if !errors.Is(err, domain.ErrPrivateChat) {
		t.Fatalf("%v", err)
	}
}

func TestAPIGetMe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"result": map[string]any{"id": 1, "is_bot": true, "username": "hiromibot", "first_name": "h"},
		})
	}))
	defer srv.Close()
	api := NewAPIWithBase(srv.URL, "token", srv.Client())
	me, err := api.GetMe(context.Background())
	if err != nil || me.Username != "hiromibot" {
		t.Fatalf("%+v %v", me, err)
	}
}

func TestAPIErrorHidesToken(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	ln.Close()
	api := NewAPIWithBase(base, "123:SECRETTOKEN", nil)
	_, err = api.GetMe(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "SECRETTOKEN") {
		t.Fatalf("token leaked: %v", err)
	}
	if !errors.Is(err, domain.ErrRemote) || !strings.Contains(err.Error(), "getMe") {
		t.Fatalf("%v", err)
	}
}
