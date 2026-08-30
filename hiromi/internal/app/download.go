package app

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"hiromi/internal/domain"
	"hiromi/internal/infra/hitomi"
	"hiromi/internal/infra/localfs"
	"hiromi/internal/infra/viewer"
	"hiromi/internal/usecase"
)

func RunDownload(args []string) error {
	fs := flag.NewFlagSet("download", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dir := fs.String("dir", "", "저장 폴더")
	format := fs.String("format", "webp", "이미지 포맷 webp avif jxl")
	workers := fs.Int("workers", domain.DefaultDownloadWorkers, "동시 내려받기 수")
	skip := fs.Bool("skip", true, "이미 있는 파일은 건너뜀")
	video := fs.Bool("video", true, "영상이 있으면 함께 받음")
	if err := fs.Parse(args); err != nil {
		return err
	}
	ids := make([]uint64, 0, fs.NArg())
	for _, raw := range fs.Args() {
		id, err := strconv.ParseUint(raw, 10, 64)
		if err != nil || id == 0 {
			return fmt.Errorf("%w: %s", domain.ErrInvalidID, raw)
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return fmt.Errorf("%w: 품번이 필요합니다", domain.ErrInvalidID)
	}
	imgFormat, err := domain.ParseImageFormat(*format)
	if err != nil {
		return err
	}
	cfg := LoadConfig()
	if *dir != "" {
		cfg.DownloadDir = *dir
	}
	store, err := localfs.New(cfg.DownloadDir)
	if err != nil {
		return err
	}
	client := hitomi.New(cfg.DownloadHTTP)
	svc := usecase.NewDownloadService(client, client, client, store, cfg.Hitomi.Front).WithViewer(viewer.New())
	opt := domain.DownloadOptions{
		Format:       imgFormat,
		Workers:      *workers,
		IncludeVideo: *video,
		SkipExisting: *skip,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	for _, id := range ids {
		fmt.Fprintf(os.Stderr, "작품 %d 파싱 후 내려받는 중\n", id)
		res, err := svc.Download(ctx, id, opt)
		if err != nil {
			return fmt.Errorf("작품 %d: %w", id, err)
		}
		fmt.Fprintf(os.Stderr, "작품 %d %s 저장 %s 받음 %d 건너뜀 %d 실패 %d\n",
			res.GalleryID, res.Title, res.Dir, len(res.Saved), len(res.Skipped), len(res.Failed))
		if res.Viewer != "" {
			fmt.Fprintf(os.Stderr, "  뷰어 %s\n", res.Viewer)
		}
		for _, fail := range res.Failed {
			fmt.Fprintf(os.Stderr, "  실패 %s: %s\n", fail.Name, fail.Error)
		}
	}
	return nil
}
