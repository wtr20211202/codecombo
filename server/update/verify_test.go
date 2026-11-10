package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTempFile 落一个固定内容的临时文件，返回路径与 sha256 hex
func writeTempFile(t *testing.T, content []byte) (string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "binary.exe")
	if err := os.WriteFile(path, content, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	return path, hex.EncodeToString(sum[:])
}

// resetPubKey 测试后恢复内嵌公钥（包级变量）
func resetPubKey(t *testing.T, key string) {
	t.Helper()
	old := updatePubKey
	updatePubKey = key
	t.Cleanup(func() { updatePubKey = old })
}

func TestVerifyChecksum(t *testing.T) {
	path, sum := writeTempFile(t, []byte("new binary content"))

	t.Run("校验值匹配", func(t *testing.T) {
		if err := verifyChecksum(path, sum); err != nil {
			t.Errorf("expected pass, got %v", err)
		}
	})
	t.Run("校验值大小写不敏感", func(t *testing.T) {
		if err := verifyChecksum(path, strings.ToUpper(sum)); err != nil {
			t.Errorf("expected pass, got %v", err)
		}
	})
	t.Run("校验值不匹配", func(t *testing.T) {
		if err := verifyChecksum(path, strings.Repeat("ab", 32)); err == nil {
			t.Error("expected failure on mismatched checksum")
		}
	})
	t.Run("空校验值拒绝", func(t *testing.T) {
		if err := verifyChecksum(path, ""); err == nil {
			t.Error("expected failure on empty checksum")
		}
	})
}

func TestVerifySignature(t *testing.T) {
	content := []byte("signed binary content")
	path, sum := writeTempFile(t, content)

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	resetPubKey(t, base64.StdEncoding.EncodeToString(pub))

	// 签名对象：sha256 hex 小写字符串（发布侧约定）
	sig := ed25519.Sign(priv, []byte(sum))

	t.Run("签名有效", func(t *testing.T) {
		if err := verifySignature(path, base64.StdEncoding.EncodeToString(sig)); err != nil {
			t.Errorf("expected pass, got %v", err)
		}
	})
	t.Run("签名被篡改", func(t *testing.T) {
		bad := make([]byte, len(sig))
		copy(bad, sig)
		bad[0] ^= 0xff
		if err := verifySignature(path, base64.StdEncoding.EncodeToString(bad)); err == nil {
			t.Error("expected failure on tampered signature")
		}
	})
	t.Run("二进制被篡改", func(t *testing.T) {
		tampered := filepath.Join(t.TempDir(), "binary.exe")
		if err := os.WriteFile(tampered, []byte("tampered content"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := verifySignature(tampered, base64.StdEncoding.EncodeToString(sig)); err == nil {
			t.Error("expected failure on tampered binary")
		}
	})
}

func TestVerifyUpdate_Priority(t *testing.T) {
	content := []byte("prioritized content")
	path, sum := writeTempFile(t, content)

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, []byte(sum))

	t.Run("无校验字段默认拒绝", func(t *testing.T) {
		t.Setenv(AllowUnverifiedEnv, "")
		resetPubKey(t, "")
		if err := verifyUpdate(path, &ReleaseInfo{}); err == nil {
			t.Error("expected refusal when release has no verification fields")
		}
	})

	t.Run("无校验字段逃生口放行", func(t *testing.T) {
		t.Setenv(AllowUnverifiedEnv, "1")
		resetPubKey(t, "")
		if err := verifyUpdate(path, &ReleaseInfo{}); err != nil {
			t.Errorf("expected pass with escape hatch, got %v", err)
		}
	})

	t.Run("仅有 checksum 即可过", func(t *testing.T) {
		t.Setenv(AllowUnverifiedEnv, "")
		resetPubKey(t, "")
		if err := verifyUpdate(path, &ReleaseInfo{ChecksumSHA256: sum}); err != nil {
			t.Errorf("expected pass with checksum, got %v", err)
		}
	})

	t.Run("签名+公钥：验签通过", func(t *testing.T) {
		t.Setenv(AllowUnverifiedEnv, "")
		resetPubKey(t, base64.StdEncoding.EncodeToString(pub))
		info := &ReleaseInfo{
			ChecksumSHA256: strings.Repeat("00", 32), // 错误 checksum 也无妨：签名优先
			Signature:      base64.StdEncoding.EncodeToString(sig),
		}
		if err := verifyUpdate(path, info); err != nil {
			t.Errorf("expected pass via signature, got %v", err)
		}
	})

	t.Run("签名+公钥：篡改二进制被拒", func(t *testing.T) {
		resetPubKey(t, base64.StdEncoding.EncodeToString(pub))
		tamperedPath, _ := writeTempFile(t, []byte("evil"))
		info := &ReleaseInfo{Signature: base64.StdEncoding.EncodeToString(sig)}
		if err := verifyUpdate(tamperedPath, info); err == nil {
			t.Error("expected refusal on tampered binary")
		}
	})
}

// legacyVerifyUpdate P-20261109-9 之前 verifyUpdate 的原样副本——「校验强度零
// 变化」的判定基准（测试 oracle，勿随实现改动）
func legacyVerifyUpdate(binaryPath string, info *ReleaseInfo) error {
	switch {
	case info.Signature != "" && updatePubKey != "":
		return verifySignature(binaryPath, info.Signature)
	case info.Signature != "":
		if info.ChecksumSHA256 == "" && allowUnverified() {
			return nil
		}
		return verifyChecksum(binaryPath, info.ChecksumSHA256)
	case info.ChecksumSHA256 != "":
		return verifyChecksum(binaryPath, info.ChecksumSHA256)
	default:
		if allowUnverified() {
			return nil
		}
		return fmt.Errorf("release provides no checksum/signature; set %s=1 to override", AllowUnverifiedEnv)
	}
}

// TestVerifyUpdateVerdictUnchanged 穷举等价（验收「校验强度零变化」）：签名
// {空/有效/伪造} × checksum{空/匹配/不匹配} × 公钥{无/有} × 逃生门{关/开} ×
// 两类拉取失败标记{无/有}共 144 形态，新 verifyUpdate 与旧口径放行/拒绝逐一
// 相同；未被伴随预检接管的形态文案也逐字不变（只有拉取失败形态改了说法）
func TestVerifyUpdateVerdictUnchanged(t *testing.T) {
	path, sum := writeTempFile(t, []byte("verdict content"))
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	goodSig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(sum)))
	forgedSig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte("other payload")))
	t.Setenv(AllowUnverifiedEnvOld, "")

	n := 0
	for _, sig := range []string{"", goodSig, forgedSig} {
		for _, cs := range []string{"", sum, strings.Repeat("ab", 32)} {
			for _, key := range []string{"", base64.StdEncoding.EncodeToString(pub)} {
				for _, env := range []string{"", "1"} {
					for _, ce := range []string{"", "boom-c"} {
						for _, se := range []string{"", "boom-s"} {
							n++
							resetPubKey(t, key)
							t.Setenv(AllowUnverifiedEnv, env)
							info := &ReleaseInfo{Signature: sig, ChecksumSHA256: cs, ChecksumFetchErr: ce, SigFetchErr: se}
							got, want := verifyUpdate(path, info), legacyVerifyUpdate(path, info)
							shape := fmt.Sprintf("sig=%t/%t cs=%q key=%t env=%q ce=%q se=%q",
								sig != "", sig == goodSig, cs, key != "", env, ce, se)
							if (got == nil) != (want == nil) {
								t.Errorf("verdict changed [%s]: new=%v legacy=%v", shape, got, want)
								continue
							}
							if got != nil && CompanionPreflight(info) == nil && got.Error() != want.Error() {
								t.Errorf("text changed outside companion preflight [%s]: new=%q legacy=%q", shape, got, want)
							}
						}
					}
				}
			}
		}
	}
	if n != 144 {
		t.Fatalf("matrix size %d, want 144", n)
	}
}

