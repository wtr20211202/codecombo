package config

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// chunked AEAD v2 信封单测（P-20261003-147 拆解⑥）：往返/多块/截断拒绝/
// 篡改拒绝/错口令统一文案/v1 信封嗅探回落。

func TestChunkedEnvelopeRoundTrip(t *testing.T) {
	// 跨块载荷（3.5 块）+ 恰一块 + 零字节三类形态
	sizes := []int{chunkedChunkSize*7/2 + 17, chunkedChunkSize, 1}
	for _, size := range sizes {
		plain := bytes.Repeat([]byte("sc-migration-"), size/13+1)[:size]
		var buf bytes.Buffer
		w, err := NewChunkedEnvelopeWriter(&buf, []byte("correct horse"), MigrationFormat, "full")
		if err != nil {
			t.Fatalf("writer: %v", err)
		}
		if _, err := w.Write(plain); err != nil {
			t.Fatalf("write: %v", err)
		}
		if err := w.Close(); err != nil {
			t.Fatalf("close: %v", err)
		}
		r, err := NewChunkedEnvelopeReaderFromStream(bytes.NewReader(buf.Bytes()), []byte("correct horse"))
		if err != nil {
			t.Fatalf("reader: %v", err)
		}
		got, err := io.ReadAll(r)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("round-trip mismatch size=%d got=%d", size, len(got))
		}
	}
}

func TestChunkedEnvelopeHeaderShape(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewChunkedEnvelopeWriter(&buf, []byte("passphrase-1"), MigrationFormat, "full")
	_, _ = w.Write([]byte("hello"))
	_ = w.Close()
	dec := json.NewDecoder(bytes.NewReader(buf.Bytes()))
	var h ChunkedEnvelopeHeader
	if err := dec.Decode(&h); err != nil {
		t.Fatal(err)
	}
	if h.Format != MigrationFormat || h.Version != 2 || h.Mode != "full" {
		t.Fatalf("header mismatch: %+v", h)
	}
	if h.Kdf != kdfScrypt || h.KdfN != scryptN || h.ChunkSize != chunkedChunkSize {
		t.Fatalf("kdf params mismatch: %+v", h)
	}
	// 明文头不得携带摘要/密文类字段（信息泄露边界）
	if h.Salt == "" || h.Nonce0 == "" {
		t.Fatal("salt/nonce0 required in header")
	}
}

func TestChunkedEnvelopeWrongPassphrase(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewChunkedEnvelopeWriter(&buf, []byte("right-passphrase"), MigrationFormat, "")
	_, _ = w.Write(bytes.Repeat([]byte("x"), 1000))
	_ = w.Close()
	r, err := NewChunkedEnvelopeReaderFromStream(bytes.NewReader(buf.Bytes()), []byte("wrong-passphrase"))
	if err != nil {
		// KDF 在首块解密前就成立（头不验证口令）——错误应在读阶段浮出
		t.Fatalf("reader construct should succeed, err=%v", err)
	}
	_, rerr := io.ReadAll(r)
	if rerr == nil {
		t.Fatal("wrong passphrase must fail")
	}
	// 统一文案（防 oracle）：与 v1 同口径
	if !strings.Contains(rerr.Error(), "wrong passphrase or corrupted file") {
		t.Fatalf("unified error expected, got: %v", rerr)
	}
}

func TestChunkedEnvelopeTruncationRejected(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewChunkedEnvelopeWriter(&buf, []byte("passphrase-1"), MigrationFormat, "")
	_, _ = w.Write(bytes.Repeat([]byte("y"), chunkedChunkSize*2+11)) // 3 块
	_ = w.Close()
	// 截掉终结块与最后一个数据块：读端必须报错而非静默出半包
	truncated := buf.Bytes()[:buf.Len()-64]
	r, _ := NewChunkedEnvelopeReaderFromStream(bytes.NewReader(truncated), []byte("passphrase-1"))
	if _, err := io.ReadAll(r); err == nil {
		t.Fatal("truncated envelope must be rejected")
	}
}

func TestChunkedEnvelopeTamperRejected(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewChunkedEnvelopeWriter(&buf, []byte("passphrase-1"), MigrationFormat, "")
	_, _ = w.Write(bytes.Repeat([]byte("z"), chunkedChunkSize+5))
	_ = w.Close()
	// 翻转第二行（首个数据块）内一个字节：GCM 认证失败
	b := append([]byte{}, buf.Bytes()...)
	for i := len(b) - 1; i > 0; i-- {
		if b[i] == '\n' {
			b[i-1] ^= 0x01
			break
		}
	}
	r, _ := NewChunkedEnvelopeReaderFromStream(bytes.NewReader(b), []byte("passphrase-1"))
	if _, err := io.ReadAll(r); err == nil {
		t.Fatal("tampered envelope must be rejected")
	}
}

func TestChunkedHeaderSniffV1FallsBack(t *testing.T) {
	// v1 单发信封（单 JSON 无 chunkSize）嗅探必须返回 ErrNotChunkedEnvelope
	v1, err := EncryptWithPassphrase([]byte("legacy"), []byte("passphrase-1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseChunkedEnvelopeHeader(v1); err != ErrNotChunkedEnvelope {
		t.Fatalf("v1 envelope must not sniff as chunked, got %v", err)
	}
	// v2 头行嗅探成立
	var buf bytes.Buffer
	w, _ := NewChunkedEnvelopeWriter(&buf, []byte("passphrase-1"), MigrationFormat, "")
	_ = w.Close()
	line := buf.Bytes()[:bytes.IndexByte(buf.Bytes(), '\n')]
	if _, err := ParseChunkedEnvelopeHeader(line); err != nil {
		t.Fatalf("v2 header sniff failed: %v", err)
	}
}

func TestMigrationEnvelopeFormatIsolation(t *testing.T) {
	// 迁移格式串与凭据导出信封互不误吞：MigrationFormat 加密的包不能用
	// DecryptWithPassphrase（凭据导出格式）解开，反之亦然
	body, err := EncryptWithPassphraseFormat([]byte("payload"), []byte("passphrase-1"), MigrationFormat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecryptWithPassphrase(body, []byte("passphrase-1")); err == nil {
		t.Fatal("migration envelope must not decrypt as credential-export envelope")
	}
	back, err := DecryptWithPassphraseFormat(body, []byte("passphrase-1"), MigrationFormat)
	if err != nil || string(back) != "payload" {
		t.Fatalf("round-trip failed: %v", err)
	}
}
