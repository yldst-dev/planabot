package telegram

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"

	"hiromi/internal/domain"
	"hiromi/internal/usecase"
)

type Gateway interface {
	GetMe(ctx context.Context) (User, error)
	GetUpdates(ctx context.Context, offset int) ([]Update, error)
	SendMessage(ctx context.Context, chatID int64, text string, markup *ReplyMarkup) (*Message, error)
	EditMessageText(ctx context.Context, chatID int64, messageID int, text string, markup *ReplyMarkup) error
	AnswerCallback(ctx context.Context, id, text string, alert bool) error
}

type Sharer interface {
	Preview(ctx context.Context, id uint64) (*usecase.SharePreview, error)
	Deliver(ctx context.Context, id uint64) (*usecase.Share, error)
	Claim(token string) (*usecase.Share, error)
}

type Bot struct {
	api      Gateway
	shares   Sharer
	username string
}

func NewBot(api Gateway, shares Sharer) *Bot {
	return &Bot{api: api, shares: shares}
}

func (b *Bot) Run(ctx context.Context) error {
	me, err := b.api.GetMe(ctx)
	if err != nil {
		return err
	}
	b.username = me.Username
	log.Printf("telegram bot @%s", b.username)
	offset := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		updates, err := b.api.GetUpdates(ctx, offset)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			log.Printf("getUpdates: %v", err)
			continue
		}
		for _, u := range updates {
			offset = u.UpdateID + 1
			if err := b.Handle(ctx, u); err != nil {
				log.Printf("update %d: %v", u.UpdateID, err)
			}
		}
	}
}

func (b *Bot) Handle(ctx context.Context, u Update) error {
	if u.CallbackQuery != nil {
		return b.handleCallback(ctx, u.CallbackQuery)
	}
	if u.Message != nil {
		return b.handleMessage(ctx, u.Message)
	}
	return nil
}

func (b *Bot) handleMessage(ctx context.Context, msg *Message) error {
	text := strings.TrimSpace(msg.Text)
	if text == "" {
		return nil
	}
	cmd, payload := splitCommand(text)
	switch cmd {
	case "/start":
		if strings.HasPrefix(payload, "dl_") {
			return b.sendClaim(ctx, msg.Chat.ID, strings.TrimPrefix(payload, "dl_"), true)
		}
		_, err := b.api.SendMessage(ctx, msg.Chat.ID, helpText(), nil)
		return err
	case "/help":
		_, err := b.api.SendMessage(ctx, msg.Chat.ID, helpText(), nil)
		return err
	}
	id, err := domain.ParseGalleryID(text)
	if err != nil {
		return nil
	}
	return b.sendPreview(ctx, msg.Chat.ID, id)
}

func (b *Bot) sendPreview(ctx context.Context, chatID int64, id uint64) error {
	p, err := b.shares.Preview(ctx, id)
	if err != nil {
		_, sendErr := b.api.SendMessage(ctx, chatID, "작품을 찾지 못했습니다.", nil)
		if sendErr != nil {
			return sendErr
		}
		return err
	}
	text := formatPreview(p)
	_, err = b.api.SendMessage(ctx, chatID, text, &ReplyMarkup{
		InlineKeyboard: [][]InlineButton{{{Text: "받기", CallbackData: "get:" + strconv.FormatUint(id, 10)}}},
	})
	return err
}

func (b *Bot) handleCallback(ctx context.Context, cb *CallbackQuery) error {
	data := strings.TrimSpace(cb.Data)
	switch {
	case strings.HasPrefix(data, "get:"):
		id, err := strconv.ParseUint(strings.TrimPrefix(data, "get:"), 10, 64)
		if err != nil || id == 0 {
			return b.api.AnswerCallback(ctx, cb.ID, "잘못된 요청입니다.", true)
		}
		if err := b.api.AnswerCallback(ctx, cb.ID, "준비 중입니다.", false); err != nil {
			return err
		}
		return b.runDeliver(ctx, cb, id)
	case strings.HasPrefix(data, "dl:"):
		token := strings.TrimPrefix(data, "dl:")
		if err := b.sendClaim(ctx, cb.From.ID, token, false); err != nil {
			if errors.Is(err, domain.ErrPrivateChat) {
				_ = b.api.AnswerCallback(ctx, cb.ID, "봇과 개인 채팅을 연 뒤 다시 눌러 주세요.", true)
				if cb.Message != nil {
					_, _ = b.api.SendMessage(ctx, cb.Message.Chat.ID, "개인 채팅에서 봇을 먼저 시작해 주세요.", startMarkup(b.username, token))
				}
				return nil
			}
			_ = b.api.AnswerCallback(ctx, cb.ID, "링크를 찾지 못했습니다.", true)
			return err
		}
		return b.api.AnswerCallback(ctx, cb.ID, "개인 채팅으로 보냈습니다.", false)
	default:
		return b.api.AnswerCallback(ctx, cb.ID, "", false)
	}
}

