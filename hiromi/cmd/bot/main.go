package main

import (
	"log"
	"os"

	"hiromi/internal/app"
)

func main() {
	if err := app.RunBot(); err != nil {
		log.Println(err)
		os.Exit(1)
	}
}
