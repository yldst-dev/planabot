package domain

import "errors"

var (
	ErrNotFound          = errors.New("file not found")
	ErrUnauthorized      = errors.New("unauthorized")
	ErrExpired           = errors.New("file expired")
	ErrTooLarge          = errors.New("file too large")
	ErrEmptyFile         = errors.New("empty file")
	ErrInvalidURL        = errors.New("invalid share url")
	ErrInvalidID         = errors.New("invalid file id")
	ErrPasswordRequired  = errors.New("password required")
	ErrInvalidPassword   = errors.New("invalid password")
	ErrLimitExceeded     = errors.New("parameter exceeds host limit")
	ErrInvalidParameter  = errors.New("invalid parameter")
	ErrHost              = errors.New("send host error")
	ErrAlreadyExists     = errors.New("file already in history")
	ErrOwnerTokenMissing = errors.New("owner token required")
	ErrSecretMissing     = errors.New("file secret required")
)
