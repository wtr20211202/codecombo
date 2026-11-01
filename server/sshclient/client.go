// Package sshclient 封装 SSH 连接、命令执行和 SFTP 文件传输
package sshclient

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"codecombo/server/errmarkers"
)

// 认证方式常量
const (
	AuthTypePassword = "password"
	AuthTypeSshKey   = "sshkey"
	AuthTypePem      = "pem"
)

// AuthMethod 认证方式描述
type AuthMethod struct {
	Type       string // password | sshkey | pem
	Password   string
	PemContent string
}

// AuthMethodFor 根据逻辑认证类型构造 AuthMethod（sshkey 归一化为 pem，统一使用 PemContent 字段）
func AuthMethodFor(authType, password, pemContent string) AuthMethod {
	switch authType {
	case AuthTypeSshKey, AuthTypePem:
		return AuthMethod{Type: AuthTypePem, PemContent: pemContent}
	default:
		return AuthMethod{Type: AuthTypePassword, Password: password}
	}
}

// ConnectOptions 连接参数
type ConnectOptions struct {
	Host            string
	Port            int
	User            string
	Auth            AuthMethod
	HostKeyCallback ssh.HostKeyCallback
	// SkipHostKeyTOFU 显式跳过主机密钥 TOFU 校验（内网完全信任场景的 per-host
	// 关闭开关，默认开启校验）。仅对未显式指定 HostKeyCallback 的调用生效；
	// 远程主机记录（config.RemoteHost.HostKeyVerifyDisabled）在拨号侧传入
	SkipHostKeyTOFU bool
	Timeout         time.Duration
}

// Client SSH 客户端，复用底层连接执行多次 exec/sftp
type Client struct {
	sshClient *ssh.Client
	// mu 保护 sftpClient 懒初始化（SFTP/Close 与任意流式操作可能并发调用）
	mu         sync.Mutex
	sftpClient *sftp.Client
}

// Dial 建立 SSH 连接
func Dial(opts ConnectOptions) (*Client, error) {
	if opts.Port == 0 {
		opts.Port = 22
	}
	if opts.Timeout == 0 {
		opts.Timeout = 15 * time.Second
	}
	if opts.HostKeyCallback == nil {
		if opts.SkipHostKeyTOFU {
			opts.HostKeyCallback = ssh.InsecureIgnoreHostKey() // per-host 显式关闭（P-20261003-34）
		} else {
			// 默认 TOFU 主机密钥校验：首连钉扎、变更拒绝（hostkey.go）
			opts.HostKeyCallback = tofuHostKeyCallback(opts.Host, opts.Port)
		}
	}

	auths, err := buildAuthMethods(opts.Auth)
	if err != nil {
		return nil, fmt.Errorf("build auth methods: %w", err)
	}

	cfg := &ssh.ClientConfig{
		User:            opts.User,
		Auth:            auths,
		HostKeyCallback: opts.HostKeyCallback,
		Timeout:         opts.Timeout,
	}

	addr := fmt.Sprintf("%s:%d", opts.Host, opts.Port)
	conn, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, classifyDialError(addr, err)
	}
	return &Client{sshClient: conn}, nil
}

// classifyDialError 标注常见 SSH 拨号失败（原始错误保留在链尾）。
// 认证被拒是最常见的用户侧故障：密码错、用户名错、或服务端禁用了对应认证方式
// （如 Ubuntu 默认 PermitRootLogin prohibit-password 拒绝 root 密码登录）。
// 具体的本地化操作建议由前端按错误特征追加（i18n），这里保持英文简述
func classifyDialError(addr string, err error) error {
	msg := err.Error()
	// 稳定前缀收口 errmarkers 注册表（P-20261004-29）：前端按 AuthRejectedPrefix
	// 子串映射「认证失败」；"unable to authenticate" 是 ssh 库底层原文（External）
	if strings.Contains(msg, "unable to authenticate") {
		return fmt.Errorf("ssh dial %s: %s: %w", addr, errmarkers.AuthRejectedPrefix, err)
	}
	if strings.Contains(msg, "connection refused") {
		return fmt.Errorf("ssh dial %s: connection refused (remote port not listening): %w", addr, err)
	}
	return fmt.Errorf("ssh dial %s: %w", addr, err)
}

// SFTP 懒初始化 SFTP 客户端（并发安全：double-check + 互斥）
func (c *Client) SFTP() (*sftp.Client, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sftpClient != nil {
		return c.sftpClient, nil
	}
	sc, err := sftp.NewClient(c.sshClient)
	if err != nil {
		return nil, err
	}
	c.sftpClient = sc
	return sc, nil
}

// Close 关闭所有连接
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sftpClient != nil {
		_ = c.sftpClient.Close()
	}
	return c.sshClient.Close()
}

// UnderlyingClient 暴露底层 ssh.Client（exec.go 内部使用）
func (c *Client) UnderlyingClient() *ssh.Client {
	return c.sshClient
}

// buildAuthMethods 根据认证方式构造 ssh.AuthMethod 列表
func buildAuthMethods(a AuthMethod) ([]ssh.AuthMethod, error) {
	switch a.Type {
	case AuthTypePassword:
		if a.Password == "" {
			return nil, fmt.Errorf("password is empty")
		}
		return []ssh.AuthMethod{ssh.Password(a.Password)}, nil
	case AuthTypePem, AuthTypeSshKey:
		if a.PemContent == "" {
			return nil, fmt.Errorf("pem content is empty")
		}
		signer, err := ssh.ParsePrivateKey([]byte(a.PemContent))
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	return nil, fmt.Errorf("unknown auth type: %s", a.Type)
}
