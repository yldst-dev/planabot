package jobstore

import (
	"errors"
	"testing"
	"time"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

func TestClaimsExpireAndExpiredOnesArePruned(t *testing.T) {
	now := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	m := NewMemory()
	m.now = func() time.Time { return now }

	if err := m.Put(port.ShareClaim{Token: "old", URL: "https://send.vis.ee/download/a/#s"}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(claimTTL - time.Second)
	if c, err := m.Get("old"); err != nil || c.URL == "" {
		t.Fatalf("before expiry: %+v %v", c, err)
	}
	if err := m.Put(port.ShareClaim{Token: "fresh"}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if _, err := m.Get("old"); !errors.Is(err, domain.ErrClaim) {
		t.Fatalf("after expiry: %v", err)
	}
	if _, err := m.Get("fresh"); err != nil {
		t.Fatalf("fresh claim: %v", err)
	}
	now = now.Add(claimTTL)
	if err := m.Put(port.ShareClaim{Token: "latest"}); err != nil {
		t.Fatal(err)
	}
	if len(m.data) != 1 {
		t.Fatalf("entries kept %d", len(m.data))
	}
}

func TestClaimWithoutTokenIsRejected(t *testing.T) {
	if err := NewMemory().Put(port.ShareClaim{}); !errors.Is(err, domain.ErrClaim) {
		t.Fatalf("%v", err)
	}
}
