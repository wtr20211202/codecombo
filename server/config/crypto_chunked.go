package config

import (
	"bufio"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"strconv"

	"golang.org/x/crypto/scrypt"
)

// chunked AEAD v2 口令信封（P-20261003-147 全量迁移包）：v1 单发信封
//（EncryptWithPassphrase）的密文是单条 base64 串，必须整包驻内存——KB~MB 级
// 轻装包够用，GB 级全量包不行。v2 把明文切 64KB 块逐块 AEAD，内存 O(块) 不随
// 包体积涨，写入端流式直挂响应流、读取端流式解密。
//
// 线格式（NDJSON，值间换行分隔，json.Decoder 天然逐值流式解码）：
//
//	{"format":"simple-coding.migration","version":2,"mode":"full","kdf":"scrypt",
//	 "kdfN":65536,"kdfR":8,"kdfP":1,"salt":"…","nonce0":"…","chunkSize":65536}
//	{"i":1,"c":"<b64 密文块>"}
//	{"i":2,"c":"…"}
//	…
//	{"final":true,"c":"<b64 终结块（空明文）>"}
//
// 块 nonce = nonce0(4B) || BE64(计数器)，计数器从 1 起每块递增——随机前缀 +
// 单调计数器满足 GCM nonce 唯一性且无需每块存 nonce（信封体积零膨胀）。
// 防篡改/防重排/防截断：数据块 AAD 绑定块序号（重排或抽块 → 序号失配解密
// 失败），终结块以 "final" 为 AAD 且计数器续接（截掉尾部数据块 → 读不到终结
// 块即失败；截掉终结块 → 流提前 EOF 即失败）。KDF 参数沿用 v1（scrypt
// N=2^16·r=8·p=1，盐 16B，AES-256-GCM，参数随信封持久化——未来升级随版本
// 递增不破旧包）。

const (
	// chunkedEnvelopeVersion v2 线格式版本（v1 单发信封为 1；版本字段语义随
	// format 归属消费方：v1=单 JSON 信封、v2=NDJSON 分块信封）
	chunkedEnvelopeVersion = 2
	// chunkedChunkSize 每块明文字节（64KB：GCM 每块固定开销 ~45 字节 + base64
	// 膨胀，膨胀比 ~0.1%；块过大退化回整包驻内存，过小则逐块调度开销占比
	// 上升——64KB 是吞吐与内存的常规折中）
	chunkedChunkSize = 64 * 1024
	// nonce0Size 块 nonce 随机前缀字节数（余 8 字节为 BE64 计数器）
	nonce0Size = 4
	// chunkedMaxChunks 单包块数上限（64KB × 2^20 = 64TB，纯防御性上限；
	// 真实体量护栏在调用方的响应/请求体纪律）
	chunkedMaxChunks = 1 << 20
)

// ErrNotChunkedEnvelope 非 v2 分块信封（调用方回落 v1 单发信封解析）
var ErrNotChunkedEnvelope = fmt.Errorf("not a chunked envelope")

// ChunkedEnvelopeHeader NDJSON 信封首行（明文头：仅格式/版本/KDF 参数与模式
// 声明——摘要类元数据一律放密文体，防拿错文件与信息泄露两全）
type ChunkedEnvelopeHeader struct {
	Format    string `json:"format"`
	Version   int    `json:"version"`
	Mode      string `json:"mode,omitempty"`
	Kdf       string `json:"kdf"`
	KdfN      int    `json:"kdfN"`
	KdfR      int    `json:"kdfR"`
	KdfP      int    `json:"kdfP"`
	Salt      string `json:"salt"`   // base64
	Nonce0    string `json:"nonce0"` // base64（4 字节随机前缀）
	ChunkSize int    `json:"chunkSize"`
}

// chunkLine 数据块行
type chunkLine struct {
	I uint64 `json:"i"`
	C string `json:"c"` // base64 密文
}

// chunkFinalLine 终结块行（空明文块，AAD 绑定 "final"）
type chunkFinalLine struct {
	Final bool   `json:"final"`
	C     string `json:"c"`
}

// chunkAAD AAD 派生：种类 + 块序号 → 稳定字节串。写读两侧唯一事实源
func chunkAAD(kind string, i uint64) []byte {
	return []byte(kind + ":" + strconv.FormatUint(i, 10))
}

// chunkedKey scrypt 派生块密钥并建 GCM（与 v1 同参数族；盐/口令进、AEAD 出）
func chunkedKey(passphrase, salt []byte, n, r, p int) (cipher.AEAD, error) {
	key, err := scrypt.Key(passphrase, salt, n, r, p, masterKeySize)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	return gcm, nil
}

// chunkNonce 块 nonce：nonce0(4B) || BE64(counter)
func chunkNonce(nonce0 []byte, counter uint64) []byte {
	nonce := make([]byte, 12)
	copy(nonce, nonce0)
	binary.BigEndian.PutUint64(nonce[4:], counter)
	return nonce
}

