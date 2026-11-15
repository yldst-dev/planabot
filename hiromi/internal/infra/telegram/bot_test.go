package telegram

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

type failingAPI struct {
	*fakeAPI
	polls atomic.Int32
}

func (f *failingAPI) GetUpdates(context.Context, int) ([]Update, error) {
	f.polls.Add(1)
	return nil, errors.New("network down")
}

func TestRunWaitsBeforeRetryingAFailedPoll(t *testing.T) {
	prev := retryDelay
	retryDelay = func(int) time.Duration { return 40 * time.Millisecond }
	defer func() { retryDelay = prev }()
	api := &failingAPI{fakeAPI: &fakeAPI{}}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	err := NewBot(api, fakeShare{}).Run(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("%v", err)
	}
	if n := api.polls.Load(); n < 2 || n > 10 {
		t.Fatalf("polls %d", n)
	}
}

func TestRetryDelayGrowsAndStops(t *testing.T) {
	if retryDelay(0) != 2*time.Second || retryDelay(1) != 4*time.Second || retryDelay(50) != 30*time.Second {
		t.Fatalf("%s %s %s", retryDelay(0), retryDelay(1), retryDelay(50))
	}
}

type scriptedAPI struct {
	*fakeAPI
	once  sync.Once
	batch []Update
}

func (s *scriptedAPI) GetUpdates(ctx context.Context, _ int) ([]Update, error) {
	var out []Update
	s.once.Do(func() { out = s.batch })
	if out != nil {
		return out, nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

type slowShare struct {
	fakeShare
	running atomic.Int32
	peak    atomic.Int32
	started chan struct{}
	release chan struct{}
}

func (s *slowShare) Deliver(ctx context.Context, _ uint64) (*usecase.Share, error) {
	n := s.running.Add(1)
	defer s.running.Add(-1)
	for {
		peak := s.peak.Load()
		if n <= peak || s.peak.CompareAndSwap(peak, n) {
			break
		}
	}
	s.started <- struct{}{}
	select {
	case <-s.release:
		return s.share, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRunAnswersOthersWhileDeliveriesRunAndCapsThem(t *testing.T) {
	getCallback := func(id string) Update {
		return Update{UpdateID: 1, CallbackQuery: &CallbackQuery{
			ID:      "cb" + id,
			From:    User{ID: 99},
			Data:    "get:" + id,
			Message: &Message{MessageID: 5, Chat: Chat{ID: 10, Type: "supergroup"}},
		}}
	}
	api := &scriptedAPI{fakeAPI: &fakeAPI{}, batch: []Update{
		getCallback("1"), getCallback("2"), getCallback("3"),
		{UpdateID: 2, Message: &Message{Chat: Chat{ID: 7, Type: "private"}, Text: "/help"}},
	}}
	shares := &slowShare{
		fakeShare: fakeShare{share: &usecase.Share{Token: "tok", Title: "sample", Pages: 2}},
		started:   make(chan struct{}, 8),
		release:   make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- NewBot(api, shares).Run(ctx) }()

	for range 2 {
		select {
		case <-shares.started:
		case <-time.After(3 * time.Second):
			t.Fatal("deliveries did not start")
		}
	}
	waitUntil(t, "help reply", func() bool {
		api.mu.Lock()
		defer api.mu.Unlock()
		return len(api.messages) == 1
	})
	time.Sleep(50 * time.Millisecond)
	if n := shares.running.Load(); n != 2 {
		t.Fatalf("running %d", n)
	}

	close(shares.release)
	waitUntil(t, "all deliveries", func() bool {
		api.mu.Lock()
		defer api.mu.Unlock()
		ready := 0
		for _, e := range api.edits {
			if strings.HasPrefix(e.text, "준비되었습니다") {
				ready++
			}
		}
		return ready == 3
	})
	if peak := shares.peak.Load(); peak != 2 {
		t.Fatalf("peak %d", peak)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("%v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return")
	}
}
