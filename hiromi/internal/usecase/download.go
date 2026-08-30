package usecase

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type DownloadService struct {
	galleries port.GalleryRepository
	urls      port.URLResolver
	fetch     port.MediaFetcher
	store     port.FileStore
	viewer    port.ViewerRenderer
	front     string
	gate      *fetchGate
	sleep     func(context.Context, time.Duration) error
}

type fetchGate struct {
	mu      sync.Mutex
	spacing time.Duration
	next    time.Time
}

func NewDownloadService(g port.GalleryRepository, u port.URLResolver, f port.MediaFetcher, s port.FileStore, front string) *DownloadService {
	return &DownloadService{
		galleries: g,
		urls:      u,
		fetch:     f,
		store:     s,
		front:     front,
		gate:      &fetchGate{spacing: 200 * time.Millisecond},
		sleep:     sleepCtx,
	}
}

func (s *DownloadService) WithViewer(v port.ViewerRenderer) *DownloadService {
	s.viewer = v
	return s
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	select {
	case <-ctx.Done():
		timer.Stop()
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *DownloadService) Download(ctx context.Context, id uint64, opt domain.DownloadOptions) (*domain.GalleryDownload, error) {
	if id == 0 {
		return nil, domain.ErrInvalidID
	}
	opt = opt.Normalize()
	g, err := s.galleries.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	dirName := domain.GalleryDirName(g.ID)
	result := &domain.GalleryDownload{
		GalleryID: g.ID,
		Title:     g.Title,
		Type:      g.Type,
		Dir:       path.Join(s.store.Root(), dirName),
		PageCount: g.PageCount(),
		Saved:     []domain.DownloadedFile{},
		Skipped:   []domain.DownloadedFile{},
		Failed:    []domain.DownloadFailure{},
	}
	if g.Language != nil {
		result.Language = g.Language.Name
	}
	if err := s.writeInfo(g, dirName); err != nil {
		return nil, err
	}
	referer := s.front + g.ReaderPath
	type job struct {
		index  int
		file   domain.File
		format domain.ImageFormat
		name   string
		rel    string
		url    string
	}
	jobs := make([]job, 0, len(g.Files))
	for i := range g.Files {
		file := g.Files[i]
		format, err := file.ChooseFormat(opt.Format)
		if err != nil {
			result.Failed = append(result.Failed, domain.DownloadFailure{
				Index: file.Index,
				Name:  file.Name,
				Error: err.Error(),
			})
			continue
		}
		name := domain.DownloadFileName(file.Index, format)
		rel := path.Join(dirName, name)
		rawURL := file.URLFor(format)
		if rawURL == "" {
			rawURL, err = s.urls.ImageURL(ctx, file.Hash, format)
			if err != nil {
				result.Failed = append(result.Failed, domain.DownloadFailure{
					Index: file.Index,
					Name:  name,
					Error: err.Error(),
				})
				continue
			}
		}
		if opt.SkipExisting {
			ok, size, err := s.store.Exists(rel)
			if err != nil {
				result.Failed = append(result.Failed, domain.DownloadFailure{Index: file.Index, Name: name, Error: err.Error()})
				continue
			}
			if ok && size > 0 {
				result.Skipped = append(result.Skipped, domain.DownloadedFile{
					Index:  file.Index,
					Name:   name,
					Path:   path.Join(s.store.Root(), rel),
					Bytes:  size,
					Format: format,
					Kind:   "image",
				})
				continue
			}
		}
		jobs = append(jobs, job{index: file.Index, file: file, format: format, name: name, rel: rel, url: rawURL})
	}
	var mu sync.Mutex
	sem := make(chan struct{}, opt.Workers)
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				mu.Lock()
				result.Failed = append(result.Failed, domain.DownloadFailure{Index: j.index, Name: j.name, Error: ctx.Err().Error()})
				mu.Unlock()
				return
			}
			defer func() { <-sem }()
			n, err := s.fetchToStore(ctx, j.rel, j.url, referer)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				result.Failed = append(result.Failed, domain.DownloadFailure{Index: j.index, Name: j.name, Error: err.Error()})
				return
			}
			result.Saved = append(result.Saved, domain.DownloadedFile{
				Index:  j.index,
				Name:   j.name,
				Path:   path.Join(s.store.Root(), j.rel),
				Bytes:  n,
				Format: j.format,
				Kind:   "image",
			})
		}(j)
	}
	wg.Wait()
	if opt.IncludeVideo && g.Video != nil && g.Video.URL != "" {
		rel := path.Join(dirName, "video.mp4")
		skip := false
		if opt.SkipExisting {
			ok, size, err := s.store.Exists(rel)
			if err != nil {
				result.Failed = append(result.Failed, domain.DownloadFailure{Name: "video.mp4", Error: err.Error()})
			} else if ok && size > 0 {
				result.Skipped = append(result.Skipped, domain.DownloadedFile{
					Name:  "video.mp4",
					Path:  path.Join(s.store.Root(), rel),
					Bytes: size,
					Kind:  "video",
				})
				skip = true
			}
		}
		if !skip {
			n, err := s.fetchToStore(ctx, rel, g.Video.URL, referer)
			if err != nil {
				result.Failed = append(result.Failed, domain.DownloadFailure{Name: "video.mp4", Error: err.Error()})
			} else {
				result.Saved = append(result.Saved, domain.DownloadedFile{
					Name:  "video.mp4",
					Path:  path.Join(s.store.Root(), rel),
					Bytes: n,
					Kind:  "video",
				})
			}
		}
	}
	if err := s.writeViewer(g, dirName, opt.Format, result); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *DownloadService) DownloadMany(ctx context.Context, ids []uint64, opt domain.DownloadOptions) ([]domain.GalleryDownload, error) {
	if len(ids) == 0 {
		return nil, domain.ErrInvalidID
	}
	out := make([]domain.GalleryDownload, 0, len(ids))
	for _, id := range ids {
		res, err := s.Download(ctx, id, opt)
		if err != nil {
			return out, err
		}
		out = append(out, *res)
	}
	return out, nil
}

