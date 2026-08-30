package main

import (
	"log"
	"os"

	"hiromi/internal/app"
)

func main() {
	if err := app.Run(os.Args[1:]); err != nil {
		log.Println(err)
		os.Exit(1)
	}
}
