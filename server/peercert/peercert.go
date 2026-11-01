// Package peercert 实例间 TLS 连接的证书指纹库（自签 TOFU 语义）。
//
// 产品默认安全面是"加密 + 自签 TOFU"：实例间出站 HTTPS 连接默认不要求对端
// 证书进入系统信任库，而是首连时记录对端证书 SHA-256 指纹（Trust On First
// Use，SSH known_hosts 同款语义），此后每次连接比对指纹——一致放行、变更
// 即拒（可能中间人，管理员清除指纹记录重新信任）。这样内网自签部署免掉
// "导入对方证书到信任库"的整套流程，同时保留中间人防护。
//
// 指纹持久化为车道 1 kind "peercerts"（server/store/peercert.go，host 一文档）；
// 历史整文件 peer-certs.json 由组合根启动期 MigrateLegacy 导入（持久化纪律
// 债务 #1 收编，见 docs/PERSISTENCE_LANES.md）。
//
// 严格模式：管理员开启 settings.tlsVerifyPeer 后，改走系统信任库严格校验
// （对端证书需装入本机信任库），由 TLSConfig 的 VerifyConnection 按当前
// 策略动态分流（每次握手实时读取，设置切换即时生效）。
package peercert

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"codecombo/server/config"
	"codecombo/server/store"
)

// CheckOrPin TOFU 校验：host 首见则记录指纹并放行；已见则比对，
// 不一致返回错误（对端证书变更——可能中间人；确认合法时删除
// <DataDir>/data/peercerts/ 下对应文档或调用 Reset 重新信任）
func CheckOrPin(host string, der []byte) error {
	if host == "" || len(der) == 0 {
		return nil
	}
	sum := sha256.Sum256(der)
	fp := hex.EncodeToString(sum[:])

	peer := store.Get().PeerCert
	known, ok, err := peer.GetFingerprint(host)
	if err != nil {
		// 读库失败按首见处理继续 pin：TOFU 的失败面（连不上对端）比
		// 误拒更可接受，且下一轮连接会重试
		slog.Warn("peercert: read fingerprint store failed — pinning as first-seen", "host", host, "err", err)
	}
	if ok {
		if known != fp {
			return fmt.Errorf("peer certificate of %s has changed (fingerprint mismatch) — if this is intentional, remove its entry under %s and restart, or reset peer certs", host, filepath.Join(config.DataDir(), "data", "peercerts"))
		}
		return nil
	}
	if err := peer.PutFingerprint(host, fp); err != nil {
		return fmt.Errorf("pin peer certificate of %s: %w", host, err)
	}
	return nil
}

// Reset 清除全部已记录指纹（下次连接重新 TOFU）
func Reset() {
	if err := store.Get().PeerCert.ResetPeerCerts(); err != nil {
		slog.Warn("peercert: reset failed", "err", err)
	}
}

// MigrateLegacy 把旧版 DataDir/peer-certs.json（host→指纹 map 整文件重写形态）
// 导入 peercerts kind。成功后原文件改名为 peer-certs.json.migrated 保留备份；
// 文件不存在/已迁移直接返回。幂等，组合根启动期调用。
func MigrateLegacy() {
	legacy := filepath.Join(config.DataDir(), "peer-certs.json")
	data, err := os.ReadFile(legacy)
	if err != nil {
		return // 无旧文件（新装/已迁移）：无需处理
	}
	var fingerprints map[string]string
	if err := json.Unmarshal(data, &fingerprints); err != nil {
		slog.Warn("peercert: legacy peer-certs.json unreadable — leaving it in place", "err", err)
		return
	}
	imported := 0
	for host, fp := range fingerprints {
		if host == "" || fp == "" {
			continue
		}
		if err := store.Get().PeerCert.PutFingerprint(host, fp); err == nil {
			imported++
		} else {
			slog.Warn("peercert: legacy fingerprint import failed", "host", host, "err", err)
		}
	}
	if err := os.Rename(legacy, legacy+".migrated"); err != nil {
		slog.Warn("peercert: rename legacy file failed — will re-import on next start", "err", err)
		return
	}
	slog.Info("peercert: legacy peer-certs.json migrated to peercerts kind", "imported", imported)
}

// TLSConfig 实例间出站连接的 TLS 客户端配置：
//   - 默认：TOFU 指纹校验（自签直达，免信任库导入）
//   - settings.tlsVerifyPeer 开启：系统信任库严格校验（主机名/IP + 信任链）
//
// VerifyConnection 内每次握手实时读取策略，设置切换即时生效，
// 连接池复用本配置也无陈旧问题
func TLSConfig() *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true, // 校验由 VerifyConnection 完全接管（TOFU 指纹/严格模式），见函数注释
		VerifyConnection: func(cs tls.ConnectionState) error {
			return verify(cs)
		},
	}
}

func verify(cs tls.ConnectionState) error {
	if len(cs.PeerCertificates) == 0 {
		return errors.New("peer presented no certificate")
	}
	if store.Get().Settings.Get().Server.TLSVerifyPeerOrDefault() {
		// 严格模式：等价默认校验链——系统信任库 + 主机名/IP 匹配
		opts := x509.VerifyOptions{
			DNSName:       cs.ServerName,
			Intermediates: x509.NewCertPool(),
		}
		for _, cert := range cs.PeerCertificates[1:] {
			opts.Intermediates.AddCert(cert)
		}
		_, err := cs.PeerCertificates[0].Verify(opts)
		return err
	}
	// 默认：TOFU 指纹校验
	return CheckOrPin(cs.ServerName, cs.PeerCertificates[0].Raw)
}
