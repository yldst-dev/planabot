package domain

import (
	"errors"
	"net/http"
	"testing"
)

func TestRetryableStatus(t *testing.T) {
	if Retryable(ErrNotFound) {
		t.Fatal("404")
	}
	if Retryable(&RemoteStatusError{Status: http.StatusForbidden}) {
		t.Fatal("403")
	}
	if !Retryable(&RemoteStatusError{Status: http.StatusServiceUnavailable}) {
		t.Fatal("503")
	}
	if !Retryable(&RemoteStatusError{Status: http.StatusTooManyRequests}) {
		t.Fatal("429")
	}
	if !Retryable(ErrRemote) {
		t.Fatal("generic remote")
	}
	err := &RemoteStatusError{Status: 503}
	if !errors.Is(err, ErrRemote) {
		t.Fatal("unwrap")
	}
	if StatusOf(err) != 503 {
		t.Fatalf("status %d", StatusOf(err))
	}
}
