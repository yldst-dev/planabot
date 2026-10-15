package app

import (
	"fmt"
	"testing"

	"hiromi/internal/domain"
)

func TestShareErrCodeNamesKnownFailures(t *testing.T) {
	cases := map[error]string{
		fmt.Errorf("%w: 3000 pages", domain.ErrTooLarge):                           "too_large",
		fmt.Errorf("%w: %w %d", domain.ErrRemote, domain.ErrIDMismatch, uint64(1)): "id_mismatch",
		domain.ErrBusy:   "busy",
		domain.ErrRemote: "",
	}
	for err, want := range cases {
		if got := shareErrCode(err); got != want {
			t.Fatalf("%v: got %q want %q", err, got, want)
		}
	}
}
