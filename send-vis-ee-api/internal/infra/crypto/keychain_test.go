package crypto

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestMetadataRoundTrip(t *testing.T) {
	kc, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	meta := Metadata{
		Name:     "비밀.txt",
		Size:     42,
		Type:     "text/plain",
		Manifest: json.RawMessage(`{"files":[{"name":"비밀.txt","size":42,"type":"text/plain"}]}`),
	}
	ct, err := kc.EncryptMetadata(meta)
	if err != nil {
		t.Fatal(err)
	}
	got, err := kc.DecryptMetadata(ct)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != meta.Name || got.Size != meta.Size || got.Type != meta.Type {
		t.Fatalf("%+v", got)
	}
}

func TestFromSecretStable(t *testing.T) {
	secret := bytes.Repeat([]byte{0x07}, 16)
	a, err := FromSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	b, err := FromSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	if a.AuthKeyEncoded() != b.AuthKeyEncoded() {
		t.Fatal("auth key mismatch")
	}
	if a.SecretEncoded() != Encode(secret) {
		t.Fatal("secret encoding")
	}
	if len(a.AuthKey()) != AuthKeySize {
		t.Fatalf("auth key size %d", len(a.AuthKey()))
	}
}

func TestPasswordChangesAuthKey(t *testing.T) {
	kc, err := FromSecret(bytes.Repeat([]byte{0x08}, 16))
	if err != nil {
		t.Fatal(err)
	}
	before := kc.AuthKeyEncoded()
	if err := kc.SetPassword("hunter2", "https://send.vis.ee/download/abc/#xyz"); err != nil {
		t.Fatal(err)
	}
	if kc.AuthKeyEncoded() == before {
		t.Fatal("password should change auth key")
	}
	if len(kc.AuthKey()) != AuthKeySize {
		t.Fatalf("auth key size %d", len(kc.AuthKey()))
	}
}

func TestAuthHeaderDeterministic(t *testing.T) {
	kc, err := FromSecret(bytes.Repeat([]byte{0x09}, 16))
	if err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{0x0a}, 16)
	h1 := kc.AuthHeader(nonce)
	h2 := kc.AuthHeader(nonce)
	if h1 != h2 || h1[:7] != "send-v1" {
		t.Fatalf("%q", h1)
	}
}

func TestB64RoundTrip(t *testing.T) {
	raw := bytes.Repeat([]byte{0xff, 0x00, 0x01}, 7)
	enc := Encode(raw)
	got, err := Decode(enc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, raw) {
		t.Fatal("decode mismatch")
	}
}
