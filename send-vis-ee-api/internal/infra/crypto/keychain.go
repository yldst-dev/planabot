package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"crypto/hkdf"
)

const (
	SecretSize   = 16
	AuthKeySize  = 64
	MetaKeySize  = 16
	MetaIVSize   = 12
	PBKDF2Rounds = 100
)

type Metadata struct {
	Name     string          `json:"name"`
	Size     int64           `json:"size"`
	Type     string          `json:"type"`
	Manifest json.RawMessage `json:"manifest"`
}

type Keychain struct {
	secret  []byte
	metaKey []byte
	authKey []byte
}

func Generate() (*Keychain, error) {
	secret := make([]byte, SecretSize)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	return FromSecret(secret)
}

func FromSecret(secret []byte) (*Keychain, error) {
	if len(secret) != SecretSize {
		return nil, fmt.Errorf("secret must be %d bytes", SecretSize)
	}
	metaKey, err := hkdf.Key(sha256.New, secret, nil, "metadata", MetaKeySize)
	if err != nil {
		return nil, err
	}
	authKey, err := hkdf.Key(sha256.New, secret, nil, "authentication", AuthKeySize)
	if err != nil {
		return nil, err
	}
	out := &Keychain{
		secret:  append([]byte(nil), secret...),
		metaKey: metaKey,
		authKey: authKey,
	}
	return out, nil
}

func (k *Keychain) Secret() []byte {
	return append([]byte(nil), k.secret...)
}

func (k *Keychain) SecretEncoded() string {
	return Encode(k.secret)
}

func (k *Keychain) AuthKey() []byte {
	return append([]byte(nil), k.authKey...)
}

func (k *Keychain) AuthKeyEncoded() string {
	return Encode(k.authKey)
}

func (k *Keychain) SetPassword(password, shareURL string) error {
	key, err := pbkdf2.Key(sha256.New, password, []byte(shareURL), PBKDF2Rounds, AuthKeySize)
	if err != nil {
		return err
	}
	k.authKey = key
	return nil
}

func (k *Keychain) AuthHeader(nonce []byte) string {
	mac := hmac.New(sha256.New, k.authKey)
	mac.Write(nonce)
	return "send-v1 " + Encode(mac.Sum(nil))
}

func (k *Keychain) EncryptMetadata(meta Metadata) ([]byte, error) {
	if meta.Type == "" {
		meta.Type = "application/octet-stream"
	}
	if len(meta.Manifest) == 0 {
		meta.Manifest = []byte("{}")
	}
	plain, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(k.metaKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	iv := make([]byte, MetaIVSize)
	return gcm.Seal(nil, iv, plain, nil), nil
}

func (k *Keychain) DecryptMetadata(ciphertext []byte) (Metadata, error) {
	block, err := aes.NewCipher(k.metaKey)
	if err != nil {
		return Metadata{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return Metadata{}, err
	}
	iv := make([]byte, MetaIVSize)
	plain, err := gcm.Open(nil, iv, ciphertext, nil)
	if err != nil {
		return Metadata{}, err
	}
	var meta Metadata
	if err := json.Unmarshal(plain, &meta); err != nil {
		return Metadata{}, err
	}
	return meta, nil
}

func DeriveAuthKey(secret []byte, password, shareURL string) ([]byte, error) {
	kc, err := FromSecret(secret)
	if err != nil {
		return nil, err
	}
	if password != "" {
		if err := kc.SetPassword(password, shareURL); err != nil {
			return nil, err
		}
	}
	return kc.AuthKey(), nil
}
