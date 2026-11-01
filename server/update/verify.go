package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

// updatePubKey ed25519 验签公钥（base64），发布构建经 -ldflags 注入；
// 为空表示本构建未配置验签（开发构建），退化为仅 checksum 完整性校验
var updatePubKey = ""

// AllowUnverifiedEnv 显式放行无校验更新的环境变量（自建源/开发场景逃生口）。
// P-20261025-1 起正名 CC_，SC_ 旧名双读一个版本期（CI/运维手册存量用法不断链）
const (
	AllowUnverifiedEnv    = "CC_UPDATE_ALLOW_UNVERIFIED"
	AllowUnverifiedEnvOld = "SC_UPDATE_ALLOW_UNVERIFIED"
)

// allowUnverified 逃生门双读：CC_ 正名优先，SC_ 旧名回落
func allowUnverified() bool {
	return os.Getenv(AllowUnverifiedEnv) == "1" || os.Getenv(AllowUnverifiedEnvOld) == "1"
}

// verifyUpdate 对下载完成的更新包做完整性与真实性校验（安全 backlog A5）。
// 优先级：
//  1. 清单带 Signature 且构建内嵌公钥 → ed25519 验签（防更新源被攻破后校验值一同被换）
//  2. 清单带 ChecksumSHA256 → sha256 比对（防下载损坏）
//  3. 两者皆无 → 默认拒绝；CC_UPDATE_ALLOW_UNVERIFIED=1 显式逃生（旧名 SC_ 双读兼容）
func verifyUpdate(binaryPath string, info *ReleaseInfo) error {
	switch {
	case info.Signature != "" && updatePubKey != "":
		return verifySignature(binaryPath, info.Signature)
	case info.Signature != "":
		// 有签名但本构建无公钥：退回 checksum 校验（若有）
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

// verifyChecksum sha256 完整性比对
func verifyChecksum(binaryPath, want string) error {
	want = strings.ToLower(strings.TrimSpace(want))
	if want == "" {
		return fmt.Errorf("empty checksum")
	}
	sum, err := sha256File(binaryPath)
	if err != nil {
		return err
	}
	got := hex.EncodeToString(sum)
	if got != want {
		return fmt.Errorf("checksum mismatch: want %s, got %s", want, got)
	}
	return nil
}

// verifySignature ed25519 验签：签名对象为 sha256 hex 小写字符串（发布侧签名约定）
func verifySignature(binaryPath, sigB64 string) error {
	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(updatePubKey))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid embedded update public key")
	}
	sum, err := sha256File(binaryPath)
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sigB64))
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), []byte(hex.EncodeToString(sum)), sig) {
		return fmt.Errorf("signature verification failed")
	}
	return nil
}

// sha256File 计算文件 sha256（原始 sum）
func sha256File(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, fmt.Errorf("hash %s: %w", path, err)
	}
	return h.Sum(nil), nil
}
