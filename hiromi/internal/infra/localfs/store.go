package localfs

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"hiromi/internal/domain"
	"hiromi/internal/port"
)

type Store struct {
	root string
}

func New(root string) (*Store, error) {
	if root == "" {
		root = "downloads"
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	return &Store{root: abs}, nil
}

func (s *Store) Root() string {
	return s.root
}

func (s *Store) resolve(relPath string) (string, error) {
	if relPath == "" || strings.Contains(relPath, "..") {
		return "", fmt.Errorf("%w: path", domain.ErrStorage)
	}
	clean := filepath.Clean("/" + relPath)
	clean = strings.TrimPrefix(clean, string(os.PathSeparator))
	if clean == "." || clean == "" {
		return "", fmt.Errorf("%w: path", domain.ErrStorage)
	}
	full := filepath.Join(s.root, clean)
	root := s.root
	if !strings.HasSuffix(root, string(os.PathSeparator)) {
		root += string(os.PathSeparator)
	}
	if full != s.root && !strings.HasPrefix(full, root) {
		return "", fmt.Errorf("%w: path", domain.ErrStorage)
	}
	return full, nil
}

func (s *Store) Exists(relPath string) (bool, int64, error) {
	full, err := s.resolve(relPath)
	if err != nil {
		return false, 0, err
	}
	info, err := os.Stat(full)
	if err != nil {
		if os.IsNotExist(err) {
			return false, 0, nil
		}
		return false, 0, fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	if info.IsDir() {
		return false, 0, nil
	}
	return true, info.Size(), nil
}

func (s *Store) Read(relPath string) ([]byte, error) {
	full, err := s.resolve(relPath)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(full)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, domain.ErrNotFound
		}
		return nil, fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	return b, nil
}

func (s *Store) Write(relPath string, r io.Reader) (int64, error) {
	full, err := s.resolve(relPath)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return 0, fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	tmp := full + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	n, copyErr := io.Copy(f, r)
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return 0, fmt.Errorf("%w: %v", domain.ErrStorage, copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return 0, fmt.Errorf("%w: %v", domain.ErrStorage, closeErr)
	}
	if err := os.Rename(tmp, full); err != nil {
		_ = os.Remove(tmp)
		return 0, fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	return n, nil
}

func (s *Store) RemoveAll(relPath string) error {
	full, err := s.resolve(relPath)
	if err != nil {
		return err
	}
	if full == s.root {
		return fmt.Errorf("%w: path", domain.ErrStorage)
	}
	if err := os.RemoveAll(full); err != nil {
		return fmt.Errorf("%w: %v", domain.ErrStorage, err)
	}
	return nil
}

var _ port.FileStore = (*Store)(nil)
