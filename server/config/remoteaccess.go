package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// 远程接入（SSH 反向隧道）配置（P-20261019-11）。
//
// 形态 = 中继档案列表 + 当前激活项 + 启用开关：同一时刻仅一条反向隧道在线
// （多档案 + 单活 + 一键切换），档案列表结构为未来多活留纯增量扩展位。
// 落盘于既有 settings 文档（ServerConfig.remoteAccess，omitempty 指针）——
// 旧配置缺字段 = nil = 未配置（不启用），升级零迁移。
//
// 凭据：密码与 HTTP API 同款 enc: 前缀加密落盘；sshkey 档案只存引用
// （SshKeyID），私钥本身留在既有 SSH 密钥库。GET /settings 投影绝不返回
// 密码（含密文）——只回 hasPassword 布尔。
const (
	// RemoteAccessAuthPassword 密码认证（存档密文）
	RemoteAccessAuthPassword = "password"
	// RemoteAccessAuthSSHKey 复用既有 SSH 密钥库（SshKeyID 引用）
	RemoteAccessAuthSSHKey = "sshkey"

	// RemoteAccessBindPublic 远端绑定 0.0.0.0（公网直连；VPS sshd 必须
	// GatewayPorts clientspecified，否则实际只绑回环）
	RemoteAccessBindPublic = "0.0.0.0"
	// RemoteAccessBindLoopback 远端绑定 127.0.0.1（供 VPS 上 nginx 等反代
	// 终结 TLS/复用 443 的形态；不要求 GatewayPorts）
	RemoteAccessBindLoopback = "127.0.0.1"

	// DefaultRemoteAccessPort 远端建议绑定端口（用户可改）
	DefaultRemoteAccessPort = 22022
	// MaxRemoteAccessProfiles 档案数上限（设置页可管理规模，纯配置量级）
	MaxRemoteAccessProfiles = 20
)

// RemoteAccessConfig 远程接入配置块
type RemoteAccessConfig struct {
	Profiles []RemoteAccessProfile `json:"profiles,omitempty"`
	// ActiveID 当前激活档案 id（同一时刻仅一条隧道；空 = 未选择）
	ActiveID string `json:"activeId,omitempty"`
	// Enabled 启用开关：true = 进程启动时自动恢复隧道（start/stop 端点
	// 同步维护该位），false/缺省 = 不自动启动
	Enabled bool `json:"enabled,omitempty"`
}

// RemoteAccessProfile 单个 VPS 中继档案
type RemoteAccessProfile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Host string `json:"host"`
	// Port VPS SSH 端口（默认 22）
	Port int    `json:"port,omitempty"`
	User string `json:"user"`
	// AuthType password | sshkey
	AuthType string `json:"authType"`
	// SshKeyID 既有 SSH 密钥库引用（AuthType=sshkey）
	SshKeyID string `json:"sshKeyId,omitempty"`
	// Password 密码（enc: 前缀密文；AuthType=password）。GET 投影永不外发
	Password string `json:"password,omitempty"`
	// RemoteBindHost 远端绑定地址：0.0.0.0（公网直连）| 127.0.0.1（反代）
	RemoteBindHost string `json:"remoteBindHost,omitempty"`
	// RemotePort 远端绑定端口（默认 22022）
	RemotePort int `json:"remotePort,omitempty"`
	// Domain 可选自有域名（配置后公网 URL 不带端口；TLS 终态由反代或
	// 应用自签证书提供）
	Domain string `json:"domain,omitempty"`
	// CreatedAt/UpdatedAt 管理面时间戳（只读展示）
	CreatedAt time.Time `json:"createdAt,omitempty"`
	UpdatedAt time.Time `json:"updatedAt,omitempty"`
}

// FindProfile 按 id 查找档案（未命中返回 nil）
func (ra *RemoteAccessConfig) FindProfile(id string) *RemoteAccessProfile {
	if ra == nil {
		return nil
	}
	for i := range ra.Profiles {
		if ra.Profiles[i].ID == id {
			return &ra.Profiles[i]
		}
	}
	return nil
}

// ActiveProfile 当前激活档案（未配置/悬空返回 nil）
func (ra *RemoteAccessConfig) ActiveProfile() *RemoteAccessProfile {
	if ra == nil {
		return nil
	}
	return ra.FindProfile(ra.ActiveID)
}