// ChunkedEnvelopeWriter 流式分块口令加密写端。Write 逐块加密落 NDJSON 行，
// Close 落终结块（未 Close 的流读端按截断拒绝——调用方须保证 Close 被调用
// 且错误不被吞）
type ChunkedEnvelopeWriter struct {
	w       io.Writer
	gcm     cipher.AEAD
	nonce0  []byte
	counter uint64
	err     error
}

// NewChunkedEnvelopeWriter 写出首行头（format/mode 由调用方指定——本层是
// 通用设施，不绑定迁移格式串）。头落盘失败在返回值报出
func NewChunkedEnvelopeWriter(w io.Writer, passphrase []byte, format, mode string) (*ChunkedEnvelopeWriter, error) {
	if len(passphrase) == 0 {
		return nil, fmt.Errorf("empty passphrase")
	}
	salt := make([]byte, envelopeSaltSize)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}
	nonce0 := make([]byte, nonce0Size)
	if _, err := io.ReadFull(rand.Reader, nonce0); err != nil {
		return nil, fmt.Errorf("generate nonce0: %w", err)
	}
	gcm, err := chunkedKey(passphrase, salt, scryptN, scryptR, scryptP)
	if err != nil {
		return nil, err
	}
	header := ChunkedEnvelopeHeader{
		Format: format, Version: chunkedEnvelopeVersion, Mode: mode,
		Kdf: kdfScrypt, KdfN: scryptN, KdfR: scryptR, KdfP: scryptP,
		Salt:      base64.StdEncoding.EncodeToString(salt),
		Nonce0:    base64.StdEncoding.EncodeToString(nonce0),
		ChunkSize: chunkedChunkSize,
	}
	hb, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	cw := &ChunkedEnvelopeWriter{w: w, gcm: gcm, nonce0: nonce0}
	if _, cw.err = w.Write(append(hb, '\n')); cw.err != nil {
		return nil, cw.err
	}
	return cw, nil
}

// sealChunk 加密并写一行（data 为 nil 且 final 表示终结块）
func (cw *ChunkedEnvelopeWriter) sealChunk(data []byte, final bool) error {
	if cw.err != nil {
		return cw.err
	}
	cw.counter++
	if cw.counter > chunkedMaxChunks {
		cw.err = fmt.Errorf("chunk count limit exceeded")
		return cw.err
	}
	var line []byte
	var err error
	if final {
		line, err = json.Marshal(chunkFinalLine{Final: true, C: base64.StdEncoding.EncodeToString(
			cw.gcm.Seal(nil, chunkNonce(cw.nonce0, cw.counter), nil, chunkAAD("final", cw.counter)))})
	} else {
		line, err = json.Marshal(chunkLine{I: cw.counter, C: base64.StdEncoding.EncodeToString(
			cw.gcm.Seal(nil, chunkNonce(cw.nonce0, cw.counter), data, chunkAAD("chunk", cw.counter)))})
	}
	if err != nil {
		cw.err = err
		return err
	}
	line = append(line, '\n')
	if _, err := cw.w.Write(line); err != nil {
		cw.err = err
		return err
	}
	return nil
}

// Write 逐满块加密写出（调用方给多大写多大，不设内部缓冲——zip.Writer 的
// 32KB flush 粒度已足够）。错误粘滞：首错后所有后续调用返回同错
func (cw *ChunkedEnvelopeWriter) Write(p []byte) (int, error) {
	if cw.err != nil {
		return 0, cw.err
	}
	total := len(p)
	for len(p) > 0 {
		n := len(p)
		if n > chunkedChunkSize {
			n = chunkedChunkSize
		}
		if err := cw.sealChunk(p[:n], false); err != nil {
			return 0, err
		}
		p = p[n:]
	}
	return total, nil
}

// Close 落终结块。终结块空明文 + "final" AAD + 计数器续接：截断/抽块在读端
// 可检（EOF 无终结块即拒）。写失败后重复 Close 返回粘滞错误
func (cw *ChunkedEnvelopeWriter) Close() error {
	if cw.err != nil {
		return cw.err
	}
	return cw.sealChunk(nil, true)
}

// ChunkedEnvelopeReader 流式分块口令解密读端。io.Reader 语义：逐块解密填充
// 调用方缓冲；流截断/口令错/结构坏统一报错文案（"wrong passphrase or
// corrupted file"——与 v1 同口径防 oracle，调用方再统一映射）
type ChunkedEnvelopeReader struct {
	dec     *json.Decoder
	gcm     cipher.AEAD
	nonce0  []byte
	counter uint64
	buf     []byte // 当前块已解密未消费字节
	err     error
	done    bool // 已消费终结块
}

