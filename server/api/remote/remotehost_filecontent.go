package remote

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"

	shared "codecombo/server/api/shared"
	"codecombo/server/filepolicy"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 远程文件编辑器读写（VS Code Remote 式） ==============
//
// GET /api/remotehosts/:id/files/content?path= 读文本全文进编辑器；
// PUT 同路径把编辑器内容原子回写远端。与文件管理（remotehost_files.go）共用
// fileClient 通道抽象，但只面向 SSH(SFTP) 主机——FTP 无「同目录临时文件 +
// 原子换名 + 权限保留」的对称实现，明文协议也不适合承载配置编辑面，入口即拒。
//
// 与本地编辑器（server/api/files）同语义对齐：
//   - 二进制/超大文件不进编辑器（415/413，判定复用 filepolicy 同一套大脑）
//   - 响应带内容 sha256（hash 字段），保存时作 baseHash 回传做冲突检测，
//     不一致 409（409 语义与本地 WriteFile 一致：防陈旧内存内容静默覆盖
//     远端侧 agent/其他会话的写入）
//
// 写路径原子性：内容先落同目录隐藏临时文件（同目录保证同文件系统，rename
// 原子），SFTP chmod 保留原权限位后 PosixRename 原子换名覆盖；服务端不支持
// posix-rename 扩展时降级直写（与既有上传通道同语义，不比现状差）。
// 远端路径全程走 SFTP 线协议直传，无 shell 拼接面，特殊字符（空格/引号/$/
// Unicode）天然安全——单测以 fake 通道覆盖特殊字符路径端到端。

const (
	// filesContentMaxBytes 编辑器读写单文件上限。远端文件经 SSH 全量进内存 +
	// JSON 编码，取比本地 TextPreviewLimit(10MB) 紧的 2MB 档；更大的配置类
	// 文本罕见，真有大文件走下载/终端链路
	filesContentMaxBytes = int64(2) << 20
	// filesContentBodyMaxBytes PUT 请求体上限：内容 base64 膨胀 4/3 + JSON
	// 编码开销 + 结构字段余量
	filesContentBodyMaxBytes = int64(8) << 20
	// errRemoteFileModified 409 冲突稳定原文（对外契约：前端按 status 409
	// 分流三选对话框，原文仅留诊断）
	errRemoteFileModified = "remote file was modified externally since it was opened"
)

// contentHash 内容字节流的 sha256 hex——与 files.ReadFile 的 ETag/hash 同源
// 同形（两包各自小实现，避免 remote → files 的反向依赖）
func contentHash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// readLimited 有界读取：最多 max+1 字节，超出即返回 truncated（调用方据此
// 413/跳过冲突检测），防远端文件在 Stat 与读取之间膨胀击穿内存预算
func readLimited(r io.Reader, max int64) (data []byte, truncated bool, err error) {
	data, err = io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(data)) > max {
		return data[:max], true, nil
	}
	return data, false, nil
}

// sniffHasNUL 前 sniffMax 字节是否含 NUL（二进制探测，与 filepolicy.SniffHasNUL
// 同判据；bytes 版供远端流使用——那边没有本地文件路径可 stat）
func sniffHasNUL(data []byte, sniffMax int64) bool {
	head := data
	if int64(len(head)) > sniffMax {
		head = head[:sniffMax]
	}
	for _, b := range head {
		if b == 0 {
			return true
		}
	}
	return false
}

// hasUTF16BOM bytes 版 UTF-16 BOM 探测（本地 ReadFile 的 HasUTF16BOM 同语义）：
// UTF-16 文本合法含 NUL 字节，不得据此判二进制
func hasUTF16BOM(data []byte) bool {
	return len(data) >= 2 && ((data[0] == 0xFF && data[1] == 0xFE) || (data[0] == 0xFE && data[1] == 0xFF))
}

// dialEditClient 编辑器读写通道解析：主机解析 → FTP 拒入 → 拨号。
// 返回 true 表示已写错误响应，调用方直接 return
func dialEditClient(c *gin.Context) (fileClient, bool) {
	rh, err := store.Get().RemoteHost.Get(c.Param("id"))
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return nil, true
	}
	if rh.IsFTP() {
		shared.Error(c, http.StatusBadRequest,
			"FTP host does not support editor content read/write", nil)
		return nil, true
	}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		dialFileErr(c, err)
		return nil, true
	}
	fc, err := dialFileClient(rh)
	if err != nil {
		dialFileErr(c, err)
		return nil, true
	}
	return fc, false
}