// EffectivePort SSH 端口（未配置回落 22）
func (p *RemoteAccessProfile) EffectivePort() int {
	if p == nil || p.Port <= 0 {
		return 22
	}
	return p.Port
}

// EffectiveRemoteBindHost 远端绑定地址（未配置回落 0.0.0.0）
func (p *RemoteAccessProfile) EffectiveRemoteBindHost() string {
	if p == nil || strings.TrimSpace(p.RemoteBindHost) == "" {
		return RemoteAccessBindPublic
	}
	return p.RemoteBindHost
}

// EffectiveRemotePort 远端绑定端口（未配置回落建议值 22022）
func (p *RemoteAccessProfile) EffectiveRemotePort() int {
	if p == nil || p.RemotePort <= 0 {
		return DefaultRemoteAccessPort
	}
	return p.RemotePort
}

// PublicURL 公网访问 URL（域名优先；回环绑定未配域名时返回空——
// 该形态必须经 VPS 反代域名访问，没有可直接复制的公网地址）。
// TLS 未启用回落 http（调用方负责强警示）。
func (p *RemoteAccessProfile) PublicURL(tlsEnabled bool) string {
	if p == nil {
		return ""
	}
	scheme := "https"
	if !tlsEnabled {
		scheme = "http"
	}
	if d := strings.TrimSpace(p.Domain); d != "" {
		return scheme + "://" + d
	}
	if p.EffectiveRemoteBindHost() == RemoteAccessBindLoopback {
		return ""
	}
	host := strings.TrimSpace(p.Host)
	if host == "" {
		return ""
	}
	port := p.EffectiveRemotePort()
	// IPv6 字面量需方括号；域名/IPv4 直接拼
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(port))
}

