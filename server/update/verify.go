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

	"codecombo/server/errmarkers"
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
//
// 伴随资产拉取失败（P-20261109-9）只改拒绝文案、不改放行/拒绝判定：先过
// CompanionPreflight（注定拒绝的形态报真实拉取原因），其余原分支一字未动
func verifyUpdate(binaryPath string, info *ReleaseInfo) error {
	if err := CompanionPreflight(info); err != nil {
		return err
	}
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

// CompanionPreflight 伴随资产拉取失败是否已注定校验拒绝（与二进制内容无关）：
// 是则返回带真实拉取原因的错误，否则 nil（可校验 / 逃生门放行 / 真缺失——
// 后两者与校验结果仍由 verifyUpdate 原分支裁决）。三处同源消费：
// verifyUpdate 拒绝文案、ApplyUpdate 下载前拒绝（注定被拒就不白拉主包）、
// check 旗标（面板即时提示「更新将被拒」只在真会被拒时出现）。
//
// 判定与 verifyUpdate 原分支逐条对齐，保证放行/拒绝结果零变化：
//   - 签名在手且有公钥 → 验签可行，checksum 状态无关；
//   - 签名在手无公钥 → 退回 checksum：checksum 拉取失败即注定失败（旧口径
//     落到 verifyChecksum("") 报 "empty checksum"，与拉取失败同样失真）；
//   - checksum 在手 → sha256 可比对；
//   - 两者皆空且至少一个拉取失败 → 注定失败（旧口径误报 release 没提供）。
//
// 逃生门（CC_UPDATE_ALLOW_UNVERIFIED=1）语义不变：原分支在「无可用校验数据」
// 时一律放行，这里同步放行
func CompanionPreflight(info *ReleaseInfo) error {
	if !info.CompanionFetchFailed() || allowUnverified() {
		return nil
	}
	switch {
	case info.Signature != "" && updatePubKey != "":
		return nil
	case info.Signature != "":
		if info.ChecksumSHA256 == "" && info.ChecksumFetchErr != "" {
			return companionFetchFailedError(info.CompanionFetchError())
		}
		return nil
	case info.ChecksumSHA256 != "":
		return nil
	default:
		return companionFetchFailedError(info.CompanionFetchError())
	}
}

// companionFetchFailedError 拉取失败形态的拒绝文案：区别于真缺失的「release
// provides no checksum/signature」——资产在 release 里，只是没取到，指引重试。
// 原文收口 errmarkers 注册表（前端 KNOWN_ERROR_I18N 按「; retry or set」截取
// reason 进本地化文案的插值参数，reason 内勿含该分隔串）
func companionFetchFailedError(reason string) error {
	return fmt.Errorf(errmarkers.UpdateCompanionFetchFailedTemplate, reason, AllowUnverifiedEnv)
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
