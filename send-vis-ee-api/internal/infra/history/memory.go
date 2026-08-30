package history

import (
	"context"
	"sort"
	"sync"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
)

type Memory struct {
	mu    sync.RWMutex
	files map[string]*domain.ManagedFile
}

func NewMemory() *Memory {
	return &Memory{files: map[string]*domain.ManagedFile{}}
}

func (m *Memory) Save(_ context.Context, file *domain.ManagedFile) error {
	if file == nil || file.ID == "" {
		return domain.ErrInvalidID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *file
	m.files[file.ID] = &cp
	return nil
}

func (m *Memory) Get(_ context.Context, id string) (*domain.ManagedFile, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	file, ok := m.files[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	cp := *file
	return &cp, nil
}

func (m *Memory) List(_ context.Context) ([]*domain.ManagedFile, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*domain.ManagedFile, 0, len(m.files))
	for _, f := range m.files {
		cp := *f
		out = append(out, &cp)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

func (m *Memory) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.files[id]; !ok {
		return domain.ErrNotFound
	}
	delete(m.files, id)
	return nil
}