func (b *Bot) runDeliver(ctx context.Context, cb *CallbackQuery, id uint64) error {
	if cb.Message == nil {
		return nil
	}
	chatID := cb.Message.Chat.ID
	msgID := cb.Message.MessageID
	_ = b.api.EditMessageText(ctx, chatID, msgID, "내려받는 중입니다. 잠시만 기다려 주세요.", nil)
	share, err := b.shares.Deliver(ctx, id)
	if err != nil {
		text := "준비에 실패했습니다."
		if errors.Is(err, domain.ErrBusy) {
			text = "이미 같은 작품을 준비 중입니다."
		}
		_ = b.api.EditMessageText(ctx, chatID, msgID, text, nil)
		return err
	}
	text := formatReady(share, cb.Message.Chat.Private())
	markup := &ReplyMarkup{
		InlineKeyboard: [][]InlineButton{{{Text: "다운로드", CallbackData: "dl:" + share.Token}}},
	}
	if err := b.api.EditMessageText(ctx, chatID, msgID, text, markup); err != nil {
		return err
	}
	if cb.Message.Chat.Private() {
		return b.sendClaim(ctx, cb.From.ID, share.Token, false)
	}
	return nil
}

func (b *Bot) sendClaim(ctx context.Context, chatID int64, token string, welcome bool) error {
	share, err := b.shares.Claim(token)
	if err != nil {
		if welcome {
			_, sendErr := b.api.SendMessage(ctx, chatID, "유효하지 않은 다운로드 요청입니다.", nil)
			if sendErr != nil {
				return sendErr
			}
		}
		return err
	}
	text := formatClaim(share)
	markup := &ReplyMarkup{
		InlineKeyboard: [][]InlineButton{{{Text: "브라우저에서 열기", URL: share.URL}}},
	}
	_, err = b.api.SendMessage(ctx, chatID, text, markup)
	return err
}

func splitCommand(text string) (cmd, payload string) {
	parts := strings.Fields(text)
	if len(parts) == 0 {
		return "", ""
	}
	cmd = strings.SplitN(parts[0], "@", 2)[0]
	if len(parts) > 1 {
		payload = parts[1]
	}
	return cmd, payload
}

func helpText() string {
	return "품번이나 hitomi.la 주소를 보내 주세요. 받기 뒤에 뷰어 HTML을 준비하고, 다운로드는 개인 채팅으로 보냅니다."
}

func formatPreview(p *usecase.SharePreview) string {
	lang := p.Language
	if lang == "" {
		lang = "-"
	}
	return fmt.Sprintf("%s\n품번 %d · %s · %d쪽 · %s", p.Title, p.ID, p.Type, p.Pages, lang)
}

func formatReady(s *usecase.Share, private bool) string {
	if private {
		return fmt.Sprintf("준비되었습니다.\n%s\n%d쪽", s.Title, s.Pages)
	}
	return fmt.Sprintf("준비되었습니다.\n%s\n%d쪽\n다운로드를 누르면 개인 채팅으로 보냅니다.", s.Title, s.Pages)
}

func formatClaim(s *usecase.Share) string {
	return fmt.Sprintf("%s\n%d쪽\n%s", s.Title, s.Pages, s.URL)
}

func startMarkup(username, token string) *ReplyMarkup {
	if username == "" {
		return nil
	}
	return &ReplyMarkup{
		InlineKeyboard: [][]InlineButton{{{
			Text: "봇 열기",
			URL:  "https://t.me/" + username + "?start=dl_" + token,
		}}},
	}
}