// ReadRemoteFileContent GET /api/remotehosts/:id/files/content?path=
// 全文读文本（utf-8/gbk/utf-16 探测解码同本地 ReadFile），二进制 415、
// 超上限 413；hash 字段供编辑器保存冲突检测
func ReadRemoteFileContent(c *gin.Context) {
	p := c.Query("path")
	if err := validateRemotePath(p); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", err)
		return
	}
	fc, done := dialEditClient(c)
	if done {
		return
	}
	defer fc.Close()
	readRemoteContentHandler(c, fc, p)
}

// readRemoteContentHandler 读取主流程（fc 参数化：单测以 fake 通道直驱，不经真实 SSH）
func readRemoteContentHandler(c *gin.Context, fc fileClient, p string) {
	size, isDir, err := fc.Stat(p)
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "remote stat failed", err)
		return
	}
	if isDir {
		shared.Error(c, http.StatusBadRequest, "path is a directory", nil)
		return
	}
	if size > filesContentMaxBytes {
		// 结构化错误体（本地 ReadFile 413 同形）：正文永不外发，附 policy 元信息
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{
			"error": "remote file too large to edit",
			"policy": gin.H{
				"kind": filepolicy.KindTooLarge, "size": size,
				"sizeHuman": filepolicy.HumanBytes(size), "limit": filesContentMaxBytes,
			},
		})
		return
	}

	f, err := fc.Open(p)
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "remote open failed", err)
		return
	}
	defer f.Close()
	raw, truncated, err := readLimited(f, filesContentMaxBytes)
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "remote read failed", err)
		return
	}
	if truncated {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{
			"error": "remote file too large to edit",
			"policy": gin.H{
				"kind": filepolicy.KindTooLarge, "size": size,
				"sizeHuman": filepolicy.HumanBytes(size), "limit": filesContentMaxBytes,
			},
		})
		return
	}

	// 呈现判定与本地 ReadFile 同一套大脑：扩展名二进制 / NUL 嗅探（UTF-16 BOM
	// 豁免）→ 415，正文永不外发
	ext := filepolicy.ExtOf(p)
	hasNUL := sniffHasNUL(raw, filepolicy.SniffMax) && !hasUTF16BOM(raw)
	d := filepolicy.KindFor(ext, size, hasNUL)
	if d.Kind == filepolicy.KindBinary {
		d.Size = size
		d.SizeHuman = filepolicy.HumanBytes(size)
		c.JSON(http.StatusUnsupportedMediaType, gin.H{
			"error": "binary file not editable", "policy": d,
		})
		return
	}

	text, encoding := filepolicy.DecodeText(raw)
	resp := gin.H{"data": text, "path": p, "hash": contentHash(raw)}
	if encoding != "" {
		resp["encoding"] = encoding
	}
	// 读成功 = 连接认证通过：主机状态点升级为绿（与列目录同语义）
	MarkAuthOK(c.Param("id"))
	c.JSON(http.StatusOK, resp)
}

// writeContentRequest PUT /files/content 请求体。Content 为编辑器 UTF-8 文本
// 的 base64（不经 JSON 转义直传字节）；Encoding 语义同本地 WriteFile——按
// 打开时探测的原编码落盘；BaseHash 语义同本地 WriteFile——打开时内容 hash，
// 非空且与远端当前内容不符即 409
type writeContentRequest struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding,omitempty"`
	BaseHash string `json:"baseHash,omitempty"`
}

// WriteRemoteFileContent PUT /api/remotehosts/:id/files/content
// base64 解码 → 同目录临时文件 → 权限保留 → 原子换名覆盖；baseHash 冲突 409
func WriteRemoteFileContent(c *gin.Context) {
	shared.LimitBody(c, filesContentBodyMaxBytes)
	var req writeContentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "request body too large", err)
			return
		}
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if err := validateRemotePath(req.Path); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", err)
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.Content)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "content must be base64", err)
		return
	}
	if int64(len(raw)) > filesContentMaxBytes {
		shared.Error(c, http.StatusRequestEntityTooLarge, "remote file too large to save", nil)
		return
	}

	fc, done := dialEditClient(c)
	if done {
		return
	}
	defer fc.Close()

	writeRemoteContentHandler(c, fc, req.Path, raw, req.Encoding, req.BaseHash)
}

