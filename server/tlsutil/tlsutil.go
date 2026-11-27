// Package tlsutil 为 simple-coding 的 HTTPS/WSS 监听提供证书管理：
// 自签证书自动生成（无配置即可启用 TLS）与自定义证书加载。
//
// 设计约束：局域网部署通常没有 CA 签发的证书，自签是唯一开箱即用路径；
// 浏览器侧按 TOFU（信任首次使用）处理——启动日志输出证书 SHA-256 指纹供核对。
package tlsutil

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// certValidity 自签证书有效期：局域网部署重签发成本高（需登每台客户端），
// 取 10 年长效；泄露场景按更换数据目录/证书文件处理
const certValidity = 10 * 365 * 24 * time.Hour

// EnsureCert 返回可用于 ListenAndServeTLS 的证书/私钥路径。
// certPath+keyPath 均已存在且可加载时直接复用（重启不换证书）；
// 否则在 dir 下生成自签证书对（ECDSA P-256，SAN 覆盖 localhost/回环/本机网卡 IP/主机名）
func EnsureCert(dir string) (certPath, keyPath string, err error) {
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")

	if _, statErr := os.Stat(certPath); statErr == nil {
		if _, statErr := os.Stat(keyPath); statErr == nil {
			if _, loadErr := tls.LoadX509KeyPair(certPath, keyPath); loadErr == nil {
				return certPath, keyPath, nil
			} else {
				return "", "", fmt.Errorf("existing cert/key pair failed to load: %w", loadErr)
			}
		}
		return "", "", errors.New("cert.pem exists but key.pem is missing; remove cert.pem or restore key.pem")
	}
	// 部分残留（只剩私钥）：静默重签会让客户端固定的指纹悄悄失效，必须显式处理
	if _, statErr := os.Stat(keyPath); statErr == nil {
		return "", "", errors.New("key.pem exists but cert.pem is missing; restore cert.pem or remove both to regenerate")
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", fmt.Errorf("create cert dir: %w", err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", fmt.Errorf("generate key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", "", fmt.Errorf("generate serial: %w", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		// P-20261025-1 起新签发证书 CN=codecombo。存量证书不受影响（EnsureCert
		// 见 cert.pem+key.pem 即复用，CN 只是自签证书的展示性身份；peercert 的
		// TOFU 钉扎按指纹不按 CN——已有配对在证书自然轮换前零重配对面）
		Subject:     pkix.Name{CommonName: "codecombo"},
		NotBefore:   time.Now().Add(-24 * time.Hour), // 容忍客户端时钟略慢
		NotAfter:    time.Now().Add(certValidity),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:    dnsNames(),
		IPAddresses: ipSANs(),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return "", "", fmt.Errorf("create certificate: %w", err)
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", "", fmt.Errorf("marshal key: %w", err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return "", "", fmt.Errorf("write key: %w", err)
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return "", "", fmt.Errorf("write cert: %w", err)
	}
	return certPath, keyPath, nil
}

// Fingerprint 证书 SHA-256 指纹（冒号分隔十六进制，启动日志输出供 TOFU 核对）
func Fingerprint(certPath string) (string, error) {
	data, err := os.ReadFile(certPath)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return "", errors.New("no PEM block in cert file")
	}
	sum := sha256.Sum256(block.Bytes)
	return formatFingerprint(sum), nil
}

func formatFingerprint(sum [32]byte) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, 32*3)
	for i, b := range sum {
		if i > 0 {
			out = append(out, ':')
		}
		out = append(out, hexDigits[b>>4], hexDigits[b&0x0f])
	}
	return string(out)
}

func dnsNames() []string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return []string{"localhost"}
	}
	return []string{"localhost", host}
}

func ipSANs() []net.IP {
	ips := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ips
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP != nil && !ipnet.IP.IsLoopback() {
			ips = append(ips, ipnet.IP)
		}
	}
	return ips
}

// HSTSHeaderValue Strict-Transport-Security 单一源（P-20261124-1 S3②）：
// app.go 的下发中间件与诊断包 tls.json 引用同一常量——两处手写 max-age
// 必然漂移，而 HSTS 写错会静默把一个 IP 字面量主机锁在 https 上。
// 注意：HSTS 规范对 IP 字面量主机不生效（RFC 6797 §2.3），自签场景另见
// 诊断包 README 的删除 cert.pem+key.pem 重签指引。
const HSTSHeaderValue = "max-age=31536000"

// LeafSummary 证书公钥元数据（P-20261124-1 S3②）：只读 certPath 的第一个
// CERTIFICATE PEM 块，**绝不读私钥**（key 路径不在签名里，物理上不可能被读）。
// 供诊断包 state/tls.json 使用：排障要回答「客户端为什么拒绝握手」——
// 指纹/有效期/SAN/自签是最直接的三个判据。
type LeafInfo struct {
	Subject       string   `json:"subject"`
	Issuer        string   `json:"issuer"`
	SerialNumber  string   `json:"serialNumber"`
	NotBefore     string   `json:"notBefore"`
	NotAfter      string   `json:"notAfter"`
	DaysRemaining int      `json:"daysRemaining"`
	DNSNames      []string `json:"dnsNames"`
	IPAddresses   []string `json:"ipAddresses"`
	Fingerprint   string   `json:"sha256Fingerprint"`
	IsSelfSigned  bool     `json:"selfSigned"`
	KeyType       string   `json:"keyType"`
}

// LeafSummary 解析证书元数据（certPath 为空/不可读返回错误，调用方写 skipped）
func LeafSummary(certPath string) (*LeafInfo, error) {
	data, err := os.ReadFile(certPath)
	if err != nil {
		return nil, err
	}
	var der []byte
	for {
		block, rest := pem.Decode(data)
		if block == nil {
			break
		}
		if block.Type == "CERTIFICATE" {
			der = block.Bytes
			break
		}
		data = rest
	}
	if der == nil {
		return nil, errors.New("no CERTIFICATE PEM block in cert file")
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}
	sum := sha256.Sum256(der)
	s := &LeafInfo{
		Subject:       cert.Subject.String(),
		Issuer:        cert.Issuer.String(),
		SerialNumber:  cert.SerialNumber.String(),
		NotBefore:     cert.NotBefore.Format(time.RFC3339),
		NotAfter:      cert.NotAfter.Format(time.RFC3339),
		DaysRemaining: int(time.Until(cert.NotAfter).Hours() / 24),
		DNSNames:      append([]string{}, cert.DNSNames...),
		Fingerprint:   formatFingerprint(sum),
		KeyType:       cert.PublicKeyAlgorithm.String(),
	}
	for _, ip := range cert.IPAddresses {
		s.IPAddresses = append(s.IPAddresses, ip.String())
	}
	// 自签判定：issuer==subject 且自签名验证通过（仅判「是否自签」，不做信任链）
	s.IsSelfSigned = cert.Subject.String() == cert.Issuer.String() && cert.CheckSignatureFrom(cert) == nil
	return s, nil
}