// TestCompanionPreflightRefusalMatrix 拉取失败形态的放行/拒绝判定与旧口径
// verifyUpdate 逐分支等价（P-20261109-9：只改文案不改强度）——右侧 hardRefuse
// 列取「旧口径最终到达的错误」是否为注定拒绝（empty checksum / 无校验字段），
// CompanionPreflight 的拒绝/放行必须与之完全一致（验签可行或逃生门开=放行）
func TestCompanionPreflightRefusalMatrix(t *testing.T) {
	type scenario struct {
		name       string
		pubKey     string
		env        string
		info       ReleaseInfo
		hardRefuse bool // 旧口径注定拒绝（无论二进制内容）
	}
	cases := []scenario{
		// 两者皆空且拉取失败：旧口径 default 分支误报「release 没提供」→ 注定拒绝
		{name: "checksum失败+无sig", env: "", info: ReleaseInfo{ChecksumFetchErr: "boom"}, hardRefuse: true},
		{name: "sig失败+无checksum", env: "", info: ReleaseInfo{SigFetchErr: "boom"}, hardRefuse: true},
		{name: "两者皆失败", env: "", info: ReleaseInfo{ChecksumFetchErr: "b1", SigFetchErr: "b2"}, hardRefuse: true},
		// 逃生门：旧口径 default 分支放行 → 预检必须放行
		{name: "全空+逃生门", env: "1", info: ReleaseInfo{ChecksumFetchErr: "b"}, hardRefuse: false},
		// sig 在手无公钥：旧口径退回 checksum——checksum 拉空落到 verifyChecksum("")
		//（"empty checksum"）→ 注定拒绝；sig 失败但 checksum 在手 → 可比对 → 放行
		{name: "sig在手+checksum失败", env: "", info: ReleaseInfo{Signature: "sig", ChecksumFetchErr: "b"}, hardRefuse: true},
		{name: "sig失败+checksum在手", env: "", info: ReleaseInfo{ChecksumSHA256: "ab", SigFetchErr: "b"}, hardRefuse: false},
		{name: "sig在手+checksum失败+逃生门", env: "1", info: ReleaseInfo{Signature: "sig", ChecksumFetchErr: "b"}, hardRefuse: false},
	}
	// sig 在手且有公钥：验签可行，checksum 状态无关（即使 checksum 也拉取失败）。
	// 预检只判「签名在手 + 公钥非空」，不解码不验签——验签本体仍归 verifyUpdate
	// 原分支（坏公钥/坏签名照旧在那里拒绝），故此处签名填占位串即可
	{
		pub, _, err := ed25519.GenerateKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		cases = append(cases, scenario{
			name: "sig+公钥+checksum失败", pubKey: base64.StdEncoding.EncodeToString(pub),
			env: "", info: ReleaseInfo{Signature: "sig", ChecksumFetchErr: "b"}, hardRefuse: false,
		})
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resetPubKey(t, c.pubKey)
			t.Setenv(AllowUnverifiedEnv, c.env)
			err := CompanionPreflight(&c.info)
			if c.hardRefuse && err == nil {
				t.Errorf("old path refuses (hard) but preflight passed: %+v", c.info)
			}
			if !c.hardRefuse && err != nil {
				t.Errorf("old path can proceed but preflight refused: %v", err)
			}
			// 拒绝文案必须带真实原因与重试指引，不再误报「release 没提供」
			if err != nil {
				if !strings.Contains(err.Error(), "companion asset fetch failed") ||
					!strings.Contains(err.Error(), c.info.CompanionFetchError()) ||
					!strings.Contains(err.Error(), AllowUnverifiedEnv+"=1") {
					t.Errorf("refusal text missing reason/guidance: %v", err)
				}
			}
		})
	}

	// 真缺失（无失败标记）永不触发预检——默认拒绝文案保持原文
	t.Setenv(AllowUnverifiedEnv, "")
	resetPubKey(t, "")
	if err := CompanionPreflight(&ReleaseInfo{}); err != nil {
		t.Errorf("true-missing must not trip preflight: %v", err)
	}
	if err := verifyUpdate("", &ReleaseInfo{}); err == nil ||
		!strings.Contains(err.Error(), "release provides no checksum/signature") {
		t.Errorf("true-missing default text changed: %v", err)
	}
}

