package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yldst-dev/send.vis.ee-api/internal/config"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/history"
	"github.com/yldst-dev/send.vis.ee-api/internal/infra/sendhost"
	"github.com/yldst-dev/send.vis.ee-api/internal/usecase"
)

func Run(args []string) error {
	if len(args) == 0 {
		printUsage()
		return fmt.Errorf("command required")
	}
	cfg := config.FromEnv()
	host, err := sendhost.New(cfg.Host, sendhost.WithUserAgent(cfg.UserAgent))
	if err != nil {
		return err
	}
	store, err := history.OpenJSON(cfg.HistoryPath)
	if err != nil {
		return err
	}
	svc := usecase.New(host, store)
	ctx := context.Background()
	switch args[0] {
	case "upload":
		return upload(ctx, svc, args[1:])
	case "list":
		return list(ctx, svc)
	case "info":
		return info(ctx, svc, args[1:])
	case "download":
		return download(ctx, svc, args[1:])
	case "delete":
		return del(ctx, svc, args[1:])
	case "password":
		return password(ctx, svc, args[1:])
	case "limit":
		return limit(ctx, svc, args[1:])
	case "exists":
		return exists(ctx, svc, args[1:])
	case "instance":
		return instance(ctx, svc)
	default:
		printUsage()
		return fmt.Errorf("unknown command %s", args[0])
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `sendvis <command>

commands:
  upload FILE [--downloads N] [--expire SEC] [--password PASS]
  list
  info ID_OR_URL
  download ID_OR_URL [-o PATH] [--password PASS]
  delete ID_OR_URL
  password ID_OR_URL PASS
  limit ID_OR_URL N
  exists ID_OR_URL
  instance`)
}

func upload(ctx context.Context, svc *usecase.Service, args []string) error {
	fs := flag.NewFlagSet("upload", flag.ContinueOnError)
	downloads := fs.Int("downloads", 0, "download limit")
	expire := fs.Int("expire", 0, "expiry seconds")
	password := fs.String("password", "", "optional password")
	if err := parseCLI(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("upload FILE")
	}
	path := fs.Arg(0)
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	file, err := svc.Upload(ctx, usecase.UploadInput{
		Name:      filepath.Base(path),
		Size:      st.Size(),
		Body:      f,
		Downloads: *downloads,
		ExpireSec: *expire,
		Password:  *password,
	})
	if err != nil {
		return err
	}
	return printJSON(file)
}

func list(ctx context.Context, svc *usecase.Service) error {
	files, err := svc.List(ctx)
	if err != nil {
		return err
	}
	return printJSON(files)
}

func info(ctx context.Context, svc *usecase.Service, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("info ID_OR_URL")
	}
	file, err := svc.Get(ctx, args[0], true)
	if err != nil {
		return err
	}
	return printJSON(file)
}

func download(ctx context.Context, svc *usecase.Service, args []string) error {
	fs := flag.NewFlagSet("download", flag.ContinueOnError)
	out := fs.String("o", ".", "output file or directory")
	password := fs.String("password", "", "password")
	if err := parseCLI(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("download ID_OR_URL")
	}
	body, meta, err := svc.Download(ctx, usecase.DownloadInput{
		URL:      fs.Arg(0),
		Password: *password,
	})
	if err != nil {
		return err
	}
	defer body.Close()
	dest := *out
	if st, err := os.Stat(dest); err == nil && st.IsDir() {
		dest = filepath.Join(dest, meta.Name)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.Copy(f, body)
	if err != nil {
		return err
	}
	fmt.Printf("saved %s (%d bytes)\n", dest, n)
	return nil
}

func del(ctx context.Context, svc *usecase.Service, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("delete ID_OR_URL")
	}
	return svc.Delete(ctx, args[0])
}

func password(ctx context.Context, svc *usecase.Service, args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("password ID_OR_URL PASS")
	}
	file, err := svc.SetPassword(ctx, usecase.PasswordInput{ID: args[0], Password: args[1]})
	if err != nil {
		return err
	}
	return printJSON(file)
}

func limit(ctx context.Context, svc *usecase.Service, args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("limit ID_OR_URL N")
	}
	n, err := strconv.Atoi(args[1])
	if err != nil {
		return err
	}
	file, err := svc.SetDownloadLimit(ctx, usecase.LimitInput{ID: args[0], Limit: n})
	if err != nil {
		return err
	}
	return printJSON(file)
}

func exists(ctx context.Context, svc *usecase.Service, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("exists ID_OR_URL")
	}
	res, err := svc.Exists(ctx, args[0])
	if err != nil {
		return err
	}
	return printJSON(res)
}

func instance(ctx context.Context, svc *usecase.Service) error {
	inst, err := svc.Instance(ctx)
	if err != nil {
		return err
	}
	return printJSON(inst)
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func parseCLI(fs *flag.FlagSet, args []string) error {
	boolName := map[string]bool{}
	fs.VisitAll(func(f *flag.Flag) {
		if f.DefValue == "true" || f.DefValue == "false" {
			boolName[f.Name] = true
		}
	})
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "-") {
			pos = append(pos, a)
			continue
		}
		flags = append(flags, a)
		name := strings.TrimLeft(a, "-")
		if strings.Contains(name, "=") {
			continue
		}
		if boolName[name] {
			continue
		}
		if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			i++
			flags = append(flags, args[i])
		}
	}
	return fs.Parse(append(flags, pos...))
}
