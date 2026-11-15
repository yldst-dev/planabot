package jobstore

import (
	"sync"
	"time"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

const claimTTL = 72 * time.Hour

type entry struct {
	claim   port.ShareClaim
	expires time.Time
}

type Memory struct {
	mu   sync.RWMutex
	data map[string]entry
	now  func() time.Time
}

func NewMemory() *Memory {
	return &Memory{data: map[string]entry{}, now: time.Now}
}

func (m *Memory) Put(claim port.ShareClaim) error {
	if claim.Token == "" {
		return domain.ErrClaim
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	for token, e := range m.data {
		if !now.Before(e.expires) {
			delete(m.data, token)
		}
	}
	m.data[claim.Token] = entry{claim: claim, expires: now.Add(claimTTL)}
	return nil
}

func (m *Memory) Get(token string) (port.ShareClaim, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.data[token]
	if !ok || !m.now().Before(e.expires) {
		return port.ShareClaim{}, domain.ErrClaim
	}
	return e.claim, nil
}

var _ port.ClaimStore = (*Memory)(nil)
