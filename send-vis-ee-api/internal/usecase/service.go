package usecase

import (
	"context"
	"errors"
	"io"
	"mime"
	"path/filepath"
	"strings"
	"time"

	"github.com/yldst-dev/send.vis.ee-api/internal/domain"
	scrypto "github.com/yldst-dev/send.vis.ee-api/internal/infra/crypto"
)

type Service struct {
	host FileHost
	repo FileRepository
}

type FileHost interface {
	Host() string
	HostGateway
}

func New(host FileHost, repo FileRepository) *Service {
	return &Service{host: host, repo: repo}
}

func (s *Service) Instance(ctx context.Context) (Instance, error) {
	return s.host.Instance(ctx)
}

func (s *Service) resolveLimits(ctx context.Context) domain.Limits {
	inst, err := s.host.Instance(ctx)
	if err != nil {
		return domain.FallbackLimits()
	}
	return inst.Limits.WithDefaults()
}

func (s *Service) Upload(ctx context.Context, in UploadInput) (*domain.ManagedFile, error) {
	if in.Size <= 0 {
		return nil, domain.ErrEmptyFile
	}
	name := filepath.Base(strings.ReplaceAll(in.Name, "\\", "/"))
	if name == "" || name == "." {
		name = "file"
	}
	mimeType := in.MIME
	if mimeType == "" {
		mimeType = mime.TypeByExtension(filepath.Ext(name))
	}
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	limits := s.resolveLimits(ctx)
	downloads := in.Downloads
	if downloads == 0 {
		downloads = limits.DefaultDownloads
	}
	expire := in.ExpireSec
	if expire == 0 {
		expire = limits.DefaultExpire
	}
	if err := limits.ValidateUpload(in.Size, downloads, expire); err != nil {
		return nil, err
	}
	file, err := s.host.Upload(ctx, UploadRequest{
		Name:      name,
		MIME:      mimeType,
		Size:      in.Size,
		Body:      in.Body,
		Downloads: downloads,
		ExpireSec: expire,
	})
	if err != nil {
		return nil, err
	}
	if in.Password != "" {
		secret, err := scrypto.Decode(file.Secret)
		if err != nil {
			return nil, err
		}
		if err := s.host.SetPassword(ctx, file.ID, file.OwnerToken, secret, in.Password, file.URL); err != nil {
			return nil, err
		}
		file.HasPassword = true
	}
	if err := s.repo.Save(ctx, file); err != nil {
		return nil, err
	}
	return file, nil
}

func (s *Service) List(ctx context.Context) ([]*domain.ManagedFile, error) {
	return s.repo.List(ctx)
}

func (s *Service) Get(ctx context.Context, idOrURL string, refresh bool) (*domain.ManagedFile, error) {
	file, err := s.lookup(ctx, idOrURL)
	if err != nil {
		return nil, err
	}
	if !refresh || file.OwnerToken == "" {
		return file, nil
	}
	info, err := s.host.OwnerInfo(ctx, file.ID, file.OwnerToken)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			file.DownloadCount = file.DownloadMax
			file.ExpiresAt = time.Now()
			_ = s.repo.Save(ctx, file)
			return file, domain.ErrExpired
		}
		return file, err
	}
	file.DownloadMax = info.DownloadLimit
	file.DownloadCount = info.DownloadCount
	if info.TTLMillis > 0 {
		file.ExpiresAt = time.Now().Add(time.Duration(info.TTLMillis) * time.Millisecond)
	}
	_ = s.repo.Save(ctx, file)
	return file, nil
}

func (s *Service) Delete(ctx context.Context, idOrURL string) error {
	file, err := s.lookup(ctx, idOrURL)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			ref, perr := s.parseRef(idOrURL)
			if perr != nil {
				return err
			}
			return s.host.Delete(ctx, ref.ID, "")
		}
		return err
	}
	if file.OwnerToken == "" {
		return domain.ErrOwnerTokenMissing
	}
	if err := s.host.Delete(ctx, file.ID, file.OwnerToken); err != nil && !errors.Is(err, domain.ErrNotFound) {
		return err
	}
	return s.repo.Delete(ctx, file.ID)
}

func (s *Service) DeleteRemote(ctx context.Context, id, ownerToken string) error {
	if !domain.ValidFileID(id) {
		return domain.ErrInvalidID
	}
	if ownerToken == "" {
		return domain.ErrOwnerTokenMissing
	}
	if err := s.host.Delete(ctx, id, ownerToken); err != nil {
		return err
	}
	_ = s.repo.Delete(ctx, id)
	return nil
}

func (s *Service) SetPassword(ctx context.Context, in PasswordInput) (*domain.ManagedFile, error) {
	if in.Password == "" {
		return nil, domain.ErrInvalidParameter
	}
	file, err := s.lookup(ctx, firstNonEmpty(in.ID, in.URL))
	if err != nil {
		return nil, err
	}
	if file.OwnerToken == "" {
		return nil, domain.ErrOwnerTokenMissing
	}
	secret, err := scrypto.Decode(file.Secret)
	if err != nil {
		return nil, err
	}
	if err := s.host.SetPassword(ctx, file.ID, file.OwnerToken, secret, in.Password, file.URL); err != nil {
		return nil, err
	}
	file.HasPassword = true
	if err := s.repo.Save(ctx, file); err != nil {
		return nil, err
	}
	return file, nil
}

