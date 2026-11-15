package viewer

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"hiromi/internal/domain"
)

func fakeEncoder(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cwebp")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func useTools(t *testing.T, tools toolPaths) {
	t.Helper()
	prev := lookupTools
	lookupTools = func() toolPaths { return tools }
	t.Cleanup(func() { lookupTools = prev })
}

func TestShrinkLeavesTheImageAloneWithoutEncoders(t *testing.T) {
	useTools(t, toolPaths{})
	format, data := shrink(domain.FormatJXL, []byte("image"))
	if format != domain.FormatJXL || string(data) != "image" {
		t.Fatalf("%s %q", format, data)
	}
}

func TestShrinkUsesTheWebPEncoderWhenOnlyItExists(t *testing.T) {
	useTools(t, toolPaths{cwebp: fakeEncoder(t, `printf small > "$9"`)})
	format, data := shrink(domain.FormatJXL, []byte("image"))
	if format != domain.FormatWebP || string(data) != "small" {
		t.Fatalf("%s %q", format, data)
	}
}

func TestShrinkGivesUpOnAnEncoderThatHangs(t *testing.T) {
	useTools(t, toolPaths{cwebp: fakeEncoder(t, "exec sleep 30")})
	prev := encodeTimeout
	encodeTimeout = 200 * time.Millisecond
	defer func() { encodeTimeout = prev }()
	started := time.Now()
	format, data := shrink(domain.FormatAVIF, []byte("image"))
	if format != domain.FormatAVIF || string(data) != "image" {
		t.Fatalf("%s %q", format, data)
	}
	if time.Since(started) > 10*time.Second {
		t.Fatalf("took %s", time.Since(started))
	}
}
