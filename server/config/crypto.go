package config

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/scrypt"
)

const (
	// 加密前缀，用于区分加密和明文 Token
	encPrefix = "enc:"
	// master-key 字节数（AES-256）
	masterKeySize = 32
)

var (
	masterKey     []byte
	masterKeyOnce sync.Once
)

// masterKeyPath 返回 master-key 文件路径
// 与 data 目录绑定，跨机可迁移（复制整个 data 目录即可解密）
func masterKeyPath() string {
	return filepath.Join(DataDir(), "data", "master-key")
}

// loadOrCreateMasterKey 加载已有或生成新的 32 字节随机主密钥
// 文件权限 0600，目录权限 0700
func loadOrCreateMasterKey() ([]byte, error) {
	p := masterKeyPath()
	if data, err := os.ReadFile(p); err == nil && len(data) == masterKeySize {
		return data, nil
	}
	key := make([]byte, masterKeySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate master key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return nil, fmt.Errorf("mkdir for master key: %w", err)
	}
	if err := os.WriteFile(p, key, 0600); err != nil {
		return nil, fmt.Errorf("write master key: %w", err)
	}
	return key, nil
}

// getMasterKey 进程级懒加载 master-key
// helper 子进程通过 SC_DATA_DIR 继承到同一文件，实现跨进程一致
func getMasterKey() []byte {
	masterKeyOnce.Do(func() {
		key, err := loadOrCreateMasterKey()
		if err != nil {
			// 与 config.json 损坏的显式降级（corrupt.go，P-20261006-10）语义
			// 区分：密钥坏 = 既有加密数据全部不可解，无「默认值」可退，Fatal
			// 合理；config.json 是可默认化的普通配置，走保全+告知降级启动。
			// 两类落盘损坏勿混同处理
			log.Fatal("无法加载 master-key: ", err)
		}
		masterKey = key
	})
	return masterKey
}

// MasterKey 返回部署级稳定主密钥（32 字节随机，随 data 目录持久化）。
// 供「派生型」用途：对公开暴露的标识做 HMAC 混淆（如文件分享短链 token），
// 让标识既跨重启稳定、又不可被外部枚举预测。不要用于新增加密场景的密钥协商
func MasterKey() []byte { return getMasterKey() }

// EncryptToken 使用 AES-GCM 加密 Token
func EncryptToken(plainText string) (string, error) {
	if plainText == "" {
		return "", nil
	}

	key := getMasterKey()
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	// 生成随机 nonce
	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}

	// nonce 前置于密文
	ciphertext := aesGCM.Seal(nonce, nonce, []byte(plainText), nil)
	return encPrefix + base64.StdEncoding.EncodeToString(ciphertext), nil
}

// IsEncrypted 判断字符串是否以 enc: 前缀（已加密）
func IsEncrypted(s string) bool {
	return len(s) >= len(encPrefix) && s[:len(encPrefix)] == encPrefix
}

// EncryptIfNeeded 空串/已加密串原样返回，否则加密（供 store 层使用）
func EncryptIfNeeded(plain string) string {
	if plain == "" || IsEncrypted(plain) {
		return plain
	}
	enc, err := EncryptToken(plain)
	if err != nil {
		return plain
	}
	return enc
}

// DecryptIfNeeded enc: 前缀解密，否则原样返回（兼容旧明文）
func DecryptIfNeeded(enc string) string {
	if enc == "" || !IsEncrypted(enc) {
		return enc
	}
	plain, err := DecryptToken(enc)
	if err != nil {
		return enc
	}
	return plain
}

// DecryptToken 解密 AES-GCM 加密的 Token
func DecryptToken(encrypted string) (string, error) {
	if encrypted == "" {
		return "", nil
	}

	// 不以 enc: 开头说明是明文，直接返回（向后兼容）
	if !IsEncrypted(encrypted) {
		return encrypted, nil
	}

	data, err := base64.StdEncoding.DecodeString(encrypted[len(encPrefix):])
	if err != nil {
		return "", fmt.Errorf("decode base64: %w", err)
	}

	key := getMasterKey()
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	nonceSize := aesGCM.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plainText, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}

	return string(plainText), nil
}

// ============== 口令信封加密（导入/导出文件） ==============

