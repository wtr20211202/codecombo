package config

import (
	"bytes"
	"encoding/json"
	"testing"
)

// TestPassphraseEnvelopeRoundtrip 信封往返 + 明文不泄漏 + 自描述字段齐全
func TestPassphraseEnvelopeRoundtrip(t *testing.T) {
	plain := []byte(`{"hosts":[{"name":"web-1","password":"secret"}]}`)
	env, err := EncryptWithPassphrase(plain, []byte("correct-horse-01"))
	if err != nil {
		t.Fatalf("EncryptWithPassphrase failed: %v", err)
	}

	var pe PassphraseEnvelope
	if err := json.Unmarshal(env, &pe); err != nil {
		t.Fatalf("envelope not valid json: %v", err)
	}
	if pe.Format != EnvelopeFormat || pe.Version != envelopeVersion {
		t.Errorf("format/version = %s/%d, want %s/%d", pe.Format, pe.Version, EnvelopeFormat, envelopeVersion)
	}
	if pe.Kdf != kdfScrypt || pe.KdfN != scryptN || pe.KdfR != scryptR || pe.KdfP != scryptP {
		t.Errorf("kdf params mismatch: %s n=%d r=%d p=%d", pe.Kdf, pe.KdfN, pe.KdfR, pe.KdfP)
	}
	if bytes.Contains(env, []byte("web-1")) || bytes.Contains(env, []byte("secret")) {
		t.Fatal("plaintext leaked into envelope")
	}

	got, err := DecryptWithPassphrase(env, []byte("correct-horse-01"))
	if err != nil {
		t.Fatalf("DecryptWithPassphrase failed: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Errorf("round-trip mismatch: got %q", got)
	}
}

// TestPassphraseEnvelopeWrongPassphrase 错误口令必须失败（GCM 认证）
func TestPassphraseEnvelopeWrongPassphrase(t *testing.T) {
	env, err := EncryptWithPassphrase([]byte("secret"), []byte("right-passphrase"))
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}
	if _, err := DecryptWithPassphrase(env, []byte("wrong-passphrase")); err == nil {
		t.Fatal("wrong passphrase must fail")
	}
}

// TestPassphraseEnvelopeTampered 篡改密文必须被认证标签发现
func TestPassphraseEnvelopeTampered(t *testing.T) {
	env, err := EncryptWithPassphrase([]byte("secret"), []byte("right-passphrase"))
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}
	env[len(env)/2] ^= 0x01
	if _, err := DecryptWithPassphrase(env, []byte("right-passphrase")); err == nil {
		t.Fatal("tampered envelope must fail")
	}
}

// TestPassphraseEnvelopeRejectsNonEnvelope 非信封输入（旧明文数组/其他格式）必须报错而非误解
func TestPassphraseEnvelopeRejectsNonEnvelope(t *testing.T) {
	cases := [][]byte{
		[]byte(`[{"name":"legacy-host"}]`),
		[]byte(`{"format":"other-tool"}`),
		[]byte(`not json at all`),
		nil,
	}
	for i, data := range cases {
		if _, err := DecryptWithPassphrase(data, []byte("whatever")); err == nil {
			t.Errorf("case %d: non-envelope input must fail", i)
		}
	}
}

// TestPassphraseEnvelopeUniqueSalt 同一口令两次导出的盐与密文不同（随机盐生效）
func TestPassphraseEnvelopeUniqueSalt(t *testing.T) {
	plain := []byte("same plaintext")
	env1, _ := EncryptWithPassphrase(plain, []byte("same-passphrase"))
	env2, _ := EncryptWithPassphrase(plain, []byte("same-passphrase"))
	var e1, e2 PassphraseEnvelope
	if json.Unmarshal(env1, &e1) != nil || json.Unmarshal(env2, &e2) != nil {
		t.Fatal("envelopes not valid json")
	}
	if e1.Salt == e2.Salt || e1.Ciphertext == e2.Ciphertext {
		t.Fatal("random salt/ciphertext expected for repeated exports")
	}
}
