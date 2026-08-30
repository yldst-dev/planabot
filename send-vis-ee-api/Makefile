.PHONY: test build run tidy

test:
	go test ./...

build:
	mkdir -p bin
	go build -o bin/sendvis-api ./cmd/api
	go build -o bin/sendvis ./cmd/sendvis

run:
	go run ./cmd/api

tidy:
	go mod tidy
