package license

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"sync"
)

// ===== 编译期开关（写死在代码中）=====

// LicenseEnforced 许可验证开关：false = 当前版本不启用授权，所有功能可用。
// 修改为 true 后，未持有效许可的模块将返回 403
const LicenseEnforced = false

// ShowLicenseUI 是否在设置页面显示许可授权信息（默认不显示）
const ShowLicenseUI = false

// licensePublicKeyHex Ed25519 公钥（hex），用于验证许可签名。
// 私钥由独立签发工具持有（simple-coding-license 工程），不在本仓库中
const licensePublicKeyHex = "167a5051f084d0eb3204b33bd255371a12f4dce8bf8f12f8c6c9de7cf38f138c"

// builtinBetaLicense 内置内测授权（Enforcing 后无外部许可时使用）
const builtinBetaLicense = "eyJsaWNlbnNlZSI6ImludGVybmFsLWJldGEiLCJwcm9kdWN0Ijoic2ltcGxlLWNvZGluZyIsImVkaXRpb24iOiJiZXRhIiwiZmVhdHVyZXMiOlsiKiJdLCJpc3N1ZWRBdCI6IjIwMjYtMDktMTVUMDI6MDA6MzlaIiwiZXhwaXJlc0F0IjoiMjA5OS0xMi0zMVQyMzo1OTo1OVoifQ.8bSbcY9F0idiKEiGhSyc7blgNtQuq7j8AimyOy6BqzMzHAnQjeVHZ4-mJyhkfCGF3vC5SGjYjTEhnv_yYVbQBg" //nolint:unused // 内测授权兜底常量，按注释属许可设计意图，保留

// publicKey 解析后的 Ed25519 公钥
var publicKey ed25519.PublicKey

// ===== 运行时状态 =====

var (
	mu             sync.RWMutex
	currentLicense *License
	currentKey     string
	loaded         bool
)

func init() {
	if b, err := hex.DecodeString(licensePublicKeyHex); err == nil && len(b) == ed25519.PublicKeySize {
		publicKey = ed25519.PublicKey(b)
	}
}

// Load 从持久化存储加载许可密钥并解析
func Load(key string) {
	mu.Lock()
	defer mu.Unlock()
	lic, err := Parse(key, publicKeyForValidation())
	if err != nil {
		return
	}
	currentLicense = lic
	currentKey = key
	loaded = true
}

// Activate 激活许可密钥（验证签名 + 过期时间）
func Activate(key string) (*License, error) {
	mu.Lock()
	defer mu.Unlock()
	lic, err := Parse(key, publicKeyForValidation())
	if err != nil {
		return nil, fmt.Errorf("license validation: %w", err)
	}
	if lic.IsExpired() {
		return nil, fmt.Errorf("license expired at %s", lic.ExpiresAt)
	}
	currentLicense = lic
	currentKey = key
	loaded = true
	return lic, nil
}

// Deactivate 清除当前许可
func Deactivate() {
	mu.Lock()
	defer mu.Unlock()
	currentLicense = nil
	currentKey = ""
	loaded = false
}

// Current 获取当前许可（可能为 nil）
func Current() *License {
	mu.RLock()
	defer mu.RUnlock()
	return currentLicense
}

// CurrentKey 获取原始许可密钥字符串
func CurrentKey() string {
	mu.RLock()
	defer mu.RUnlock()
	return currentKey
}

// IsLoaded 是否已加载许可
func IsLoaded() bool {
	mu.RLock()
	defer mu.RUnlock()
	return loaded
}

// HasFeature 检查指定模块是否可用。
// LicenseEnforced = false（当前版本）→ 始终返回 true
// LicenseEnforced = true 且许可有效且包含模块或 "*" → true
// 其余 → false
func HasFeature(module string) bool {
	if !LicenseEnforced {
		return true
	}
	mu.RLock()
	defer mu.RUnlock()
	lic := currentLicense
	if lic == nil {
		// 内置内测授权：无许可时可用所有功能（内测期）
		return hasBuiltinFeature(module)
	}
	if lic.IsExpired() {
		return false
	}
	return lic.HasFeature(module)
}

// hasBuiltinFeature 内置内测授权检查（无外部许可时的默认放行）
func hasBuiltinFeature(module string) bool {
	return true // 内测期：全部放行
}

// publicKeyForValidation 返回签名验证用的公钥。
// LicenseEnforced = false 时返回 nil（跳过签名验证，开发模式）；
// LicenseEnforced = true 时返回公钥（严格验证）。
func publicKeyForValidation() ed25519.PublicKey {
	if LicenseEnforced {
		return publicKey
	}
	return nil
}

// FormatStatus 格式化许可状态用于 API 返回
func FormatStatus() map[string]any {
	mu.RLock()
	defer mu.RUnlock()
	lic := currentLicense
	if lic == nil {
		return map[string]any{
			"activated": false,
			"enforced":  LicenseEnforced,
			"showUI":    ShowLicenseUI,
		}
	}
	return map[string]any{
		"activated": true,
		"enforced":  LicenseEnforced,
		"showUI":    ShowLicenseUI,
		"licensee":  lic.Licensee,
		"edition":   lic.Edition,
		"features":  lic.Features,
		"issuedAt":  lic.IssuedAt,
		"expiresAt": lic.ExpiresAt,
	}
}

// ValidatePublicKeyHex 校验公钥 hex 格式（部署配置辅助）
func ValidatePublicKeyHex(hexStr string) error {
	b, err := hex.DecodeString(hexStr)
	if err != nil {
		return fmt.Errorf("invalid hex: %w", err)
	}
	if len(b) != ed25519.PublicKeySize {
		return fmt.Errorf("expected %d bytes, got %d", ed25519.PublicKeySize, len(b))
	}
	return nil
}