const (
	// EnvelopeFormat 口令加密信封的格式标识，导入端据此区分信封与旧版明文格式
	EnvelopeFormat = "simple-coding.crypt-envelope"
	// 信封布局版本：字段变更时递增
	envelopeVersion = 1
	// scrypt 参数：导出/导入是低频操作，取偏保守高强度（N=2^16，约 64MB 内存、单次数百毫秒）；
	// 参数随信封持久化，未来提升不影响旧文件解密
	scryptN = 65536
	scryptR = 8
	scryptP = 1
	// 盐字节数
	envelopeSaltSize = 16
	kdfScrypt        = "scrypt"
)

// PassphraseEnvelope 口令加密信封（导出文件顶层结构）
// ciphertext = AES-256-GCM(scrypt(passphrase, salt), nonce, plaintext)
type PassphraseEnvelope struct {
	Format     string `json:"format"`
	Version    int    `json:"version"`
	Kdf        string `json:"kdf"`
	KdfN       int    `json:"kdfN"`
	KdfR       int    `json:"kdfR"`
	KdfP       int    `json:"kdfP"`
	Salt       string `json:"salt"`       // base64
	Nonce      string `json:"nonce"`      // base64
	Ciphertext string `json:"ciphertext"` // base64
}

// MigrationFormat 换机迁移包（.scpkg，P-20261003-147）的格式标识。
// 与凭据导出信封（EnvelopeFormat）同内核不同格式串：导入端据此区分
// 「整机迁移包」与「单域凭据导出文件」，两类消费方互不误吞
const MigrationFormat = "simple-coding.migration"

// EncryptWithPassphrase 用口令对任意字节做认证加密，输出信封 JSON。
// 与 master-key 静态加密相互独立：导出文件的安全性只取决于口令强度与 scrypt 成本
func EncryptWithPassphrase(plaintext, passphrase []byte) ([]byte, error) {
	return EncryptWithPassphraseFormat(plaintext, passphrase, EnvelopeFormat)
}

// EncryptWithPassphraseFormat EncryptWithPassphrase 的格式参数化形态：
// 信封结构与 KDF 参数完全同构，仅顶层格式标识（与信封版本号）由调用方指定。
// 信封版本随 format 语义归属各自的消费方，不在本层取值
func EncryptWithPassphraseFormat(plaintext, passphrase []byte, format string) ([]byte, error) {
	if len(passphrase) == 0 {
		return nil, fmt.Errorf("empty passphrase")
	}
	salt := make([]byte, envelopeSaltSize)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}
	key, err := scrypt.Key(passphrase, salt, scryptN, scryptR, scryptP, masterKeySize)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	env := PassphraseEnvelope{
		Format:     format,
		Version:    envelopeVersion,
		Kdf:        kdfScrypt,
		KdfN:       scryptN,
		KdfR:       scryptR,
		KdfP:       scryptP,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(aesGCM.Seal(nil, nonce, plaintext, nil)),
	}
	return json.Marshal(env)
}

// DecryptWithPassphrase 解开口令信封。口令错误与文件损坏统一报错不区分原因，
// 供调用方回传同一条用户提示，避免向外泄露可区分信息
func DecryptWithPassphrase(data, passphrase []byte) ([]byte, error) {
	return DecryptWithPassphraseFormat(data, passphrase, EnvelopeFormat)
}

// DecryptWithPassphraseFormat DecryptWithPassphrase 的格式参数化形态。
// 格式串不匹配即整体拒绝——信封结构本身不区分「口令错」与「不是这类文件」，
// 调用方对两种失败统一给同一文案（防 oracle，WrongPassphraseExport 同口径）
func DecryptWithPassphraseFormat(data, passphrase []byte, format string) ([]byte, error) {
	var env PassphraseEnvelope
	if err := json.Unmarshal(data, &env); err != nil || env.Format != format {
		return nil, fmt.Errorf("not a passphrase envelope")
	}
	if env.Kdf != kdfScrypt || env.KdfN == 0 || env.KdfR == 0 || env.KdfP == 0 {
		return nil, fmt.Errorf("unsupported envelope kdf")
	}
	salt, err := base64.StdEncoding.DecodeString(env.Salt)
	if err != nil {
		return nil, fmt.Errorf("decode salt: %w", err)
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil {
		return nil, fmt.Errorf("decode nonce: %w", err)
	}
	ciphertext, err := base64.StdEncoding.DecodeString(env.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decode ciphertext: %w", err)
	}
	key, err := scrypt.Key(passphrase, salt, env.KdfN, env.KdfR, env.KdfP, masterKeySize)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	plain, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt: wrong passphrase or corrupted file")
	}
	return plain, nil
}