// ParseChunkedEnvelopeHeader 嗅探首行是否 v2 分块信封头（不消费调用方缓冲
// 之外的字节）。非本形态（含 v1 单 JSON 信封）返回 ErrNotChunkedEnvelope
func ParseChunkedEnvelopeHeader(firstValue []byte) (*ChunkedEnvelopeHeader, error) {
	var h ChunkedEnvelopeHeader
	if err := json.Unmarshal(firstValue, &h); err != nil {
		return nil, ErrNotChunkedEnvelope
	}
	if h.Format == "" || h.Version != chunkedEnvelopeVersion || h.ChunkSize <= 0 {
		return nil, ErrNotChunkedEnvelope
	}
	return &h, nil
}

// NewChunkedEnvelopeReader 从完整流（首个 JSON 值即头）建读端。
// KDF 参数与写端参数族不符即拒（读端不按信封头放大 KDF 成本）
func NewChunkedEnvelopeReaderFromStream(r io.Reader, passphrase []byte) (*ChunkedEnvelopeReader, error) {
	dec := json.NewDecoder(bufio.NewReaderSize(r, 64*1024))
	var h ChunkedEnvelopeHeader
	if err := dec.Decode(&h); err != nil {
		return nil, ErrNotChunkedEnvelope
	}
	if h.Format == "" || h.Version != chunkedEnvelopeVersion || h.ChunkSize <= 0 {
		return nil, ErrNotChunkedEnvelope
	}
	if h.Kdf != kdfScrypt || h.KdfN != scryptN || h.KdfR != scryptR || h.KdfP != scryptP {
		return nil, fmt.Errorf("unsupported chunked envelope kdf")
	}
	salt, err := base64.StdEncoding.DecodeString(h.Salt)
	if err != nil || len(salt) != envelopeSaltSize {
		return nil, fmt.Errorf("corrupted envelope salt")
	}
	nonce0, err := base64.StdEncoding.DecodeString(h.Nonce0)
	if err != nil || len(nonce0) != nonce0Size {
		return nil, fmt.Errorf("corrupted envelope nonce0")
	}
	gcm, err := chunkedKey(passphrase, salt, h.KdfN, h.KdfR, h.KdfP)
	if err != nil {
		return nil, err
	}
	return &ChunkedEnvelopeReader{dec: dec, gcm: gcm, nonce0: nonce0}, nil
}

// Read 实现 io.Reader：内部块缓冲空时解密下一块；终结块消费尽后 EOF。
// 任何解密失败成为粘滞错误
func (cr *ChunkedEnvelopeReader) Read(p []byte) (int, error) {
	if cr.err != nil {
		return 0, cr.err
	}
	for len(cr.buf) == 0 {
		if cr.done {
			cr.err = io.EOF
			return 0, io.EOF
		}
		if err := cr.nextChunk(); err != nil {
			cr.err = err
			return 0, err
		}
	}
	n := copy(p, cr.buf)
	cr.buf = cr.buf[n:]
	return n, nil
}

// nextChunk 解密下一行到 buf；终结块置 done（空明文不进 buf）
func (cr *ChunkedEnvelopeReader) nextChunk() error {
	var raw json.RawMessage
	if err := cr.dec.Decode(&raw); err != nil {
		// 流在终结块前结束 = 截断（可能伴随口令错不可区分——统一文案）
		return fmt.Errorf("decrypt: wrong passphrase or corrupted file")
	}
	var fin chunkFinalLine
	if json.Unmarshal(raw, &fin) == nil && fin.Final {
		cr.counter++
		ct, err := base64.StdEncoding.DecodeString(fin.C)
		if err != nil {
			return fmt.Errorf("decrypt: wrong passphrase or corrupted file")
		}
		plain, err := cr.gcm.Open(nil, chunkNonce(cr.nonce0, cr.counter), ct, chunkAAD("final", cr.counter))
		if err != nil || len(plain) != 0 {
			return fmt.Errorf("decrypt: wrong passphrase or corrupted file")
		}
		cr.done = true
		return nil
	}
	var cl chunkLine
	if json.Unmarshal(raw, &cl) != nil || cl.I == 0 {
		return fmt.Errorf("decrypt: wrong passphrase or corrupted file")
	}
	cr.counter++
	if cl.I != cr.counter || cr.counter > chunkedMaxChunks {
		// 块序号必须连续递增（AAD 已绑序号，这里是快速失败短路解密）
		return fmt.Errorf("decrypt: wrong passphrase or corrupted file")
	}
	ct, err := base64.StdEncoding.DecodeString(cl.C)
	if err != nil {
		return fmt.Errorf("decrypt: wrong passphrase or corrupted file")
	}
	plain, err := cr.gcm.Open(nil, chunkNonce(cr.nonce0, cr.counter), ct, chunkAAD("chunk", cr.counter))
	if err != nil {
		return fmt.Errorf("decrypt: wrong passphrase or corrupted file")
	}
	cr.buf = plain
	return nil
}
