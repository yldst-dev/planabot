package crypto

import (
	"bytes"
	"io"
	"testing"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	ikm := bytes.Repeat([]byte{0x11}, 16)
	sizes := []int{1, 15, 16, 17, 64, 1024, RecordSize - 18, RecordSize - 17, RecordSize - 16, RecordSize, RecordSize + 1, 100_000}
	for _, n := range sizes {
		plain := bytes.Repeat([]byte{byte(n)}, n)
		var enc bytes.Buffer
		err := EncryptEach(bytes.NewReader(plain), ikm, func(p []byte) error {
			_, werr := enc.Write(p)
			return werr
		})
		if err != nil {
			t.Fatalf("size %d encrypt: %v", n, err)
		}
		got, err := io.ReadAll(Decrypt(&enc, ikm))
		if err != nil {
			t.Fatalf("size %d decrypt: %v", n, err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("size %d mismatch got %d want %d", n, len(got), len(plain))
		}
	}
}

func TestEncryptEmptyFileHeaderOnly(t *testing.T) {
	ikm := bytes.Repeat([]byte{0x22}, 16)
	var enc bytes.Buffer
	if err := EncryptEach(bytes.NewReader(nil), ikm, func(p []byte) error {
		_, err := enc.Write(p)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if enc.Len() != HeaderLen {
		t.Fatalf("header length %d", enc.Len())
	}
	got, err := io.ReadAll(Decrypt(&enc, ikm))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d bytes", len(got))
	}
}

func TestEncryptedSizeMatchesStream(t *testing.T) {
	ikm := bytes.Repeat([]byte{0x33}, 16)
	for _, n := range []int64{1, 100, 65519, 65520, 200000} {
		plain := make([]byte, n)
		var enc bytes.Buffer
		if err := EncryptEach(bytes.NewReader(plain), ikm, func(p []byte) error {
			_, err := enc.Write(p)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if int64(enc.Len()) != EncryptedSize(n) {
			t.Fatalf("n=%d encoded=%d formula=%d", n, enc.Len(), EncryptedSize(n))
		}
	}
}

func TestDecryptRejectsTamper(t *testing.T) {
	ikm := bytes.Repeat([]byte{0x44}, 16)
	plain := []byte("hello send")
	var enc bytes.Buffer
	if err := EncryptEach(bytes.NewReader(plain), ikm, func(p []byte) error {
		_, err := enc.Write(p)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	buf := enc.Bytes()
	buf[len(buf)-1] ^= 0x01
	_, err := io.ReadAll(Decrypt(bytes.NewReader(buf), ikm))
	if err == nil {
		t.Fatal("expected error")
	}
}