func (s *DownloadService) fetchToStore(ctx context.Context, rel, rawURL, referer string) (int64, error) {
	var last error
	url := rawURL
	for attempt := 0; attempt < domain.DownloadAttempts; attempt++ {
		if err := s.acquire(ctx); err != nil {
			return 0, err
		}
		n, err := s.fetchOnce(ctx, rel, url, referer)
		if err == nil {
			return n, nil
		}
		last = err
		if !domain.Retryable(err) {
			return 0, err
		}
		if attempt == domain.DownloadAttempts-1 {
			break
		}
		if attempt%2 == 1 {
			if alt := alternateCDNURL(url); alt != url {
				url = alt
			}
		}
		wait := downloadBackoff(attempt)
		if domain.StatusOf(err) == http.StatusServiceUnavailable || domain.StatusOf(err) == http.StatusTooManyRequests {
			if wait < 2*time.Second {
				wait = 2 * time.Second
			}
			s.punish(wait)
		}
		if err := s.sleep(ctx, wait); err != nil {
			return 0, err
		}
	}
	return 0, last
}

func (s *DownloadService) fetchOnce(ctx context.Context, rel, rawURL, referer string) (int64, error) {
	body, _, err := s.fetch.Fetch(ctx, rawURL, referer)
	if err != nil {
		return 0, err
	}
	defer body.Close()
	return s.store.Write(rel, body)
}

func (s *DownloadService) acquire(ctx context.Context) error {
	s.gate.mu.Lock()
	now := time.Now()
	next := s.gate.next
	if next.Before(now) {
		next = now
	}
	wait := next.Sub(now)
	s.gate.next = next.Add(s.gate.spacing)
	s.gate.mu.Unlock()
	return s.sleep(ctx, wait)
}

func (s *DownloadService) punish(d time.Duration) {
	s.gate.mu.Lock()
	t := time.Now().Add(d)
	if t.After(s.gate.next) {
		s.gate.next = t
	}
	s.gate.mu.Unlock()
}

func downloadBackoff(attempt int) time.Duration {
	d := 500 * time.Millisecond << attempt
	if d > 12*time.Second {
		d = 12 * time.Second
	}
	return d
}

func alternateCDNURL(rawURL string) string {
	pairs := [][2]string{
		{"//w1.", "//w2."},
		{"//w2.", "//w1."},
		{"//a1.", "//a2."},
		{"//a2.", "//a1."},
		{"//j1.", "//j2."},
		{"//j2.", "//j1."},
	}
	for _, p := range pairs {
		if strings.Contains(rawURL, p[0]) {
			return strings.Replace(rawURL, p[0], p[1], 1)
		}
	}
	return rawURL
}

func (s *DownloadService) writeInfo(g *domain.Gallery, dirName string) error {
	lang := ""
	if g.Language != nil {
		lang = g.Language.Name
	}
	payload := map[string]any{
		"id":         g.ID,
		"title":      g.Title,
		"type":       g.Type,
		"language":   lang,
		"page_count": g.PageCount(),
		"gallery":    s.front + g.GalleryPath,
		"reader":     s.front + g.ReaderPath,
	}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	_, err = s.store.Write(path.Join(dirName, "info.json"), bytes.NewReader(raw))
	if err != nil {
		return err
	}
	return nil
}

func (s *DownloadService) writeViewer(g *domain.Gallery, dirName string, want domain.ImageFormat, result *domain.GalleryDownload) error {
	if s.viewer == nil {
		return nil
	}
	formats := []domain.ImageFormat{want, domain.FormatWebP, domain.FormatAVIF, domain.FormatJXL}
	pages := make([]domain.ViewerPage, 0, g.PageCount())
	for i := 0; i < g.PageCount(); i++ {
		var page domain.ViewerPage
		found := false
		seen := map[domain.ImageFormat]struct{}{}
		for _, format := range formats {
			if _, ok := seen[format]; ok {
				continue
			}
			seen[format] = struct{}{}
			rel := path.Join(dirName, domain.DownloadFileName(i, format))
			data, err := s.store.Read(rel)
			if err != nil || len(data) == 0 {
				continue
			}
			page = domain.ViewerPage{Format: format, Data: data}
			found = true
			break
		}
		if found {
			pages = append(pages, page)
		}
	}
	if len(pages) == 0 {
		return nil
	}
	html, err := s.viewer.Render(domain.ViewerDocument{
		Title:    g.Title,
		Language: result.Language,
		Pages:    pages,
	})
	if err != nil {
		return fmt.Errorf("%w: viewer: %v", domain.ErrStorage, err)
	}
	rel := path.Join(dirName, domain.ViewerFileName)
	if _, err := s.store.Write(rel, bytes.NewReader(html)); err != nil {
		return err
	}
	result.Viewer = path.Join(s.store.Root(), rel)
	return nil
}
