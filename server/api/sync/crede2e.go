package sync

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"codecombo/server/errmarkers"

	"golang.org/x/crypto/hkdf"
)

// 端到端 AEAD 传输层（P-20261024-3 方案③核心补强）：凭据档载荷在 TLS 之内
// 再加一层信封加密（encrypt-then-send / decrypt-then-land）。
//
// 威胁面与边界（提案评审收窄如实声明）：
//   - 防 TLS 终止点 / 代理日志窥视（载荷在应用层已密文）；
//   - 防配对后 MITM（pairing key 人工抄录交换，信道攻击者无钥）；
//   - 防重放（发送侧单调 Seq + AAD 绑定 + 收端水位拒绝回退）；
//   - 配对窗口 MITM 由人工抄录通道消除（不在本层能力内）；
//   - 首连 TOFU 窗口由「首次携密强制证书指纹短码双端核对」兜底（credflow 层）。
//
// 密钥派生与版本演进：HKDF-SHA256(ikm=pairingKey, salt=每次传输随机 16B,
// info="simple-coding.credsync/v1") → 32B AES-256-GCM 会话钥。版本字段随
// envelope 演进递增，旧版信封在解链前按版本拒绝（不静默尝试）。
//
// AAD 绑定 format|version|pairFp|dir|seq：篡改任一元数据即解密失败；失败
// 对外统一 errmarkers.CredSyncEnvelopeRejected 文案（防 oracle——不给中间人
// 区分「钥不对/被篡改/序号回退」的回声；服务端日志可区分供排障）。

const (
	// CredEnvelopeFormat 信封格式标识（解链端 schema 门禁）
	CredEnvelopeFormat = "simple-coding.credsync"
	// CredEnvelopeVersion 信封版本（v1 = HKDF-SHA256 + AES-256-GCM 单发）
	CredEnvelopeVersion = 1
	// hkdfInfo v1 派生 info 串（版本演进时新增常量，不复用旧串）
	hkdfInfo = "simple-coding.credsync/v1"
	// hkdfSaltBytes / aeadNonceBytes HKDF 盐与 GCM nonce 长度
	hkdfSaltBytes  = 16
	aeadNonceBytes = 12
)

// CredEnvelope 携密传输信封（JSON 出入 HTTP body——凭据档 KB~MB 级，免流式）
type CredEnvelope struct {
	Format  string `json:"format"`
	Version int    `json:"version"`
	// PairFp 配对密钥短指纹（收端选钥；双端核对短码同源）
	PairFp string `json:"pairFp"`
	// Dir 发送方向（push=发送方主动推 / pull=发送方应拉取方请求服务）——
	// 双端同钥各方向独立序号空间，重放水位按方向分账
	Dir string `json:"dir"`
	// Kdf 派生算法标识（v1 固定 hkdf-sha256；演进字段）
	Kdf string `json:"kdf"`
	// Salt / Nonce base64（每次传输随机；nonce 单发一次性——同钥同 nonce 重用
	// 由「每次随机盐派生独立会话钥」结构性排除）
	Salt  string `json:"salt"`
	Nonce string `json:"nonce"`
	// Seq 发送侧单调序号（重放防护主锚点）
	Seq int64 `json:"seq"`
	// Ciphertext base64(AES-256-GCM(CredVault JSON))，AAD=envAAD(...)
	Ciphertext string `json:"ciphertext"`
}

// envAAD 信封元数据绑定（防元数据替换/拼接重排）
func envAAD(fp, dir string, seq int64) []byte {
	return []byte(fmt.Sprintf("%s|%d|%s|%s|%d", CredEnvelopeFormat, CredEnvelopeVersion, fp, dir, seq))
}

// deriveSessionKey HKDF-SHA256 派生会话钥（v1）
func deriveSessionKey(pairingKey, salt []byte) ([]byte, error) {
	r := hkdf.New(sha256.New, pairingKey, salt, []byte(hkdfInfo))
	key := make([]byte, pairingKeyBytes)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("hkdf derive: %w", err)
	}
	return key, nil
}

