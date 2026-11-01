package config

import (
	"crypto/rand"
	"encoding/hex"
	"time"
)

// 远程主机认证方式
const (
	AuthTypePassword = "password"
	AuthTypeSshKey   = "sshkey"
	AuthTypePem      = "pem"
)

// 远程主机协议（决定文件管理与连接能力的通道）
const (
	ProtocolSFTP = "sftp"
	ProtocolFTP  = "ftp"
)

// RemoteHost 远程主机凭据，用于 SSH 连接部署目标服务器
type RemoteHost struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	AuthType    string `json:"authType"`
	Protocol    string `json:"protocol,omitempty"`    // sftp（默认）| ftp；FTP 仅文件管理（明文协议）
	Password    string `json:"password,omitempty"`    // enc: 加密
	SshKeyID    string `json:"sshKeyId,omitempty"`    // 引用现有 SshKey
	PemContent  string `json:"pemContent,omitempty"`  // enc: 加密
	Fingerprint string `json:"fingerprint,omitempty"` // 仅展示
	// HostKeyVerifyDisabled 关闭该主机的 SSH 主机密钥 TOFU 校验（内网完全信任
	// 场景的 per-host 开关；默认 false = 开启校验，首连钉扎、变更拒绝）
	HostKeyVerifyDisabled bool      `json:"hostKeyVerifyDisabled,omitempty"`
	CreatedAt             time.Time `json:"createdAt"`
	UpdatedAt             time.Time `json:"updatedAt"`
}

// ApplyDefaults 填充默认值（ID / Protocol / Port / 时间戳）
func (r *RemoteHost) ApplyDefaults() {
	if r.ID == "" {
		r.ID = newRemoteHostID()
	}
	if r.Protocol == "" {
		r.Protocol = ProtocolSFTP
	}
	if r.Port == 0 {
		if r.Protocol == ProtocolFTP {
			r.Port = 21
		} else {
			r.Port = 22
		}
	}
	now := time.Now()
	if r.CreatedAt.IsZero() {
		r.CreatedAt = now
	}
	r.UpdatedAt = now
}

// IsFTP 该主机是否走 FTP 通道（决定终端/部署等 SSH 能力是否可用）
func (r *RemoteHost) IsFTP() bool { return r.Protocol == ProtocolFTP }

// newRemoteHostID 生成 sc_rh_ 前缀的随机 ID
func newRemoteHostID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "sc_rh_" + hex.EncodeToString(b)
}
