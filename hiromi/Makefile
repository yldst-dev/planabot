.PHONY: test build run

test:
	go test ./...

build:
	go build -o bin/hiromi ./cmd/hiromi
	go build -o bin/bot ./cmd/bot

run:
	go run ./cmd/hiromi

download:
	go run ./cmd/hiromi download $(ID)

bot:
	go run ./cmd/bot

share:
	go run ./cmd/hiromi share $(ID)
