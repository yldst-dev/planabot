package jobstore

import (
	"sync"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type Memory struct {
	mu   sync.RWMutex
	data map[string]port.ShareClaim
}

func NewMemory() *Memory {
	return &Memory{data: map[string]port.ShareClaim{}}
}

func (m *Memory) Put(claim port.ShareClaim) error {
	if claim.Token == "" {
		return domain.ErrClaim
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[claim.Token] = claim
	return nil
}

func (m *Memory) Get(token string) (port.ShareClaim, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.data[token]
	if !ok {
		return port.ShareClaim{}, domain.ErrClaim
	}
	return c, nil
}

var _ port.ClaimStore = (*Memory)(nil)
