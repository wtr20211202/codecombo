package update

import (
	"context"
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
}

// UpdateSource 更新源接口
type UpdateSource interface {
	// FetchLatest 获取最新版本信息
	FetchLatest(ctx context.Context, platform, arch string) (*ReleaseInfo, error)
}