// tmpPathFor 同目录隐藏临时文件路径：同目录保证 rename 不跨文件系统（原子
// 前提）；crypto/rand 8 字节防并发保存互踩（本地 uniqueTmp 同款）
func tmpPathFor(p string) string {
	var randBuf [8]byte
	if _, err := rand.Read(randBuf[:]); err != nil {
		// 系统熵源不可用属极端环境：退化固定名仍可写（并发保存同文件互踩
		// 概率回归既有直写通道水平，不因降级拒绝保存）
		randBuf = [8]byte{}
	}
	return path.Join(path.Dir(p), fmt.Sprintf(".sc-tmp-%s-%s", hex.EncodeToString(randBuf[:]), path.Base(p)))
}

// writeRemoteContentHandler 写入主流程（fc 参数化：单测以 fake 通道直驱，
// 不经真实 SSH）。content 为编辑器 UTF-8 文本字节：非默认 encoding 按原编码
// 落盘（与本地 WriteFile 回写链路同语义——GBK 文件编辑一次不被静默转成
// UTF-8）。写入成功回传新内容 hash 作下次冲突检测基线，并入审计
func writeRemoteContentHandler(c *gin.Context, fc fileClient, p string, content []byte, encoding, baseHash string) {
	data := content
	if encoding != "" {
		encoded, err := filepolicy.EncodeText(string(content), encoding)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid encoding", err)
			return
		}
		data = encoded
	}
	if int64(len(data)) > filesContentMaxBytes {
		shared.Error(c, http.StatusRequestEntityTooLarge, "remote file too large to save", nil)
		return
	}
	// 冲突检测：调用方声明了打开时内容 hash，与远端当前不符即拒写（409 携
	// currentContent，语义对齐本地 WriteFile）。远端文件已删除/读取失败/超上限
	// 时跳过检测直写——覆盖保存本就是用户显式意图，重建文件无数据可丢；
	// 超上限跳过是因截断 hash 会误判
	if baseHash != "" {
		if cur, isDir, err := statReadAll(fc, p); err == nil && !isDir && cur != nil {
			if contentHash(cur) != baseHash {
				curText, _ := filepolicy.DecodeText(cur)
				c.JSON(http.StatusConflict, gin.H{
					"error":          errRemoteFileModified,
					"currentContent": curText,
				})
				return
			}
		}
	}

	// 原权限位先行（目标可能不存在：新建语义落默认 0644）——临时文件按它
	// chmod 后再换名，权限位全程不丢（对齐提案 chmod --reference 意图，
	// SFTP 原语直达，免 shell 转义面）
	perms := os.FileMode(0644)
	if m, err := fc.Mode(p); err == nil && m != 0 {
		perms = m
	}

	// 同目录隐藏临时文件（tmpPathFor：同文件系统 rename 原子 + 随机段防互踩）
	tmpPath := tmpPathFor(p)

	if err := fc.Upload(bytes.NewReader(data), tmpPath); err != nil {
		shared.Error(c, http.StatusBadGateway, "remote save failed", err)
		return
	}
	if err := fc.Chmod(tmpPath, perms); err != nil {
		_ = fc.RemoveAll(tmpPath)
		shared.Error(c, http.StatusBadGateway, "remote save failed", err)
		return
	}
	if err := fc.Rename(tmpPath, p); err != nil {
		// posix-rename 不被支持且目标已存在的服务端：降级直写覆盖（与既有
		// 上传通道同语义，不比现状差）；tmp 无论如何不留远端垃圾
		if upErr := fc.Upload(bytes.NewReader(data), p); upErr != nil {
			_ = fc.RemoveAll(tmpPath)
			shared.Error(c, http.StatusBadGateway, "remote save failed", upErr)
			return
		}
		_ = fc.RemoveAll(tmpPath)
	}

	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostFileWrite,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s (%d bytes)", c.Param("id"), p, len(data)),
	})
	MarkAuthOK(c.Param("id"))
	c.JSON(http.StatusOK, gin.H{"message": "remote file saved", "hash": contentHash(data)})
}

// statReadAll 冲突检测用的有界全文读取：目录返回 isDir；超上限返回
// truncated（调用方视为「无法校验」）；文件不存在返回 (nil,false,nil)
func statReadAll(fc fileClient, p string) (data []byte, isDir bool, err error) {
	size, isDir, statErr := fc.Stat(p)
	if statErr != nil {
		return nil, false, nil // 文件已被删除等：调用方跳过检测直写
	}
	if isDir || size > filesContentMaxBytes {
		return nil, isDir, fmt.Errorf("content not verifiable")
	}
	f, err := fc.Open(p)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	raw, truncated, err := readLimited(f, filesContentMaxBytes)
	if err != nil || truncated {
		return nil, false, fmt.Errorf("content read failed")
	}
	return raw, false, nil
}
