package localfs

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hiromi/internal/domain"
)

func TestWriteAndExists(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	n, err := s.Write("42/001.webp", strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("n=%d", n)
	}
	ok, size, err := s.Exists("42/001.webp")
	if err != nil || !ok || size != 5 {
		t.Fatalf("exists %v %d %v", ok, size, err)
	}
	b, err := os.ReadFile(filepath.Join(root, "42", "001.webp"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "hello" {
		t.Fatalf("got %q", b)
	}
	if _, err := os.Stat(filepath.Join(root, "42", "001.webp.part")); !os.IsNotExist(err) {
		t.Fatal("part file left")
	}
	got, err := s.Read("42/001.webp")
	if err != nil || string(got) != "hello" {
		t.Fatalf("read %q %v", got, err)
	}
}

func TestRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write("../etc/passwd", strings.NewReader("x")); err == nil {
		t.Fatal("expected error")
	}
}

func TestRemoveAll(t *testing.T) {
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write("99/001.webp", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveAll("99"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "99")); !os.IsNotExist(err) {
		t.Fatal("dir left")
	}
	if err := s.RemoveAll(""); err == nil {
		t.Fatal("empty path")
	}
}

type failingReader struct{ err error }

func (f failingReader) Read([]byte) (int, error) { return 0, f.err }

func TestWriteKeepsReaderErrorAndOpenStreams(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cause := fmt.Errorf("%w: connection reset", domain.ErrRemote)
	if _, err := s.Write("7/001.webp", failingReader{err: cause}); !errors.Is(err, domain.ErrRemote) || !errors.Is(err, domain.ErrStorage) {
		t.Fatalf("write error %v", err)
	}
	if _, err := s.Write("7/viewer.html", strings.NewReader("<html>")); err != nil {
		t.Fatal(err)
	}
	f, err := s.Open("7/viewer.html")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil || string(b) != "<html>" {
		t.Fatalf("open %q %v", b, err)
	}
	if _, err := s.Open("7/missing.html"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing %v", err)
	}
}
