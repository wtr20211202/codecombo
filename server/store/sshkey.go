package store

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"codecombo/server/config"

	"github.com/google/uuid"
	"golang.org/x/crypto/ed25519"
	"golang.org/x/crypto/ssh"
)

// SSHKey 是 SSH 私钥记录（迁移自 server/config/sshkey.go）
// 命名统一为 SSHKey（不缩写），与 SSHClient 一致
type SSHKey struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Fingerprint string    `json:"fingerprint"`
	Algo        string    `json:"algo"` // "ed25519" / "rsa"
	Host        string    `json:"host"`
	PrivatePem  string    `json:"private_pem"` // enc: 前缀 AES-GCM 加密落盘（A7；历史明文在 listMeta 懒迁移）
	CreatedAt   time.Time `json:"created_at"`
}

// SSHKeyPublic 前端展示用，不含私钥
type SSHKeyPublic struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Fingerprint string    `json:"fingerprint"`
	Algo        string    `json:"algo"`
	Host        string    `json:"host"`
	CreatedAt   time.Time `json:"created_at"`
}

// ToPublic 转为不含私钥的展示对象
func (k SSHKey) ToPublic() SSHKeyPublic {
	return SSHKeyPublic{
		ID:          k.ID,
		Name:        k.Name,
		Fingerprint: k.Fingerprint,
		Algo:        k.Algo,
		Host:        k.Host,
		CreatedAt:   k.CreatedAt,
	}
}

type SshKeyStore interface {
	ListPublic() ([]SSHKeyPublic, error)
	Generate(name, algo string) (SSHKeyPublic, string, error)
	Import(name string, privateKeyPEM []byte) (SSHKeyPublic, error)
	Delete(id string) error
	GetPub(id string) (string, error)
	GetPrivatePem(id string) (string, error)
	FindByHost(host string) (*SSHKey, error)
	GetByID(id string) (*SSHKey, error)
	FindByFingerprint(fp string) (*SSHKey, error)
	// MigrateLegacyPem 历史明文 PEM 记录重加密落盘（A7）。启动期调用一次；
	// 读路径（listMeta）只保留明文兼容读取，不再有写盘副作用
	//（持久化纪律：读路径禁止写副作用，见 docs/PERSISTENCE_LANES.md 车道 1）
	MigrateLegacyPem() (int, error)
}

type sshKeyRepo struct{ doc DocumentStore }

func (r *sshKeyRepo) ListPublic() ([]SSHKeyPublic, error) {
	all, err := r.listMeta()
	if err != nil {
		return nil, err
	}
	out := make([]SSHKeyPublic, 0, len(all))
	for _, k := range all {
		out = append(out, k.ToPublic())
	}
	return out, nil
}

// listMeta 仅读展示字段，不读 PEM 私钥（避免大体积数据进内存）。
// 历史明文/旧字段名（raw["pem"]）只做兼容读取；重加密迁移在启动期
// MigrateLegacyPem 完成——读路径无写盘副作用
func (r *sshKeyRepo) listMeta() ([]SSHKey, error) {
	keys, _, err := r.doc.List("sshkeys", ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]SSHKey, 0, len(keys))
	for _, k := range keys {
		data, _ := r.doc.Get("sshkeys", k)
		var sk SSHKey
		if json.Unmarshal(data, &sk) == nil {
			// 兼容历史数据：旧格式把 PEM 存在 raw["pem"]，struct 反序列化后 PrivatePem 为空
			if sk.PrivatePem == "" {
				var raw map[string]interface{}
				if json.Unmarshal(data, &raw) == nil {
					if pemStr, ok := raw["pem"].(string); ok {
						sk.PrivatePem = pemStr
					}
				}
			}
			out = append(out, sk)
		}
	}
	return out, nil
}

// MigrateLegacyPem 扫描全部记录，把明文 PEM（含旧 raw["pem"] 字段形态）
// 重加密为 enc: 前缀落盘；返回迁移条数。幂等：已加密记录不动
func (r *sshKeyRepo) MigrateLegacyPem() (int, error) {
	keys, _, err := r.doc.List("sshkeys", ListOpts{})
	if err != nil {
		return 0, err
	}
	migrated := 0
	for _, k := range keys {
		data, err := r.doc.Get("sshkeys", k)
		if err != nil {
			continue
		}
		var sk SSHKey
		if json.Unmarshal(data, &sk) != nil {
			continue
		}
		if sk.PrivatePem == "" {
			// 旧字段名形态：读出后既写入新字段也即完成迁移
			var raw map[string]interface{}
			if json.Unmarshal(data, &raw) == nil {
				if pemStr, ok := raw["pem"].(string); ok {
					sk.PrivatePem = pemStr
				}
			}
		}
		if sk.PrivatePem == "" || config.IsEncrypted(sk.PrivatePem) {
			continue
		}
		enc := config.EncryptIfNeeded(sk.PrivatePem)
		if !config.IsEncrypted(enc) {
			continue
		}
		sk.PrivatePem = enc
		if newData, merr := json.Marshal(sk); merr == nil {
			if uerr := r.doc.Update("sshkeys", sk.ID, newData); uerr == nil {
				migrated++
				slog.Info("sshkey: legacy plaintext pem migrated to encrypted at rest", "id", sk.ID)
			}
		}
	}
	return migrated, nil
}