// 端到端：verifyUpdate 对「checksum 拉到但 sig 拉取失败 + 公钥构建」的二进制，
// 验签可行性不受 sig 拉取失败影响（内容决定结果）；对「sig 拉到但 checksum
// 拉空 + 无公钥」不再报 "empty checksum"（同为拉取失败形态，一并分流）
func TestVerifyUpdateCompanionTextSplit(t *testing.T) {
	content := []byte("split content")
	path, sum := writeTempFile(t, content)
	pub, priv, _ := ed25519.GenerateKey(nil)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(sum)))

	t.Setenv(AllowUnverifiedEnv, "")

	t.Run("sig拉取失败但签名在+公钥：照常验签", func(t *testing.T) {
		resetPubKey(t, base64.StdEncoding.EncodeToString(pub))
		info := &ReleaseInfo{Signature: sig, SigFetchErr: "boom"}
		if err := verifyUpdate(path, info); err != nil {
			t.Errorf("signature path must be unaffected by sig fetch failure: %v", err)
		}
	})

	t.Run("sig在手checksum拉空+无公钥：报拉取失败而非empty checksum", func(t *testing.T) {
		resetPubKey(t, "")
		info := &ReleaseInfo{Signature: sig, ChecksumFetchErr: "boom"}
		err := verifyUpdate(path, info)
		if err == nil {
			t.Fatal("expected refusal")
		}
		if strings.Contains(err.Error(), "empty checksum") || strings.Contains(err.Error(), "release provides no checksum") {
			t.Errorf("still distorted text: %v", err)
		}
		if !strings.Contains(err.Error(), "companion asset fetch failed") {
			t.Errorf("want companion fetch failure text: %v", err)
		}
	})

	// 逃生门全形态放行回归（校验强度零变化）
	t.Run("逃生门放行拉取失败形态", func(t *testing.T) {
		t.Setenv(AllowUnverifiedEnv, "1")
		resetPubKey(t, "")
		if err := verifyUpdate(path, &ReleaseInfo{ChecksumFetchErr: "boom"}); err != nil {
			t.Errorf("escape hatch must still pass: %v", err)
		}
	})
}
