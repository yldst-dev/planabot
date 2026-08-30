package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"hiromi/internal/domain"
)

type API struct {
	base  string
	token string
	http  *http.Client
}

func NewAPI(token string) *API {
	return &API{
		base:  "https://api.telegram.org",
		token: token,
		http:  &http.Client{Timeout: 45 * time.Second},
	}
}

func NewAPIWithBase(base, token string, client *http.Client) *API {
	if client == nil {
		client = &http.Client{Timeout: 45 * time.Second}
	}
	return &API{base: strings.TrimRight(base, "/"), token: token, http: client}
}

type User struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	Username  string `json:"username"`
}

type Chat struct {
	ID    int64  `json:"id"`
	Type  string `json:"type"`
	Title string `json:"title"`
}

func (c Chat) Private() bool {
	return c.Type == "private"
}

type Message struct {
	MessageID int    `json:"message_id"`
	From      *User  `json:"from"`
	Chat      Chat   `json:"chat"`
	Text      string `json:"text"`
}

type CallbackQuery struct {
	ID      string   `json:"id"`
	From    User     `json:"from"`
	Message *Message `json:"message"`
	Data    string   `json:"data"`
}

type Update struct {
	UpdateID      int            `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}

type InlineButton struct {
	Text         string `json:"text"`
	URL          string `json:"url,omitempty"`
	CallbackData string `json:"callback_data,omitempty"`
}

type ReplyMarkup struct {
	InlineKeyboard [][]InlineButton `json:"inline_keyboard,omitempty"`
}

type apiResponse struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	Description string          `json:"description"`
	ErrorCode   int             `json:"error_code"`
}

func (a *API) GetMe(ctx context.Context) (User, error) {
	var u User
	if err := a.call(ctx, "getMe", nil, &u); err != nil {
		return User{}, err
	}
	return u, nil
}

func (a *API) GetUpdates(ctx context.Context, offset int) ([]Update, error) {
	var out []Update
	err := a.call(ctx, "getUpdates", map[string]any{
		"offset":          offset,
		"timeout":         30,
		"allowed_updates": []string{"message", "callback_query"},
	}, &out)
	return out, err
}

func (a *API) SendMessage(ctx context.Context, chatID int64, text string, markup *ReplyMarkup) (*Message, error) {
	payload := map[string]any{"chat_id": chatID, "text": text, "disable_web_page_preview": true}
	if markup != nil {
		payload["reply_markup"] = markup
	}
	var msg Message
	if err := a.call(ctx, "sendMessage", payload, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

func (a *API) EditMessageText(ctx context.Context, chatID int64, messageID int, text string, markup *ReplyMarkup) error {
	payload := map[string]any{
		"chat_id":                  chatID,
		"message_id":               messageID,
		"text":                     text,
		"disable_web_page_preview": true,
	}
	if markup != nil {
		payload["reply_markup"] = markup
	}
	return a.call(ctx, "editMessageText", payload, nil)
}

func (a *API) AnswerCallback(ctx context.Context, id, text string, alert bool) error {
	payload := map[string]any{"callback_query_id": id}
	if text != "" {
		payload["text"] = text
		payload["show_alert"] = alert
	}
	return a.call(ctx, "answerCallbackQuery", payload, nil)
}

func (a *API) call(ctx context.Context, method string, payload any, dest any) error {
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base+"/bot"+a.token+"/"+method, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	var envelope apiResponse
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return err
	}
	if !envelope.OK {
		if envelope.ErrorCode == 403 || strings.Contains(strings.ToLower(envelope.Description), "forbidden") {
			return fmt.Errorf("%w: %s", domain.ErrPrivateChat, envelope.Description)
		}
		return fmt.Errorf("%w: telegram %d %s", domain.ErrRemote, envelope.ErrorCode, envelope.Description)
	}
	if dest == nil || len(envelope.Result) == 0 {
		return nil
	}
	return json.Unmarshal(envelope.Result, dest)
}
