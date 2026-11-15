package history

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
)

type JSONStore struct {
	path string
	mu   sync.Mutex
}

type diskFormat struct {
	Files []*domain.ManagedFile `json:"files"`
}

func OpenJSON(path string) (*JSONStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	s := &JSONStore{path: path}
	if _, err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *JSONStore) Save(ctx context.Context, file *domain.ManagedFile) error {
	return s.update(ctx, func(m *Memory) error { return m.Save(ctx, file) })
}

func (s *JSONStore) Get(ctx context.Context, id string) (*domain.ManagedFile, error) {
	m, err := s.load()
	if err != nil {
		return nil, err
	}
	return m.Get(ctx, id)
}

func (s *JSONStore) List(ctx context.Context) ([]*domain.ManagedFile, error) {
	m, err := s.load()
	if err != nil {
		return nil, err
	}
	return m.List(ctx)
}

func (s *JSONStore) Delete(ctx context.Context, id string) error {
	return s.update(ctx, func(m *Memory) error { return m.Delete(ctx, id) })
}

func (s *JSONStore) load() (*Memory, error) {
	m := NewMemory()
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return m, nil
	}
	var disk diskFormat
	if err := json.Unmarshal(raw, &disk); err != nil {
		return nil, err
	}
	for _, f := range disk.Files {
		if f != nil {
			_ = m.Save(context.Background(), f)
		}
	}
	return m, nil
}

func (s *JSONStore) update(ctx context.Context, mutate func(*Memory) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := lockFile(s.path + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	m, err := s.load()
	if err != nil {
		return err
	}
	if err := mutate(m); err != nil {
		return err
	}
	files, err := m.List(ctx)
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(diskFormat{Files: files}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), filepath.Base(s.path)+".*.tmp")
	if err != nil {
		return err
	}
	_, writeErr := tmp.Write(raw)
	if err := errors.Join(writeErr, tmp.Close()); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}