func (r *sshKeyRepo) Generate(name, algo string) (SSHKeyPublic, string, error) {
	pubKey, pemBlock, err := genKeyPair(algo)
	if err != nil {
		return SSHKeyPublic{}, "", err
	}
	fp := fingerprint(pubKey)
	pubKeyStr := string(ssh.MarshalAuthorizedKey(pubKey))

	id := uuid.New().String()
	sk := SSHKey{
		ID:          id,
		Name:        name,
		Fingerprint: fp,
		Algo:        pubKey.Type(),
		PrivatePem:  config.EncryptIfNeeded(string(pemBlock)), // 内嵌 PEM 加密落盘（A7）
		CreatedAt:   time.Now(),
	}
	data, _ := json.Marshal(sk)
	if err := r.doc.Create("sshkeys", id, data); err != nil {
		return SSHKeyPublic{}, "", err
	}
	return sk.ToPublic(), pubKeyStr, nil
}

func (r *sshKeyRepo) Import(name string, pemData []byte) (SSHKeyPublic, error) {
	signer, err := ssh.ParsePrivateKey(pemData)
	if err != nil {
		return SSHKeyPublic{}, fmt.Errorf("invalid private key: %w", err)
	}
	fp := fingerprint(signer.PublicKey())

	id := uuid.New().String()
	sk := SSHKey{
		ID:          id,
		Name:        name,
		Fingerprint: fp,
		Algo:        signer.PublicKey().Type(),
		PrivatePem:  config.EncryptIfNeeded(string(pemData)), // 加密落盘（A7）
		CreatedAt:   time.Now(),
	}
	data, _ := json.Marshal(sk)
	if err := r.doc.Create("sshkeys", id, data); err != nil {
		return SSHKeyPublic{}, err
	}
	return sk.ToPublic(), nil
}

func (r *sshKeyRepo) Delete(id string) error {
	return r.doc.Delete("sshkeys", id)
}

func (r *sshKeyRepo) GetPub(id string) (string, error) {
	pemStr, err := r.GetPrivatePem(id)
	if err != nil {
		return "", err
	}
	signer, err := ssh.ParsePrivateKey([]byte(pemStr))
	if err != nil {
		return "", err
	}
	return string(ssh.MarshalAuthorizedKey(signer.PublicKey())), nil
}

// GetPrivatePem 返回指定 SSH key 的 PEM 私钥明文（用于远程部署时连接目标主机）
func (r *sshKeyRepo) GetPrivatePem(id string) (string, error) {
	data, err := r.doc.Get("sshkeys", id)
	if err != nil {
		return "", err
	}
	// 优先按新 struct 反序列化读 PrivatePem 字段
	var sk SSHKey
	if json.Unmarshal(data, &sk) == nil && sk.PrivatePem != "" {
		return config.DecryptIfNeeded(sk.PrivatePem), nil
	}
	// 兼容历史数据：旧格式用 raw["pem"] 字段（历史明文，无需解密）
	var raw map[string]interface{}
	if json.Unmarshal(data, &raw) != nil {
		return "", ErrNotFound
	}
	pemStr, _ := raw["pem"].(string)
	if pemStr == "" {
		return "", ErrNotFound
	}
	return pemStr, nil
}

func (r *sshKeyRepo) FindByHost(host string) (*SSHKey, error) {
	normalized := HostFromURL(host)
	all, err := r.listMeta()
	if err != nil {
		return nil, err
	}
	for _, k := range all {
		// 容错：历史数据可能存了未 trim 的 host，再次标准化后比较
		if k.Host != "" && HostFromURL(k.Host) == normalized {
			return &k, nil
		}
	}
	for _, k := range all {
		if k.Host == "" {
			return &k, nil
		}
	}
	return nil, nil
}

// GetByID 按 id 返回完整密钥（PrivatePem 为加密态，与 FindByHost 同构——
// 供 git SSH 注入按用户选定 id 精确取钥匙，而非仅按 host 匹配）
func (r *sshKeyRepo) GetByID(id string) (*SSHKey, error) {
	all, err := r.listMeta()
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, ErrNotFound
}

// FindByFingerprint 按公钥指纹查找完整密钥（PrivatePem 为加密态）。
// 供远程主机导入按指纹去重：同钥已存在时映射既有 ID，不重复入库
func (r *sshKeyRepo) FindByFingerprint(fp string) (*SSHKey, error) {
	if fp == "" {
		return nil, ErrNotFound
	}
	all, err := r.listMeta()
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].Fingerprint == fp {
			return &all[i], nil
		}
	}
	return nil, ErrNotFound
}

// genKeyPair 生成 SSH 密钥对
func genKeyPair(algo string) (ssh.PublicKey, []byte, error) {
	switch algo {
	case "rsa":
		return genRSA()
	default:
		return genEd25519()
	}
}

func genEd25519() (ssh.PublicKey, []byte, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, nil, err
	}
	block, _ := ssh.MarshalPrivateKey(priv, "")
	return signer.PublicKey(), pem.EncodeToMemory(block), nil
}

func genRSA() (ssh.PublicKey, []byte, error) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, err
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, nil, err
	}
	block, _ := ssh.MarshalPrivateKey(priv, "")
	return signer.PublicKey(), pem.EncodeToMemory(block), nil
}

func fingerprint(pub ssh.PublicKey) string {
	h := sha256.Sum256(pub.Marshal())
	enc := base64.StdEncoding.EncodeToString(h[:])
	return "SHA256:" + strings.TrimRight(enc, "=")
}
