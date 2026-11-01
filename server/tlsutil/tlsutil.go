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
		Subject:      pkix.Name{CommonName: "codecombo"},
		NotBefore:    time.Now().Add(-24 * time.Hour), // 容忍客户端时钟略慢
		NotAfter:     time.Now().Add(certValidity),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     dnsNames(),
		IPAddresses:  ipSANs(),
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
