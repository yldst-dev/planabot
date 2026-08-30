package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	RecordSize  = 64 * 1024
	TagLength   = 16
	KeyLength   = 16
	NonceLength = 12
	HeaderLen   = 21
	PadDelimMid = 0x01
	PadDelimEnd = 0x02
)

var (
	errRecord    = errors.New("invalid ece record")
	errHeader    = errors.New("invalid ece header")
	errDelimiter = errors.New("invalid ece padding delimiter")
	eceKeyInfo   = "Content-Encoding: aes128gcm\x00"
	eceNonceInfo = "Content-Encoding: nonce\x00"
)

func EncryptedSize(n int64) int64 {
	const meta = TagLength + 1
	inner := int64(RecordSize - meta)
	if n <= 0 {
		return HeaderLen
	}
	records := (n + inner - 1) / inner
	return HeaderLen + n + meta*records
}

func deriveECE(ikm, salt []byte) (key, nonce []byte, err error) {
	key, err = hkdf.Key(sha256.New, ikm, salt, eceKeyInfo, KeyLength)
	if err != nil {
		return nil, nil, err
	}
	nonce, err = hkdf.Key(sha256.New, ikm, salt, eceNonceInfo, NonceLength)
	if err != nil {
		return nil, nil, err
	}
	return key, nonce, nil
}

func xorNonce(base []byte, seq uint32) []byte {
	out := append([]byte(nil), base...)
	n := binary.BigEndian.Uint32(out[len(out)-4:])
	binary.BigEndian.PutUint32(out[len(out)-4:], n^seq)
	return out
}

func pad(data []byte, rs int, last bool) []byte {
	if last {
		out := make([]byte, len(data)+1)
		copy(out, data)
		out[len(data)] = PadDelimEnd
		return out
	}
	padLen := rs - len(data) - TagLength
	out := make([]byte, len(data)+padLen)
	copy(out, data)
	out[len(data)] = PadDelimMid
	return out
}

func unpad(data []byte, last bool) ([]byte, error) {
	for i := len(data) - 1; i >= 0; i-- {
		if data[i] == 0 {
			continue
		}
		if last {
			if data[i] != PadDelimEnd {
				return nil, errDelimiter
			}
		} else if data[i] != PadDelimMid {
			return nil, errDelimiter
		}
		return data[:i], nil
	}
	return nil, errDelimiter
}

func encryptRecord(key, nonceBase []byte, seq uint32, plain []byte, rs int, last bool) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Seal(nil, xorNonce(nonceBase, seq), pad(plain, rs, last), nil), nil
}

func decryptRecord(key, nonceBase []byte, seq uint32, record []byte, last bool) ([]byte, error) {
	if len(record) < TagLength+1 {
		return nil, errRecord
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, xorNonce(nonceBase, seq), record, nil)
	if err != nil {
		return nil, err
	}
	return unpad(plain, last)
}

func buildHeader(salt []byte, rs int) []byte {
	h := make([]byte, HeaderLen)
	copy(h, salt)
	binary.BigEndian.PutUint32(h[16:20], uint32(rs))
	h[20] = 0
	return h
}

func EncryptEach(r io.Reader, ikm []byte, emit func([]byte) error) error {
	return encryptEach(r, ikm, RecordSize, nil, emit)
}

func encryptEach(r io.Reader, ikm []byte, rs int, salt []byte, emit func([]byte) error) error {
	if rs <= TagLength+1 {
		return fmt.Errorf("record size too small")
	}
	if salt == nil {
		salt = make([]byte, KeyLength)
		if _, err := rand.Read(salt); err != nil {
			return err
		}
	}
	key, nonce, err := deriveECE(ikm, salt)
	if err != nil {
		return err
	}
	if err := emit(buildHeader(salt, rs)); err != nil {
		return err
	}
	chunkSize := rs - TagLength - 1
	prev := make([]byte, chunkSize)
	prevN, prevErr := io.ReadFull(r, prev)
	if prevErr == io.EOF {
		return nil
	}
	if prevErr != nil && prevErr != io.ErrUnexpectedEOF {
		return prevErr
	}
	seq := uint32(0)
	for {
		next := make([]byte, chunkSize)
		nextN, nextErr := io.ReadFull(r, next)
		last := false
		switch {
		case nextErr == io.EOF:
			last = true
		case nextErr == io.ErrUnexpectedEOF:
			last = false
		case nextErr != nil:
			return nextErr
		}
		if last && nextN == 0 {
			rec, err := encryptRecord(key, nonce, seq, prev[:prevN], rs, true)
			if err != nil {
				return err
			}
			return emit(rec)
		}
		if nextErr == io.ErrUnexpectedEOF {
			rec, err := encryptRecord(key, nonce, seq, prev[:prevN], rs, false)
			if err != nil {
				return err
			}
			if err := emit(rec); err != nil {
				return err
			}
			seq++
			rec, err = encryptRecord(key, nonce, seq, next[:nextN], rs, true)
			if err != nil {
				return err
			}
			return emit(rec)
		}
		if last {
			rec, err := encryptRecord(key, nonce, seq, prev[:prevN], rs, true)
			if err != nil {
				return err
			}
			return emit(rec)
		}
		rec, err := encryptRecord(key, nonce, seq, prev[:prevN], rs, false)
		if err != nil {
			return err
		}
		if err := emit(rec); err != nil {
			return err
		}
		seq++
		prev, prevN = next, nextN
	}
}

func Decrypt(r io.Reader, ikm []byte) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(decryptTo(pw, r, ikm))
	}()
	return pr
}

func decryptTo(w io.Writer, r io.Reader, ikm []byte) error {
	var hdr [HeaderLen]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return err
	}
	salt := append([]byte(nil), hdr[0:16]...)
	rs := int(binary.BigEndian.Uint32(hdr[16:20]))
	idlen := int(hdr[20])
	if rs <= TagLength+1 {
		return errHeader
	}
	if idlen > 0 {
		if _, err := io.CopyN(io.Discard, r, int64(idlen)); err != nil {
			return err
		}
	}
	key, nonce, err := deriveECE(ikm, salt)
	if err != nil {
		return err
	}
	prev, err := readRecord(r, rs)
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return err
	}
	seq := uint32(0)
	for {
		next, nerr := readRecord(r, rs)
		last := nerr == io.EOF
		if nerr != nil && nerr != io.EOF {
			return nerr
		}
		plain, err := decryptRecord(key, nonce, seq, prev, last)
		if err != nil {
			return err
		}
		if _, err := w.Write(plain); err != nil {
			return err
		}
		if last {
			return nil
		}
		prev = next
		seq++
	}
}

func readRecord(r io.Reader, n int) ([]byte, error) {
	buf := make([]byte, n)
	got, err := io.ReadFull(r, buf)
	if err == io.EOF {
		return nil, io.EOF
	}
	if err == io.ErrUnexpectedEOF {
		if got == 0 {
			return nil, io.EOF
		}
		return buf[:got], nil
	}
	if err != nil {
		return nil, err
	}
	return buf, nil
}
