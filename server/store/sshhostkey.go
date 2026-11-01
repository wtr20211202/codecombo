package store

import (
	"encoding/json"
	"net"
	"strconv"
	"time"

	"codecombo/server/config"
)

// SSHHostKeyStore SSH 主机密钥指纹库（TOFU 钉扎，P-20261003-34）。
//
// 车道 1 kind "sshhostkeys"：host:port 一文档，语义与 peercerts（实例间 TLS
// TOFU）同款——首连记录主机公钥指纹，此后连接比对，变更即拒（可能中间人）。
// 指纹虽非秘密，仍经凭据加密域（config.EncryptToken 通道）加密落盘：不让
// 磁盘访问者直接读出「哪台主机在何时被钉过什么指纹」的基础设施拓扑。
// 主机记录删除时级联清理（remotehost.Delete），重连自动重新 TOFU。
type SSHHostKeyStore interface {
	// Get host:port 已钉扎返回指纹与算法；未记录 ok=false
	Get(host string, port int) (fp, algo string, ok bool, err error)
	// Put 记录/覆盖 host:port 指纹（TOFU 首见 pin）
	Put(host string, port int, fp, algo string) error
	// Delete 清除单台主机钉扎（重置入口/主机删除级联）；未钉扎视为成功（幂等）
	Delete(host string, port int) error
}

type sshHostKeyRepo struct{ doc DocumentStore }

func newSSHHostKeyRepo(doc DocumentStore) *sshHostKeyRepo { return &sshHostKeyRepo{doc: doc} }

const sshHostKeyKind = "sshhostkeys"

// sshHostKeyKey host:port → 稳定文件名键。复用 peerCertKey 的哈希落键策略
// （host 原文形态各异，IPv6 字面量含 ':' 无法直接做文件名），host:port 原文
// 存文档体内；kind 独立于 peercerts，两域键空间不交叉
func sshHostKeyKey(host string, port int) string {
	return peerCertKey(net.JoinHostPort(host, strconv.Itoa(port)))
}

// sshHostKeyDoc 落盘结构（键为 host:port 哈希）
type sshHostKeyDoc struct {
	Host        string    `json:"host"`
	Port        int       `json:"port"`
	Fingerprint string    `json:"fingerprint"` // enc: 前缀 AES-GCM 密文（加密域见类型注释）
	Algo        string    `json:"algo"`
	PinnedAt    time.Time `json:"pinnedAt"`
}

func (r *sshHostKeyRepo) Get(host string, port int) (string, string, bool, error) {
	b, err := r.doc.Get(sshHostKeyKind, sshHostKeyKey(host, port))
	if err == ErrNotFound {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	var d sshHostKeyDoc
	if json.Unmarshal(b, &d) != nil || d.Fingerprint == "" {
		return "", "", false, nil
	}
	return config.DecryptIfNeeded(d.Fingerprint), d.Algo, true, nil
}

func (r *sshHostKeyRepo) Put(host string, port int, fp, algo string) error {
	if host == "" || fp == "" {
		return ErrInvalidArg
	}
	b, err := json.Marshal(sshHostKeyDoc{
		Host:        host,
		Port:        port,
		Fingerprint: config.EncryptIfNeeded(fp),
		Algo:        algo,
		PinnedAt:    time.Now(),
	})
	if err != nil {
		return err
	}
	key := sshHostKeyKey(host, port)
	return r.doc.Upsert(sshHostKeyKind, key, b)
}

func (r *sshHostKeyRepo) Delete(host string, port int) error {
	// 未钉扎返回成功（幂等）：重置入口对「从未连接过」的主机同样可用，
	// 级联清理路径（删除主机/改地址）也无需预查
	if err := r.doc.Delete(sshHostKeyKind, sshHostKeyKey(host, port)); err != nil && err != ErrNotFound {
		return err
	}
	return nil
}