// sealCredVault 凭据档 → E2E 信封（发送侧唯一入口）。seq 由调用方从
// CredSyncState.SendSeq 递增后传入
func sealCredVault(vault *CredVault, pairingKey []byte, dir string, seq int64) (*CredEnvelope, error) {
	body, err := json.Marshal(vault)
	if err != nil {
		return nil, err
	}
	salt := make([]byte, hkdfSaltBytes)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}
	key, err := deriveSessionKey(pairingKey, salt)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aeadNonceBytes)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	fp := PairFp(pairingKey)
	ct := gcm.Seal(nil, nonce, body, envAAD(fp, dir, seq))
	return &CredEnvelope{
		Format:     CredEnvelopeFormat,
		Version:    CredEnvelopeVersion,
		PairFp:     fp,
		Dir:        dir,
		Kdf:        "hkdf-sha256",
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Seq:        seq,
		Ciphertext: base64.StdEncoding.EncodeToString(ct),
	}, nil
}

// openCredEnvelope E2E 信封 → 凭据档（接收侧唯一入口）。lastSeq 为该方向
// 已见最大序号（水位；信封 Seq 必须 > lastSeq）。任何失败统一
// errmarkers.CredSyncEnvelopeRejected（调用方取 Error() 直接回传——本错误
// 的对外形态即稳定原文，内部原因只进服务端日志）
func openCredEnvelope(raw []byte, keys map[string][]byte, lastSeq int64) (*CredVault, error) {
	var env CredEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, rejectedCred("envelope not parseable")
	}
	if env.Format != CredEnvelopeFormat || env.Version != CredEnvelopeVersion {
		return nil, rejectedCred("unsupported envelope format/version")
	}
	if env.Dir != "push" && env.Dir != "pull" {
		return nil, rejectedCred("invalid direction")
	}
	if env.Kdf != "hkdf-sha256" {
		return nil, rejectedCred("unsupported kdf")
	}
	key, ok := keys[env.PairFp]
	if !ok || len(key) == 0 {
		return nil, rejectedCred("no pairing key for fingerprint")
	}
	if env.Seq <= lastSeq {
		// 重放/回退：水位只前进——旧信封即使重放也无法再次落盘
		return nil, rejectedCred("sequence not newer than watermark")
	}
	salt, err := base64.StdEncoding.DecodeString(env.Salt)
	if err != nil || len(salt) != hkdfSaltBytes {
		return nil, rejectedCred("bad salt")
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil || len(nonce) != aeadNonceBytes {
		return nil, rejectedCred("bad nonce")
	}
	ct, err := base64.StdEncoding.DecodeString(env.Ciphertext)
	if err != nil || len(ct) == 0 {
		return nil, rejectedCred("bad ciphertext")
	}
	sk, err := deriveSessionKey(key, salt)
	if err != nil {
		return nil, rejectedCred("derive failed")
	}
	block, err := aes.NewCipher(sk)
	if err != nil {
		return nil, rejectedCred("cipher init failed")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, rejectedCred("gcm init failed")
	}
	plain, err := gcm.Open(nil, nonce, ct, envAAD(env.PairFp, env.Dir, env.Seq))
	if err != nil {
		return nil, rejectedCred("aead open failed (tampered or wrong key)")
	}
	vault, err := parseCredVault(plain)
	if err != nil {
		return nil, rejectedCred(err.Error())
	}
	return vault, nil
}

// rejectedCred 统一拒绝错误：对外原文恒为 errmarkers.CredSyncEnvelopeRejected
// （防 oracle），内部原因经 Reason() 记服务端日志
type rejectedCredError struct{ reason string }

func rejectedCred(reason string) error { return &rejectedCredError{reason: reason} }

func (e *rejectedCredError) Error() string { return errmarkers.CredSyncEnvelopeRejected }

func (e *rejectedCredError) Reason() string { return e.reason }

// credRejectReason 提取内部原因（非 rejectedCredError 返回原错误文本）
func credRejectReason(err error) string {
	if re, ok := err.(*rejectedCredError); ok {
		return re.Reason()
	}
	return err.Error()
}
