package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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
