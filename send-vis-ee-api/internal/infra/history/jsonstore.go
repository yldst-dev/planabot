package history

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
)

type JSONStore struct {
	path string
	mu   sync.Mutex
	mem  *Memory
}

type diskFormat struct {
	Files []*domain.ManagedFile `json:"files"`
}

func OpenJSON(path string) (*JSONStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	s := &JSONStore{path: path, mem: NewMemory()}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return s, nil
	}
	var disk diskFormat
	if err := json.Unmarshal(raw, &disk); err != nil {
		return nil, err
	}
	for _, f := range disk.Files {
		if f != nil {
			_ = s.mem.Save(context.Background(), f)
		}
	}
	return s, nil
}

func (s *JSONStore) Save(ctx context.Context, file *domain.ManagedFile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.mem.Save(ctx, file); err != nil {
		return err
	}
	return s.flush(ctx)
}

func (s *JSONStore) Get(ctx context.Context, id string) (*domain.ManagedFile, error) {
	return s.mem.Get(ctx, id)
}

func (s *JSONStore) List(ctx context.Context) ([]*domain.ManagedFile, error) {
	return s.mem.List(ctx)
}

func (s *JSONStore) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.mem.Delete(ctx, id); err != nil {
		return err
	}
	return s.flush(ctx)
}

func (s *JSONStore) flush(ctx context.Context) error {
	files, err := s.mem.List(ctx)
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(diskFormat{Files: files}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
