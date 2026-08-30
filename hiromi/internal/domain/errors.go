package domain

import (
	"errors"
	"fmt"
	"net/http"
)

var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidID          = errors.New("invalid gallery id")
	ErrInvalidQuery       = errors.New("invalid query")
	ErrInvalidTag         = errors.New("invalid tag")
	ErrUnavailableFormat  = errors.New("unavailable image format")
	ErrUnavailableThumb   = errors.New("unavailable thumbnail")
	ErrRemote             = errors.New("remote error")
	ErrUnparsableScript   = errors.New("unparsable gg.js")
	ErrEmptyIndex         = errors.New("empty index root")
	ErrUnsupportedFeature = errors.New("unsupported feature")
	ErrStorage            = errors.New("storage error")
	ErrNoViewer           = errors.New("viewer not created")
	ErrPrivateChat        = errors.New("private chat required")
	ErrBusy               = errors.New("job already running")
	ErrClaim              = errors.New("claim not found")
)

type RemoteStatusError struct {
	Status int
}

func (e *RemoteStatusError) Error() string {
	if e == nil {
		return ErrRemote.Error()
	}
	return fmt.Sprintf("%s: status %d", ErrRemote.Error(), e.Status)
}

func (e *RemoteStatusError) Unwrap() error {
	return ErrRemote
}

func StatusOf(err error) int {
	var st *RemoteStatusError
	if errors.As(err, &st) {
		return st.Status
	}
	return 0
}

func Retryable(err error) bool {
	if err == nil || errors.Is(err, ErrNotFound) {
		return false
	}
	switch StatusOf(err) {
	case 0:
		return errors.Is(err, ErrRemote)
	case http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}
