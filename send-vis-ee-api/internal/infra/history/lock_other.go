//go:build !(darwin || dragonfly || freebsd || linux || netbsd || openbsd)

package history

func lockFile(string) (func(), error) {
	return func() {}, nil
}