func (s *Service) SetDownloadLimit(ctx context.Context, in LimitInput) (*domain.ManagedFile, error) {
	file, err := s.lookup(ctx, firstNonEmpty(in.ID, in.URL))
	if err != nil {
		return nil, err
	}
	if file.OwnerToken == "" {
		return nil, domain.ErrOwnerTokenMissing
	}
	limits := s.resolveLimits(ctx)
	if in.Limit <= 0 || in.Limit > limits.MaxDownloads {
		return nil, domain.ErrLimitExceeded
	}
	if err := s.host.SetDownloadLimit(ctx, file.ID, file.OwnerToken, in.Limit); err != nil {
		return nil, err
	}
	file.DownloadMax = in.Limit
	if err := s.repo.Save(ctx, file); err != nil {
		return nil, err
	}
	return file, nil
}

func (s *Service) Exists(ctx context.Context, idOrURL string) (*ExistsResult, error) {
	ref, err := s.parseRef(idOrURL)
	if err != nil {
		return nil, err
	}
	return s.host.Exists(ctx, ref.ID)
}

func (s *Service) Inspect(ctx context.Context, idOrURL, password string) (*RemoteMetadata, *domain.ManagedFile, error) {
	file, localErr := s.lookup(ctx, idOrURL)
	var secret []byte
	var id, shareURL string
	if localErr == nil {
		var err error
		secret, err = scrypto.Decode(file.Secret)
		if err != nil {
			return nil, nil, err
		}
		id = file.ID
		shareURL = file.URL
		if password == "" && file.HasPassword {
			return nil, file, domain.ErrPasswordRequired
		}
	} else {
		ref, err := s.parseRef(idOrURL)
		if err != nil {
			return nil, nil, err
		}
		if ref.Secret == "" {
			return nil, nil, domain.ErrSecretMissing
		}
		secret, err = scrypto.Decode(ref.Secret)
		if err != nil {
			return nil, nil, err
		}
		id = ref.ID
		shareURL = domain.BuildShareURL(s.hostFor(ref), id, ref.Secret)
	}
	meta, err := s.host.Metadata(ctx, id, secret, password, shareURL)
	if err != nil {
		return nil, file, err
	}
	return meta, file, nil
}

func (s *Service) Download(ctx context.Context, in DownloadInput) (io.ReadCloser, *RemoteMetadata, error) {
	key := firstNonEmpty(in.ID, in.URL)
	file, localErr := s.lookup(ctx, key)
	var secret []byte
	var id, shareURL, password string
	password = in.Password
	if localErr == nil {
		var err error
		secret, err = scrypto.Decode(file.Secret)
		if err != nil {
			return nil, nil, err
		}
		id = file.ID
		shareURL = file.URL
	} else {
		ref, err := s.parseRef(key)
		if err != nil {
			return nil, nil, err
		}
		if ref.Secret == "" {
			return nil, nil, domain.ErrSecretMissing
		}
		secret, err = scrypto.Decode(ref.Secret)
		if err != nil {
			return nil, nil, err
		}
		id = ref.ID
		shareURL = domain.BuildShareURL(s.hostFor(ref), id, ref.Secret)
	}
	meta, err := s.host.Metadata(ctx, id, secret, password, shareURL)
	if err != nil {
		return nil, nil, err
	}
	body, err := s.host.Download(ctx, id, secret, password, shareURL)
	if err != nil {
		return nil, nil, err
	}
	return body, meta, nil
}

func (s *Service) Import(ctx context.Context, in ImportInput) (*domain.ManagedFile, error) {
	ref, err := domain.ParseShareURL(in.URL)
	if err != nil {
		return nil, err
	}
	if ref.Secret == "" {
		return nil, domain.ErrSecretMissing
	}
	secret, err := scrypto.Decode(ref.Secret)
	if err != nil {
		return nil, err
	}
	host := s.hostFor(ref)
	shareURL := domain.BuildShareURL(host, ref.ID, ref.Secret)
	meta, err := s.host.Metadata(ctx, ref.ID, secret, in.Password, shareURL)
	if err != nil {
		return nil, err
	}
	file := &domain.ManagedFile{
		ID:          ref.ID,
		Host:        host,
		URL:         shareURL,
		DownloadURL: domain.BuildDownloadURL(host, ref.ID),
		Name:        meta.Name,
		Size:        meta.Size,
		MIME:        meta.MIME,
		Secret:      ref.Secret,
		OwnerToken:  in.OwnerToken,
		HasPassword: in.Password != "" || meta.RequiresPass,
		Manifest:    meta.Manifest,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(time.Duration(meta.TTLMillis) * time.Millisecond),
	}
	if in.OwnerToken != "" {
		if info, err := s.host.OwnerInfo(ctx, ref.ID, in.OwnerToken); err == nil {
			file.DownloadMax = info.DownloadLimit
			file.DownloadCount = info.DownloadCount
			if info.TTLMillis > 0 {
				file.ExpiresAt = time.Now().Add(time.Duration(info.TTLMillis) * time.Millisecond)
			}
		}
	}
	if err := s.repo.Save(ctx, file); err != nil {
		return nil, err
	}
	return file, nil
}

func (s *Service) lookup(ctx context.Context, idOrURL string) (*domain.ManagedFile, error) {
	ref, err := s.parseRef(idOrURL)
	if err != nil {
		return nil, err
	}
	return s.repo.Get(ctx, ref.ID)
}

func (s *Service) parseRef(idOrURL string) (domain.ShareRef, error) {
	idOrURL = strings.TrimSpace(idOrURL)
	if idOrURL == "" {
		return domain.ShareRef{}, domain.ErrInvalidID
	}
	return domain.ParseShareURL(idOrURL)
}

func (s *Service) hostFor(ref domain.ShareRef) string {
	if ref.Host != "" {
		return ref.Host
	}
	return s.host.Host()
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
