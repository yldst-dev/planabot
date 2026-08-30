package telegram

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"hiromi/internal/domain"
	"hiromi/internal/usecase"
)

type fakeAPI struct {
	mu       sync.Mutex
	messages []sent
	edits    []sent
	answers  []string
	failPM   bool
}

type sent struct {
	chatID int64
	text   string
	markup *ReplyMarkup
}

func (f *fakeAPI) GetMe(context.Context) (User, error) {
	return User{ID: 1, Username: "hiromibot"}, nil
}

func (f *fakeAPI) GetUpdates(context.Context, int) ([]Update, error) {
	return nil, nil
}

func (f *fakeAPI) SendMessage(_ context.Context, chatID int64, text string, markup *ReplyMarkup) (*Message, error) {
	if f.failPM && chatID == 99 {
		return nil, domain.ErrPrivateChat
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages = append(f.messages, sent{chatID: chatID, text: text, markup: markup})
	return &Message{MessageID: len(f.messages), Chat: Chat{ID: chatID, Type: "private"}}, nil
}

func (f *fakeAPI) EditMessageText(_ context.Context, chatID int64, messageID int, text string, markup *ReplyMarkup) error {
	_ = messageID
	f.mu.Lock()
	defer f.mu.Unlock()
	f.edits = append(f.edits, sent{chatID: chatID, text: text, markup: markup})
	return nil
}

func (f *fakeAPI) AnswerCallback(_ context.Context, id, text string, alert bool) error {
	_ = id
	_ = alert
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answers = append(f.answers, text)
	return nil
}

type fakeShare struct {
	preview *usecase.SharePreview
	share   *usecase.Share
}

func (f fakeShare) Preview(context.Context, uint64) (*usecase.SharePreview, error) {
	if f.preview == nil {
		return nil, domain.ErrNotFound
	}
	return f.preview, nil
}

func (f fakeShare) Deliver(context.Context, uint64) (*usecase.Share, error) {
	if f.share == nil {
		return nil, errors.New("deliver")
	}
	return f.share, nil
}

func (f fakeShare) Claim(token string) (*usecase.Share, error) {
	if f.share == nil || f.share.Token != token {
		return nil, domain.ErrClaim
	}
	return f.share, nil
}

func TestHandleGalleryPreview(t *testing.T) {
	api := &fakeAPI{}
	bot := NewBot(api, fakeShare{preview: &usecase.SharePreview{ID: 1234567, Title: "sample", Type: "manga", Pages: 2, Language: "korean"}})
	err := bot.Handle(context.Background(), Update{Message: &Message{
		Chat: Chat{ID: 10, Type: "supergroup"},
		Text: "https://hitomi.la/galleries/1234567.html",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(api.messages) != 1 || !strings.Contains(api.messages[0].text, "sample") {
		t.Fatalf("%+v", api.messages)
	}
	if api.messages[0].markup.InlineKeyboard[0][0].CallbackData != "get:1234567" {
		t.Fatalf("%+v", api.messages[0].markup)
	}
}

func TestDeliverInGroupHidesURL(t *testing.T) {
	api := &fakeAPI{}
	share := &usecase.Share{Token: "tok", Title: "sample", Pages: 2, URL: "https://send.vis.ee/download/x/#secret"}
	bot := NewBot(api, fakeShare{share: share})
	bot.username = "hiromibot"
	err := bot.Handle(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID:   "cb",
		From: User{ID: 99},
		Data: "get:1234567",
		Message: &Message{
			MessageID: 5,
			Chat:      Chat{ID: 10, Type: "supergroup"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(api.edits) == 0 {
		t.Fatal("no edits")
	}
	last := api.edits[len(api.edits)-1]
	if strings.Contains(last.text, "#secret") || strings.Contains(last.text, "send.vis.ee") {
		t.Fatalf("leaked url %s", last.text)
	}
	if last.markup.InlineKeyboard[0][0].CallbackData != "dl:tok" {
		t.Fatalf("%+v", last.markup)
	}
}

func TestDownloadCallbackSendsPrivate(t *testing.T) {
	api := &fakeAPI{}
	share := &usecase.Share{Token: "tok", Title: "sample", Pages: 2, URL: "https://send.vis.ee/download/x/#secret"}
	bot := NewBot(api, fakeShare{share: share})
	err := bot.Handle(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID:   "cb",
		From: User{ID: 99},
		Data: "dl:tok",
		Message: &Message{
			Chat: Chat{ID: 10, Type: "supergroup"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(api.messages) != 1 || api.messages[0].chatID != 99 {
		t.Fatalf("%+v", api.messages)
	}
	if !strings.Contains(api.messages[0].text, "#secret") {
		t.Fatalf("%s", api.messages[0].text)
	}
	if api.messages[0].markup.InlineKeyboard[0][0].URL != share.URL {
		t.Fatal("open button")
	}
}

func TestDownloadCallbackRequiresStart(t *testing.T) {
	api := &fakeAPI{failPM: true}
	share := &usecase.Share{Token: "tok", Title: "sample", URL: "https://send.vis.ee/download/x/#secret"}
	bot := NewBot(api, fakeShare{share: share})
	bot.username = "hiromibot"
	err := bot.Handle(context.Background(), Update{CallbackQuery: &CallbackQuery{
		ID:      "cb",
		From:    User{ID: 99},
		Data:    "dl:tok",
		Message: &Message{Chat: Chat{ID: 10, Type: "supergroup"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(api.messages) != 1 || api.messages[0].markup == nil {
		t.Fatalf("%+v", api.messages)
	}
	url := api.messages[0].markup.InlineKeyboard[0][0].URL
	if url != "https://t.me/hiromibot?start=dl_tok" {
		t.Fatalf("%s", url)
	}
}

func TestStartClaim(t *testing.T) {
	api := &fakeAPI{}
	share := &usecase.Share{Token: "tok", Title: "sample", Pages: 2, URL: "https://send.vis.ee/download/x/#secret"}
	bot := NewBot(api, fakeShare{share: share})
	err := bot.Handle(context.Background(), Update{Message: &Message{
		Chat: Chat{ID: 99, Type: "private"},
		Text: "/start dl_tok",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(api.messages) != 1 || !strings.Contains(api.messages[0].text, share.URL) {
		t.Fatalf("%+v", api.messages)
	}
}
