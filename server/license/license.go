// Package license 实现 Codecombo 的许可授权机制。
//
// 设计对标主流商业软件（JetBrains / GitLab 等）：
//   - Ed25519 非对称签名验证（私钥签发、公钥内嵌验证，私钥不在服务进程中）
//   - 自包含签名 token（base64url(payload).base64url(signature)），无服务端状态依赖
//   - 模块级功能门控（features 列表控制可用模块集合）
//   - 过期时间可选（零值 = 永不过期）
//
// 安全模型：
//   - 公钥通过 ldflags 在构建时注入（与 update 模块的 CC_UPDATE_PUBKEY 同模式）
//   - 无公钥 → 视为未启用许可验证（所有功能可用），仅审计日志留痕
//   - 许可数据持久化到 DataDir（权限 0600），篡改后签名验证必然失败
//
// 使用方式：
//   - 用户在前端粘贴许可密钥 → POST /api/license/activate → 服务端验证并持久化
//   - 或将许可密钥文件放入 DataDir/license.key → 启动时自动加载
package license

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// License 许可证载荷（JSON 编码后 Ed25519 签名）
type License struct {
	Licensee  string   `json:"licensee"`            // 被许可方
	Product   string   `json:"product"`             // 产品标识（授权文件内嵌字面量，跨版本校验不变更）
	Edition   string   `json:"edition"`             // 版次（beta/trial/standard/pro/enterprise）
	Features  []string `json:"features"`            // 可用模块列表，"*" 表示全部
	IssuedAt  string   `json:"issuedAt"`            // 签发时间 RFC3339
	ExpiresAt string   `json:"expiresAt,omitempty"` // 过期时间 RFC3339（空 = 永不过期）
}

// editionLevel 版次优先级（用于 Edition 至少与要求同级判断）
var editionLevel = map[string]int{
	"beta":       0,
	"trial":      1,
	"standard":   2,
	"pro":        3,
	"enterprise": 4,
}

// Parse 解码并验证签名的许可密钥字符串。
// 格式：base64url(payloadJSON) + "." + base64url(ed25519_signature)
// publicKey 为空时跳过签名验证（开发模式），生产环境必须注入公钥
func Parse(key string, publicKey ed25519.PublicKey) (*License, error) {
	key = strings.TrimSpace(key)
	parts := strings.SplitN(key, ".", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid license format: expected payload.signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode signature: %w", err)
	}

	// Ed25519 签名验证
	if publicKey != nil {
		if len(sig) != ed25519.SignatureSize {
			return nil, fmt.Errorf("invalid signature size %d", len(sig))
		}
		if !ed25519.Verify(publicKey, payload, sig) {
			return nil, fmt.Errorf("signature verification failed")
		}
	}

	var lic License
	if err := json.Unmarshal(payload, &lic); err != nil {
		return nil, fmt.Errorf("parse license payload: %w", err)
	}
	if lic.Licensee == "" || lic.Product == "" {
		return nil, fmt.Errorf("license payload missing required fields")
	}
	return &lic, nil
}

// NOTE: 签发能力（Encode + GenerateKeyPair + SignInternalBeta）不在本包中。
// 许可签发由独立的 tools/licensegen 工具完成（仅限私有仓库/离线环境使用）。
// 本包只做验证（Parse + HasFeature + IsExpired），不含任何私钥操作。

// HasFeature 检查许可证是否授权指定模块。
// features 包含 "*" 或精确匹配模块名 → true
// lic 为 nil（无许可）时返回 false，由调用方决定是否放行
func (l *License) HasFeature(module string) bool {
	if l == nil {
		return false
	}
	for _, f := range l.Features {
		if f == "*" || f == module {
			return true
		}
	}
	return false
}

// IsExpired 检查许可证是否已过期
func (l *License) IsExpired() bool {
	if l == nil || l.ExpiresAt == "" {
		return false
	}
	exp, err := time.Parse(time.RFC3339, l.ExpiresAt)
	if err != nil {
		return true // 无法解析视为过期
	}
	return time.Now().After(exp)
}

// EditionAtLeast 检查许可证版次是否至少为指定级别
func (l *License) EditionAtLeast(minimum string) bool {
	if l == nil {
		return false
	}
	return editionLevel[strings.ToLower(l.Edition)] >= editionLevel[strings.ToLower(minimum)]
}
