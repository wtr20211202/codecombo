package license

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const testSeed = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testKeyPair() (ed25519.PublicKey, ed25519.PrivateKey) {
	seed, _ := hex.DecodeString(testSeed)
	priv := ed25519.NewKeyFromSeed(seed)
	return priv.Public().(ed25519.PublicKey), priv
}

// signLicense 测试辅助：用私钥签发许可证（模拟外部签发工具）
func signLicense(t *testing.T, lic *License, priv ed25519.PrivateKey) string {
	t.Helper()
	payload, err := json.Marshal(lic)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." +
		base64.RawURLEncoding.EncodeToString(sig)
}

func TestParseValidLicense(t *testing.T) {
	pub, priv := testKeyPair()
	lic := &License{
		Licensee: "internal-beta",
		Product:  "simple-coding",
		Edition:  "beta",
		Features: []string{"*"},
		IssuedAt: "2026-09-15T00:00:00Z",
	}
	key := signLicense(t, lic, priv)

	parsed, err := Parse(key, pub)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Licensee != "internal-beta" {
		t.Errorf("licensee = %q", parsed.Licensee)
	}
	if !parsed.HasFeature("ai") || !parsed.HasFeature("terminal") {
		t.Error("* should grant all features")
	}
	if parsed.IsExpired() {
		t.Error("no expiry should not be expired")
	}
}

func TestParseTamperedPayload(t *testing.T) {
	pub, priv := testKeyPair()
	lic := &License{
		Licensee: "test",
		Product:  "simple-coding",
		Edition:  "beta",
		Features: []string{"*"},
		IssuedAt: "2026-09-15T00:00:00Z",
	}
	key := signLicense(t, lic, priv)
	// 篡改 payload（最后 4 字符替换）
	parts := strings.SplitN(key, ".", 2)
	tamperedPayload := parts[0][:len(parts[0])-4] + "AAAA"
	tampered := tamperedPayload + "." + parts[1]

	_, err := Parse(tampered, pub)
	if err == nil {
		t.Error("expected signature verification failure for tampered payload")
	}
}

func TestParseWithoutPubKeySkipsSignature(t *testing.T) {
	// 无公钥（开发模式）：跳过签名验证，直接解析载荷
	lic := &License{
		Licensee: "dev-test",
		Product:  "simple-coding",
		Edition:  "beta",
		Features: []string{"*"},
		IssuedAt: "2026-09-15T00:00:00Z",
	}
	payload, _ := json.Marshal(lic)
	// 无公钥模式：token 只含 payload，无签名段（补 ".eA" 占位满足 base64 解码）
	token := base64.RawURLEncoding.EncodeToString(payload) + ".eA"
	parsed, err := Parse(token, nil)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Licensee != "dev-test" {
		t.Errorf("licensee = %q", parsed.Licensee)
	}
}

func TestHasFeatureNilLicense(t *testing.T) {
	var lic *License
	if lic.HasFeature("ai") {
		t.Error("nil license should not grant features")
	}
}

func TestIsExpired(t *testing.T) {
	past := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	future := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)

	licExpired := &License{ExpiresAt: past}
	if !licExpired.IsExpired() {
		t.Error("past expiry should be expired")
	}
	licValid := &License{ExpiresAt: future}
	if licValid.IsExpired() {
		t.Error("future expiry should not be expired")
	}
	licNoExpiry := &License{}
	if licNoExpiry.IsExpired() {
		t.Error("no expiry should not be expired")
	}
}

func TestEditionAtLeast(t *testing.T) {
	pro := &License{Edition: "pro"}
	if !pro.EditionAtLeast("standard") {
		t.Error("pro should satisfy standard requirement")
	}
	if pro.EditionAtLeast("enterprise") {
		t.Error("pro should not satisfy enterprise requirement")
	}
	beta := &License{Edition: "beta"}
	if !beta.EditionAtLeast("beta") {
		t.Error("beta should satisfy beta requirement")
	}
}

func TestJSONRoundTrip(t *testing.T) {
	orig := &License{
		Licensee:  "acme-corp",
		Product:   "simple-coding",
		Edition:   "enterprise",
		Features:  []string{"ai", "remote", "terminal", "deploy"},
		IssuedAt:  "2026-01-01T00:00:00Z",
		ExpiresAt: "2027-01-01T00:00:00Z",
	}
	data, err := json.Marshal(orig)
	if err != nil {
		t.Fatal(err)
	}
	var parsed License
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.Licensee != orig.Licensee || parsed.Edition != orig.Edition {
		t.Errorf("round trip mismatch: %+v vs %+v", parsed, orig)
	}
	if len(parsed.Features) != len(orig.Features) {
		t.Errorf("features mismatch: %v vs %v", parsed.Features, orig.Features)
	}
}
