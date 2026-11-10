package update

import (
	"context"
	"strings"
)

// ReleaseInfo 更新源返回的版本信息
type ReleaseInfo struct {
	Version     string `json:"version"`
	Changelog   string `json:"changelog"`
	DownloadURL string `json:"downloadUrl"`
	FileSize    int64  `json:"fileSize"`
	// ChecksumSHA256 二进制 sha256（hex，大小写不敏感）。
	// GitHub 源取伴随资产 <二进制名>.sha256；缺失时按无校验策略处理
	ChecksumSHA256 string `json:"checksumSha256,omitempty"`
	// Signature 对 sha256 hex 字符串的 ed25519 签名（base64）。
	// GitHub 源取伴随资产 <二进制名>.sig；验签公钥构建期经 -ldflags 注入
	Signature string `json:"signature,omitempty"`
	// ChecksumFetchErr / SigFetchErr 伴随资产「在 release 列表但拉取失败」的原因
	//（P-20261109-9 三态：已获取=对应内容字段非空；缺失=资产不在列表、内容与
	// 本字段皆空；拉取失败=本字段非空）。旧实现吞掉拉取错误，拉取失败与真缺失
	// 同形，verify 只能报「release provides no checksum/signature」（beta.3
	// 用户实锚：伴随资产实际在位）。纯诊断字段——校验强度不随之变化
	ChecksumFetchErr string `json:"checksumFetchErr,omitempty"`
	SigFetchErr      string `json:"sigFetchErr,omitempty"`
}

// CompanionFetchFailed 任一伴随资产在列表但拉取失败（nil 安全）
func (r *ReleaseInfo) CompanionFetchFailed() bool {
	return r != nil && (r.ChecksumFetchErr != "" || r.SigFetchErr != "")
}

// CompanionFetchError 伴随拉取失败原因的合并文案（无失败返回空串）：
// 逐资产标注，供 verify 错误、check 旗标与 manager errMsg 共用同一措辞
func (r *ReleaseInfo) CompanionFetchError() string {
	if r == nil {
		return ""
	}
	var parts []string
	if r.ChecksumFetchErr != "" {
		parts = append(parts, "checksum: "+r.ChecksumFetchErr)
	}
	if r.SigFetchErr != "" {
		parts = append(parts, "signature: "+r.SigFetchErr)
	}
	return strings.Join(parts, "; ")
}

// UpdateSource 更新源接口
type UpdateSource interface {
	// FetchLatest 获取最新版本信息
	FetchLatest(ctx context.Context, platform, arch string) (*ReleaseInfo, error)
}