// NormalizeRemoteAccess 归一 + 校验远程接入配置（settings 写路径唯一入口）。
// existing 为当前落盘配置：同 id 档案的密码留空表示「保持原密码」（GET 投影
// 不回密码，编辑表单无法回填）；新档案密码认证必须给出密码。
// 返回的密码字段统一为 enc: 密文。
func NormalizeRemoteAccess(input, existing *RemoteAccessConfig) (*RemoteAccessConfig, error) {
	if input == nil {
		return nil, nil
	}
	if len(input.Profiles) > MaxRemoteAccessProfiles {
		return nil, fmt.Errorf("too many relay profiles (max %d)", MaxRemoteAccessProfiles)
	}
	now := time.Now()
	out := &RemoteAccessConfig{ActiveID: strings.TrimSpace(input.ActiveID), Enabled: input.Enabled}
	seenNames := make(map[string]bool, len(input.Profiles))
	seenIDs := make(map[string]bool, len(input.Profiles))
	out.Profiles = make([]RemoteAccessProfile, 0, len(input.Profiles))
	for i := range input.Profiles {
		in := input.Profiles[i]
		p := RemoteAccessProfile{
			ID:             strings.TrimSpace(in.ID),
			Name:           strings.TrimSpace(in.Name),
			Host:           strings.TrimSpace(in.Host),
			Port:           in.Port,
			User:           strings.TrimSpace(in.User),
			AuthType:       strings.ToLower(strings.TrimSpace(in.AuthType)),
			SshKeyID:       strings.TrimSpace(in.SshKeyID),
			Password:       in.Password,
			RemoteBindHost: strings.TrimSpace(in.RemoteBindHost),
			RemotePort:     in.RemotePort,
			Domain:         normalizeRelayDomain(in.Domain),
			CreatedAt:      in.CreatedAt,
			UpdatedAt:      now,
		}
		if p.Name == "" {
			return nil, fmt.Errorf("profile #%d: name is required", i+1)
		}
		if len(p.Name) > 64 {
			return nil, fmt.Errorf("profile %q: name too long (max 64)", p.Name)
		}
		nameKey := strings.ToLower(p.Name)
		if seenNames[nameKey] {
			return nil, fmt.Errorf("duplicate relay profile name: %s", p.Name)
		}
		seenNames[nameKey] = true

		if p.Host == "" {
			return nil, fmt.Errorf("profile %q: host is required", p.Name)
		}
		if len(p.Host) > 255 || strings.ContainsAny(p.Host, " \t/\\@") || strings.Contains(p.Host, "://") {
			return nil, fmt.Errorf("profile %q: invalid host %q (use a bare hostname or IP)", p.Name, p.Host)
		}
		if p.Port == 0 {
			p.Port = 22
		}
		if p.Port < 1 || p.Port > 65535 {
			return nil, fmt.Errorf("profile %q: invalid ssh port %d", p.Name, p.Port)
		}
		if p.User == "" || len(p.User) > 64 {
			return nil, fmt.Errorf("profile %q: invalid user", p.Name)
		}
		switch p.AuthType {
		case RemoteAccessAuthSSHKey:
			if p.SshKeyID == "" {
				return nil, fmt.Errorf("profile %q: sshKeyId is required for sshkey auth", p.Name)
			}
			p.Password = ""
		case RemoteAccessAuthPassword:
			p.SshKeyID = ""
			p.Password = strings.TrimSpace(p.Password)
			if p.Password != "" {
				p.Password = EncryptIfNeeded(p.Password)
			} else if prev := existing.FindProfile(p.ID); prev != nil &&
				prev.AuthType == RemoteAccessAuthPassword && prev.Password != "" {
				// 编辑不回填密码：留空 = 保持原密文（含 enc: 形态原样保留）
				p.Password = prev.Password
			}
			if p.Password == "" {
				return nil, fmt.Errorf("profile %q: password is required for password auth", p.Name)
			}
		default:
			return nil, fmt.Errorf("profile %q: invalid authType %q (password|sshkey)", p.Name, p.AuthType)
		}
		if !validRemoteAccessID(p.ID) || seenIDs[p.ID] {
			p.ID = newRemoteAccessID()
		}
		seenIDs[p.ID] = true

		switch p.RemoteBindHost {
		case "":
			p.RemoteBindHost = RemoteAccessBindPublic
		case RemoteAccessBindPublic, RemoteAccessBindLoopback:
		default:
			return nil, fmt.Errorf("profile %q: invalid remoteBindHost %q (0.0.0.0|127.0.0.1)", p.Name, p.RemoteBindHost)
		}
		if p.RemotePort == 0 {
			p.RemotePort = DefaultRemoteAccessPort
		}
		if p.RemotePort < 1 || p.RemotePort > 65535 {
			return nil, fmt.Errorf("profile %q: invalid remote port %d", p.Name, p.RemotePort)
		}
		if err := ValidateRelayDomain(p.Domain); err != nil {
			return nil, fmt.Errorf("profile %q: %w", p.Name, err)
		}
		if p.CreatedAt.IsZero() {
			if prev := existing.FindProfile(p.ID); prev != nil && !prev.CreatedAt.IsZero() {
				p.CreatedAt = prev.CreatedAt
			} else {
				p.CreatedAt = now
			}
		}
		// 密码明文只经 EncryptIfNeeded 一次：已在明文输入的档案不重复加密
		p.UpdatedAt = now
		out.Profiles = append(out.Profiles, p)
	}
	// 激活项悬空 → 清空；启用态无激活项 → 关闭（绝不带着坏配置自动拨号）
	if out.ActiveID != "" && out.FindProfile(out.ActiveID) == nil {
		out.ActiveID = ""
	}
	if out.ActiveID == "" {
		out.Enabled = false
	}
	return out, nil
}

// normalizeRelayDomain 域名归一：trim、剥 scheme 与尾斜杠；非法形态交由
// 调用方校验（这里只做输入宽容）
func normalizeRelayDomain(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "https://")
	v = strings.TrimPrefix(v, "http://")
	v = strings.TrimSuffix(v, "/")
	return v
}

// ValidateRelayDomain 域名/主机形态校验（无空格、无路径、无 scheme）
func ValidateRelayDomain(v string) error {
	if v == "" {
		return nil
	}
	if len(v) > 255 || strings.ContainsAny(v, " \t/\\") || strings.Contains(v, "://") {
		return fmt.Errorf("invalid domain %q (use a bare hostname, e.g. work.example.com)", v)
	}
	return nil
}

// validRemoteAccessID 只接受本包生成的 id 形态（防外部输入带出奇怪文件名/
// 日志注入；非此形态一律视为新档案重新铸 id）
func validRemoteAccessID(id string) bool {
	if !strings.HasPrefix(id, "sc_ra_") || len(id) != len("sc_ra_")+16 {
		return false
	}
	_, err := hex.DecodeString(id[len("sc_ra_"):])
	return err == nil
}

// newRemoteAccessID sc_ra_ 前缀随机 id（与 remotehost sc_rh_ 同惯例）
func newRemoteAccessID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "sc_ra_" + hex.EncodeToString(b)
}
