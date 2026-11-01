package files

import (
	shared "codecombo/server/api/shared"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"codecombo/server/filepolicy"
	"codecombo/server/fsattr"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// contentHash 内容字节流的 sha256 hex（与 ReadFile ETag 的 %x 摘要同源同形）。
// 用途：编辑器保存冲突检测——前端打开文件时记录响应带回的 hash（baseHash），
// 保存时随请求回传，WriteFile 与磁盘当前内容比对，不一致即 409，
// 防止陈旧内存内容静默覆盖 agent/其他会话在保存间隙写入的磁盘内容
func contentHash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// GetFilePolicy GET /api/projects/:id/file-policy?path=
// 返回该文件的呈现策略（text 全文 / too-large 元信息卡+部分预览 / binary 元信息卡）。
// 前端打开文件前先查此端点（一次 stat，代价极小），再决定是否拉取全文。
// 防护与下载端点同标准（safeJoinProject：拒绝 .. 段 → Abs 规范化 →
// 真实路径「根+分隔符」前缀校验，兄弟目录伪装与符号链接外逃均被拦截）
//
// .editorconfig（P-20261003-95）：项目根存在 .editorconfig 时响应增量带
// editorconfig 字段（该文件的生效缩进约定子集）——编辑器打开链本就先查策略，
// 约定随同一响应下发零新增请求；无配置时无该键，前端回落全局设置零变化
func GetFilePolicy(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	filePath := c.Query("path")
	if filePath == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return
	}
	absPath, err := SafeJoinProject(p.Path, filePath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	if info.IsDir() {
		shared.Error(c, http.StatusBadRequest, "path is a directory", nil)
		return
	}

	ext := filepolicy.ExtOf(absPath)
	hasNUL := false
	if filepolicy.NeedsSniff(ext) {
		if nul, e := filepolicy.SniffHasNUL(absPath, filepolicy.SniffMax); e == nil {
			// UTF-16 文本（BOM 声明）合法含 NUL 字节，不得据此判二进制
			hasNUL = nul && !filepolicy.HasUTF16BOM(absPath)
		}
	}
	d := filepolicy.KindFor(ext, info.Size(), hasNUL)
	d.Size = info.Size()
	d.SizeHuman = filepolicy.HumanBytes(info.Size())

	resp := gin.H{"data": d}
	if ec, ok := filepolicy.EditorConfigFor(p.Path, NormalizeRelPath(filePath)); ok {
		resp["editorconfig"] = ec
	}
	c.JSON(http.StatusOK, resp)
}

// ReadFile 读取项目文件内容。
// 策略接入：text → 正常返回（支持 ?maxBytes 部分预览，截断标记 truncated）；
// too-large → 413 携带 policy；binary → 415 携带 policy（正文永不外发）。
// 兼容性：≤10MB 文本文件的响应形态与历史完全一致，既有前端/e2e 不受影响
func ReadFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	filePath := c.Query("path")
	if filePath == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return
	}
	absPath, err := SafeJoinProject(p.Path, filePath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	if info.IsDir() {
		shared.Error(c, http.StatusBadRequest, "path is a directory", nil)
		return
	}

	ext := filepolicy.ExtOf(absPath)
	hasNUL := false
	if filepolicy.NeedsSniff(ext) {
		if nul, e := filepolicy.SniffHasNUL(absPath, filepolicy.SniffMax); e == nil {
			// UTF-16 文本（BOM 声明）合法含 NUL 字节，不得据此判二进制
			hasNUL = nul && !filepolicy.HasUTF16BOM(absPath)
		}
	}
	d := filepolicy.KindFor(ext, info.Size(), hasNUL)
	if d.Kind == filepolicy.KindTooLarge {
		shared.JSONWithCode(c, shared.CodeFilesFileTooLarge, gin.H{"error": "file too large to preview", "policy": d})
		return
	}
	if d.Kind == filepolicy.KindBinary {
		shared.JSONWithCode(c, shared.CodeFilesBinaryNotPreviewable, gin.H{"error": "binary file not previewable", "policy": d})
		return
	}

	// 可选部分预览：?maxBytes（服务端截到 PartialPreviewLimit），
	// 读头部而非整文件——超大文件的部分预览成本恒定
	maxBytes := int64(0)
	if raw := c.Query("maxBytes"); raw != "" {
		if _, err := fmt.Sscanf(raw, "%d", &maxBytes); err == nil && maxBytes > 0 {
			if maxBytes > filepolicy.PartialPreviewLimit {
				maxBytes = filepolicy.PartialPreviewLimit
			}
		}
	}

	content, truncated, err := filepolicy.ReadHead(absPath, info.Size(), maxBytes)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	// 敏感文件读取审计（P-20261003-315）：内容已从磁盘读出即视为读取达成
	//（304 命中同样确认了客户端持有的敏感内容仍然有效），纯观测不拦截不弹窗，
	// 去重窗口内同会话同路径只记一条——轮询/热重载不刷审计台账
	maybeAuditSensitiveRead(c, p, NormalizeRelPath(filePath))

	// ETag/304：编辑器重开同一文件时（未变更）省掉 3-4× 全量的 JSON 转义与传输。
	// ETag 取内容 hash + 大小（弱比较语义）；If-None-Match 命中直接 304。
	// 摘要与响应体 hash 字段共用一次计算（contentHash 与 ETag 的 %x 同形）
	sumHex := contentHash(content)
	etag := fmt.Sprintf("W/\"%d-%s\"", info.Size(), sumHex)
	c.Header("ETag", etag)
	if match := c.GetHeader("If-None-Match"); match != "" && strings.Contains(match, etag) {
		c.Status(http.StatusNotModified)
		return
	}

	text, encoding := decodeText(content)
	if encoding == "" && truncated && !utf8.ValidString(text) {
		// 部分读取可能截断多字节 UTF-8 字符：替换无效序列保证 JSON 合法
		text = strings.ToValidUTF8(text, "\uFFFD")
	}
	resp := gin.H{"data": text, "path": filePath, "truncated": truncated}
	// 非 UTF-8 文件带上探测标签：前端保存时原样回传，WriteFile 按原编码写回，
	// 避免编辑一次就把 GBK 文件静默转成 UTF-8
	if encoding != "" {
		resp["encoding"] = encoding
	}
	// 全文读取时带回内容 hash：编辑器保存流以此为 baseHash 检测外部改写
	//（部分预览的 hash 只覆盖截断头部，无比对意义，不带）
	if !truncated {
		resp["hash"] = sumHex
	}
	c.JSON(http.StatusOK, resp)
}

// writeFileBodyMaxBytes 写入/新建文件请求体上限：与写入/新建单文件的内容上限对齐，
// 再留 JSON 编码开销余量（转义膨胀 + 结构字段）。content 类端点无上限时
// 超大请求体会整体进内存
const writeFileBodyMaxBytes = int64(32) << 20

// uniqueTmp 生成 per-request 唯一的原子写临时文件路径：
// absPath + ".sc-tmp-" + crypto/rand 8 字节 hex。
// 固定后缀在并发保存同一文件时互踩：A 的 rename 可能把 B 尚未写完的
// tmp 内容抢走落盘，得到两个请求内容交错的半截文件。唯一后缀让每个
// 请求只写自己的 tmp，rename 仍只发生在 tmp → 目标之间，原子语义不变
func uniqueTmp(absPath string) (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return absPath + ".sc-tmp-" + hex.EncodeToString(b[:]), nil
}

// WriteFile 保存文件内容
func WriteFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	shared.LimitBody(c, writeFileBodyMaxBytes)

	var req struct {
		Path     string `json:"path"`
		Content  string `json:"content"`
		Encoding string `json:"encoding,omitempty"` // "gbk" = 按探测到的原编码写回；空 = UTF-8
		// BaseHash 调用方打开文件时记录的磁盘内容 hash（ReadFile 响应的 hash 字段）。
		// 非空时与磁盘当前内容比对：不一致 → 409 携带 currentContent，
		// 防止陈旧内存内容静默覆盖外部（agent/其他会话）写入。空 = 直写（兼容旧调用方）
		BaseHash string `json:"baseHash,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.ErrorWithCode(c, shared.CodeFilesPayloadTooLarge, "File operation failed",
				fmt.Errorf("request body too large (max %d bytes)", writeFileBodyMaxBytes))
			return
		}
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}

	if req.Path == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return
	}

	// 路径边界：与下载端点同标准（兄弟目录前缀伪装 + 符号链接外逃均拦截）
	absPath, err := SafeJoinProject(p.Path, req.Path)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}

	// 敏感写入路径闸（P-20261005-235）：相对路径命中窄表（.git/hooks、
	// .git/config、.ssh 等）时 agent 令牌走高危审批（428），未命中照常零打扰。
	// 放在边界校验之后（匹配用归一相对路径）、任何落盘之前（428 = 零副作用）
	if !middleware.GuardSensitiveWritePath(c, NormalizeRelPath(req.Path)) {
		return
	}

	// 保存冲突检测：调用方声明了打开时的磁盘 hash，与当前磁盘内容不符即拒写，
	// 让前端给出覆盖/加载磁盘/对比三选，而不是静默覆盖外部修改。文件已被
	// 删除（无内容可覆盖）或读取失败时跳过检测直写——覆盖保存本就是用户
	// 显式意图，重建文件无数据可丢
	if req.BaseHash != "" {
		if cur, err := os.ReadFile(absPath); err == nil && contentHash(cur) != req.BaseHash {
			curText, _ := decodeText(cur)
			shared.JSONWithCode(c, shared.CodeFilesConflict, gin.H{
				"error":          "file was modified externally since it was opened",
				"currentContent": curText,
			})
			return
		}
	}

	// 非默认编码按原编码落盘（未知编码值按 UTF-8 处理，保持向后兼容）
	data, err := encodeText(req.Content, req.Encoding)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}

	// 本地历史快照（P-20261002-130）：覆盖前把磁盘旧内容留档（agent 改坏/
	// 误覆盖的后悔药）。放在全部拒写分支之后——409/400 拒绝的请求无覆盖发生
	// 不留档；留档失败仅记日志，绝不阻塞保存
	snapshotForHistory(p.ID, NormalizeRelPath(req.Path), absPath)

	// 原子写：tmp + rename（与 filestore 同模式）。直接覆盖写在写入中途
	// 崩溃/断电时留下半截文件，对编辑器保存场景是不可逆的内容损失
	// 归因账 API 写预打标（P-20261005-170）：编辑器保存是「归因编辑器」的
	// 主链路——上轮只在 create/upload/rename/delete 四端点打标，主保存端点
	// 漏标致保存事件全落「未归因」（e2e 实败①的根因）
	fsattr.NoteAPIWrite(absPath)
	if err := atomicWriteFile(absPath, data); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	// 回传写入内容的 hash：前端以此刷新 baseHash，下次保存继续比对
	//（若只回 message，前端需要再发一次读请求才能拿到新基线）
	c.JSON(http.StatusOK, gin.H{"message": "file saved", "hash": contentHash(data)})
}

// CreateFile 创建新文件
func CreateFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	shared.LimitBody(c, writeFileBodyMaxBytes)

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.ErrorWithCode(c, shared.CodeFilesPayloadTooLarge, "File operation failed",
				fmt.Errorf("request body too large (max %d bytes)", writeFileBodyMaxBytes))
			return
		}
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}

	if req.Path == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return
	}

	absPath, err := SafeJoinProject(p.Path, req.Path)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}

	// 敏感写入路径闸（P-20261005-235）：新建文件与保存同防（.git/hooks/xxx
	// 首次落地正是钩子投毒的主要路径）。428 = 未写盘零副作用
	if !middleware.GuardSensitiveWritePath(c, NormalizeRelPath(req.Path)) {
		return
	}

	// 文件名跨平台兼容性（P-20261002-132）：Windows 保留设备名/结尾点空格的
	// 段在创建入口拒绝（MkdirAll 会连带创建父目录，故全路径逐段校验），
	// 杜绝 Linux 宿主创建成功、Windows 宿主检出即坏的跨端地雷
	if err := validateNameCompat(req.Path); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNameInvalid, err.Error(), nil)
		return
	}

	// 确保父目录存在
	dir := filepath.Dir(absPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	// 检查文件是否已存在
	if _, err := os.Stat(absPath); err == nil {
		shared.ErrorWithCode(c, shared.CodeFilesConflict, "file already exists", nil)
		return
	}

	// 自环标记（P-20261005-15）：直写口不经 atomicWriteFile，标记独立补上
	markSelfWrite(absPath)
	// 归因账 API 写预打标（P-20261005-170）：CreateFile 直写不走 atomicWriteFile
	fsattr.NoteAPIWrite(absPath)
	if err := os.WriteFile(absPath, []byte(req.Content), 0644); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "file created"})
}

// UploadFiles 上传文件（支持多文件，目标目录由 query 参数 dest 指定）
func UploadFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	dest := c.Query("dest")
	// 同名覆盖开关（P-20261003-230）：缺省跳过同名目标（安全侧）；?overwrite=1
	// 是用户在前端同名确认框显式选「覆盖」后的放行档。query 参数形态与
	// dir-archive 的 override=1 先例一致；历史行为是对同名目标静默替换
	// （rename 原生语义），现收口为「默认跳过 + 显式覆盖」二元
	overwrite := c.Query("overwrite") == "1"
	// 目标目录边界：与下载端点同标准；dest 为空 = 项目根本身
	absDest, err := SafeJoinProject(p.Path, dest)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}

	// 敏感写入路径闸（P-20261005-235）第一跳：目标目录自身命中窄表（如
	// dest=.ssh / dest=.git/hooks）在 MkdirAll 之前拦截——建目录也是写入面，
	// 428 语义必须零副作用（定向 e2e 实测抓到：MkdirAll 先行会留下空目录）。
	// dest 为空（项目根）归一为空串不命中，照常放行
	if !middleware.GuardSensitiveWritePath(c, NormalizeRelPath(dest)) {
		return
	}

	form, err := c.MultipartForm()
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "multipart form required: failed", err)
		return
	}
	files := form.File["files"]
	if len(files) == 0 {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "no files", nil)
		return
	}
	// 子路径相对名（P-20261023-2）：multipart filename 按 RFC 7578 §4.2 被 Go
	// 解析层剥成 basename，目录拖入的相对路径经旁挂 form 字段 paths（JSON 字符串
	// 数组，与 files 逐序对齐）携带。字段缺省 = 旧调用方，回落 filename 语义零
	// 变化；字段在而长度失配 = 新调用方 bug，400 显式拒绝——静默忽略会把子路径
	// 文件错落进 dest 根，比拒绝更糟
	relPaths, relPathsBad := uploadRelPaths(form.Value["paths"], len(files))
	if relPathsBad {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "paths must be a JSON array aligned with files", nil)
		return
	}
	// 逐文件名解析：旁挂 paths 优先（目录拖入通道），缺省回落 multipart filename
	resolveUploadName := func(i int, filename string) string {
		if relPaths != nil {
			return sanitizeUploadRelPath(relPaths[i])
		}
		return sanitizeUploadRelPath(filename)
	}

	// 敏感写入路径闸（P-20261005-235）第二跳：逐文件窄表预检（覆盖 dest 宽松
	// 而目标文件名落敏感位置的形态，如 dest=.git + 文件 config），首个命中即走
	// 审批（428 放在任一文件落盘之前——半批已写的状态不可接受）。审批卡 op 记
	// 首个命中路径；放行后整批照常（多敏感目标批次的精确逐文件审批需多次往返，
	// MVP 取整批一次卡，命中模式见审批卡 Detail）
	for i, fh := range files {
		name := resolveUploadName(i, fh.Filename)
		if name == "" {
			continue // 非法名落下方主循环 skipped 管道，不参与闸判定
		}
		rel := NormalizeRelPath(path.Join(dest, name))
		if !middleware.IsSensitiveWritePath(rel) {
			continue
		}
		if !middleware.GuardSensitiveWritePath(c, rel) {
			return
		}
		break // 一次审批管整个请求：放行后不再重复建卡
	}

	// MkdirAll 置于两道闸之后：无效 multipart / 命中窄表的请求均不在磁盘上
	// 留下目录痕迹（428 = 零副作用）
	if err := os.MkdirAll(absDest, 0755); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	// 限制单文件 10GB、总上传 10GB（大模型产物/数据集等大文件场景）
	const maxPer = int64(10) * 1024 * 1024 * 1024
	const maxTotal = int64(10) * 1024 * 1024 * 1024
	total := int64(0)
	saved := make([]string, 0, len(files))
	skipped := make([]map[string]string, 0)
	for i, fh := range files {
		if fh.Size > maxPer {
			skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": "file too large (max 10GB)"})
			continue
		}
		total += fh.Size
		if total > maxTotal {
			skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": "total upload size exceeded"})
			break
		}
		// 清洗文件名：反斜杠归一 + 剥浏览器假路径前缀 + 穿越段拒绝（P-20261023-2
		// 起支持子路径形态——相对路径经旁挂 paths 字段携带，见 resolveUploadName；
		// 单段名与既有 basename 语义一致，历史调用方零变化）
		cleanName := resolveUploadName(i, fh.Filename)
		if cleanName == "" {
			skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": "invalid filename"})
			continue
		}
		// 子路径形态的跨平台名校验（P-132）：MkdirAll 连带建父目录，故全路径
		// 逐段校验（CreateFile/CreateDir 同位）——杜绝 Linux 宿主建出 Windows
		// 检出即坏的保留设备名/结尾点段目录。单段名不追溯收紧（既有语义零变化）
		if strings.Contains(cleanName, "/") {
			if err := validateNameCompat(NormalizeRelPath(path.Join(dest, cleanName))); err != nil {
				skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": err.Error()})
				continue
			}
		}
		target := filepath.Join(absDest, filepath.FromSlash(cleanName))
		// 子路径：先按段建齐 dest 下的父目录（dest 本体已在循环前 MkdirAll；
		// 置于两道敏感闸之后——428 零副作用语义不受影响）
		if strings.Contains(cleanName, "/") {
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": err.Error()})
				continue
			}
		}
		// 同名防护（P-20261003-230）：默认档命中既有目标（含同名目录——文件
		// 落不上目录名，后续 rename 亦必败，提前以稳定原因跳过）即跳过，原因
		// 与 CreateFile/RenameFile 冲突同串「file already exists」（既有识别
		// 口径）。大小写差异等本端清单对不齐的形态由 os.Stat 按宿主文件系统
		// 真实语义兜底——前端只做发现面，服务端是唯一权威
		if _, err := os.Stat(target); err == nil && !overwrite {
			skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": "file already exists"})
			continue
		}
		// 覆盖档先留档旧内容（P-130 本地历史，与 WriteFile/RenameFile 同钩子）：
		// 覆盖上传正是「改了本地文件想更新目录副本」的误覆盖高发场景；目录/
		// 超限/二进制/目标缺失由 snapshotForHistory 内部甄别跳过，留档失败
		// 仅记日志绝不阻塞上传
		if overwrite {
			snapshotForHistory(p.ID, NormalizeRelPath(path.Join(dest, cleanName)), target)
		}
		// 原子写（P-20261004-10，与 WriteFile 的 P-104 同语义）：先存邻位唯一
		// tmp 再 rename 到 target。直写 target 三患俱全——并发上传同名内容交错、
		// 读端可见半截内容、中断留截断文件；rename 是唯一替换入口，目标要么是
		// 旧完整版要么是新完整版。tmp 失败与 rename 失败同走 skipped（附 tmp
		// 清理），响应形状与既有的「失败即跳过」语义不变
		// 归因账 API 写预打标（P-20261005-170）：上传替换与编辑器保存同族
		fsattr.NoteAPIWrite(target)
		tmp, err := uniqueTmp(target)
		if err != nil {
			skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": err.Error()})
			continue
		}
		// tmp 路径同标（P-20261005-15）：SaveUploadedFile 落盘先于 rename，tmp 名
		//（target.sc-tmp-*）保留敏感前缀照样命中观测模式，不标即假阳性外部写
		markSelfWrite(tmp)
		if err := c.SaveUploadedFile(fh, tmp); err != nil {
			_ = os.Remove(tmp)
			skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": err.Error()})
			continue
		}
		markSelfWrite(target) // 自环标记（P-20261005-15）：上传覆盖口独立补标
		if err := os.Rename(tmp, target); err != nil {
			_ = os.Remove(tmp)
			skipped = append(skipped, map[string]string{"name": fh.Filename, "reason": err.Error()})
			continue
		}
		saved = append(saved, cleanName)
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "upload done",
		"saved":   saved,
		"skipped": skipped,
		"dest":    dest,
	})
}

// mustAbsRoot 项目根绝对路径（Abs 失败时原样返回；safeJoinProject 的
// 前缀校验各自内部也会再 Abs，这里仅用于根相等性判断）
func mustAbsRoot(root string) string {
	abs, err := filepath.Abs(root)
	if err != nil {
		return root
	}
	return abs
}

// uploadRelPaths 解析旁挂 paths 字段（multipart form value，JSON 字符串数组，
// 与 files 逐序对齐的相对名——目录拖入通道）。返回 nil 表示无旁挂名（缺省/
// 形状异常不一致时按缺省处理）；bad=true 表示字段在而长度失配（调用方 400）。
// 单字段多值取首值（multipart 同名字段重复是调用方 bug，不做拼合猜测）
func uploadRelPaths(raw []string, n int) (paths []string, bad bool) {
	if len(raw) == 0 || raw[0] == "" {
		return nil, false
	}
	var arr []string
	if json.Unmarshal([]byte(raw[0]), &arr) != nil {
		return nil, true
	}
	if len(arr) != n {
		return nil, true
	}
	return arr, false
}

// sanitizeUploadRelPath 上传文件名清洗（P-20261023-2 起支持子路径形态）：返回
// 项目内相对叶子路径（可含 / 子路径段）或空串（非法，调用方按 invalid filename
// 跳过）。子路径服务目录拖入（前端 webkitGetAsEntry 递归枚举展平为相对路径），
// 路径穿越复检在清洗层收口：
//   - 反斜杠归一为 /（Windows 客户端全路径/子路径形态同源处理）；
//   - 剥浏览器假路径前缀 x:/fakepath/（HTML5 规范对 input 上传的固定伪装段，
//     剥后与既有 basename 语义一致）；
//   - 逐段过滤空段与 . 段；.. 段整体拒绝；子路径形态（多段）下含 : 段
//     （盘符/NTFS 数据流）拒绝——单段名不追溯收紧（含冒号文件名在 Linux/mac
//     宿主合法，Windows 写入失败由 OS 自身语义兜底），保持既有 basename 语义；
//   - 无名 part / 全部段被滤空：回落 upload.bin（既有兜底语义不变）。
func sanitizeUploadRelPath(name string) string {
	if name == "" {
		return "upload.bin"
	}
	name = strings.ReplaceAll(name, "\\", "/")
	const fakepath = ":/fakepath/"
	if idx := strings.LastIndex(strings.ToLower(name), fakepath); idx >= 0 {
		name = name[idx+len(fakepath):]
	}
	segs := strings.Split(name, "/")
	out := make([]string, 0, len(segs))
	for _, s := range segs {
		if s == "" || s == "." {
			continue
		}
		if s == ".." {
			return ""
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return "upload.bin"
	}
	if len(out) > 1 {
		for _, s := range out {
			if strings.Contains(s, ":") {
				return ""
			}
		}
	}
	return strings.Join(out, "/")
}

// CreateDir 创建新目录
func CreateDir(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}

	if req.Path == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return
	}

	absPath, err := SafeJoinProject(p.Path, req.Path)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}

	// 敏感写入路径闸（P-20261005-235）：建目录同防（`.git/hooks`、`.ssh`
	// 目录自身即窄表命中——`**` 吞零段），先立敏感目录再投文件的分步投毒
	// 在第一步即被拦
	if !middleware.GuardSensitiveWritePath(c, NormalizeRelPath(req.Path)) {
		return
	}

	// 文件名跨平台兼容性（P-20261002-132）：同 CreateFile（MkdirAll 全路径逐段校验）
	if err := validateNameCompat(req.Path); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNameInvalid, err.Error(), nil)
		return
	}

	if err := os.MkdirAll(absPath, 0755); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	c.JSON(http.StatusCreated, gin.H{"message": "directory created"})
}

// renameTargetCovered 目标存在且非源自身（覆盖他文件/目录 → 409 拦截）。
// os.SameFile 判等：同名自身重命名幂等放行（os.Rename 同路径两平台均原生
// 成功，P-13 成功入账语义不变）；Windows 大小写不敏感文件系统上大小写改名
// （a.txt→A.txt）stat 得同一文件，同此放行由 os.Rename 真正落盘新大小写
func renameTargetCovered(newAbsPath, oldAbsPath string) bool {
	newInfo, err := os.Stat(newAbsPath)
	if err != nil {
		return false // 目标不存在：正常放行
	}
	srcInfo, err := os.Stat(oldAbsPath)
	return err != nil || !os.SameFile(newInfo, srcInfo)
}

// RenameFile 重命名文件或目录
func RenameFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}

	if req.OldPath == "" || req.NewPath == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "oldPath and newPath are required", nil)
		return
	}

	oldAbsPath, err := SafeJoinProject(p.Path, req.OldPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, "invalid old path", nil)
		return
	}

	newAbsPath, err := SafeJoinProject(p.Path, req.NewPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, "invalid new path", nil)
		return
	}

	// 敏感写入路径闸（P-20261005-235）：守写目标 newPath——把内容挪进敏感位置
	// （如把脚本改名进 .git/hooks 提交即执行）与直写同防；源路径不设闸（挪出
	// 敏感位置不是写入面）
	if !middleware.GuardSensitiveWritePath(c, NormalizeRelPath(req.NewPath)) {
		return
	}

	// 文件名跨平台兼容性（P-20261002-132）：只校验新名（旧名已存在，改名离开
	// 地雷名应放行）。目标存在防护（P-117）在其后：无效名比「已存在」更早失败，
	// 错误口径互不重叠（invalid file name vs file already exists）
	if err := validateNameCompat(req.NewPath); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNameInvalid, err.Error(), nil)
		return
	}
	// 本地历史快照（P-20261002-130）：重命名把内容从旧路径挪走前，把旧内容
	// 留档在旧路径名下——恢复该版本会写回旧路径，重命名反悔时可原位找回。
	// 目录与二进制不适用（snapshotForHistory 内部甄别）；留档失败仅记日志
	snapshotForHistory(p.ID, NormalizeRelPath(req.OldPath), oldAbsPath)

	// 归因账 API 写预打标（P-20261005-170）：改名两端都标——旧路径收到 remove/
	// rename 事件、新路径收到 create/rename 事件，同属本次编辑器侧动作
	fsattr.NoteAPIWrite(oldAbsPath)
	fsattr.NoteAPIWrite(newAbsPath)

	// 目标存在防护：Linux os.Rename 对已存在目标静默覆盖（重命名的数据丢失
	// 边界），Windows 原生报错——跨平台行为归一为显式 409。错误原文与
	// CreateFile 同串「file already exists」：前端已知错误映射
	// （errors.known.fileExists）与行内重命名红提示共用该识别口径
	if renameTargetCovered(newAbsPath, oldAbsPath) {
		shared.ErrorWithCode(c, shared.CodeFilesConflict, "file already exists", nil)
		return
	}

	// 自环标记（P-20261005-15）：rename 事件落在目标路径（Linux MOVED_TO /
	// Windows FILE_ACTION_RENAMED 均为 Create 语义），标新路径即够；旧路径的
	// Remove 事件本就不在观测范围
	markSelfWrite(newAbsPath)
	if err := os.Rename(oldAbsPath, newAbsPath); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	// 审计入账：重命名改变文件可达路径（只记项目与相对路径，不记文件内容）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileRename,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s → %s", p.Name, req.OldPath, req.NewPath),
	})

	c.JSON(http.StatusOK, gin.H{"message": "renamed"})
}

// DeleteFile 删除文件或目录（删除即入回收站，P-20261003-304）
func DeleteFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}

	if req.Path == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return
	}

	absPath, err := SafeJoinProject(p.Path, req.Path)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, "invalid path", nil)
		return
	}

	// 不允许删除项目根目录
	if absPath == mustAbsRoot(p.Path) {
		shared.Error(c, http.StatusForbidden, "cannot delete project root", nil)
		return
	}

	// 归因账 API 写预打标（P-20261005-170）：删除 = 挪入回收站，原路径将收到
	// remove/rename 事件，归「编辑器」而非未归因
	fsattr.NoteAPIWrite(absPath)

	// 删除前入回收站（P-20261003-304）：挪入失败即拒绝删除——回收站是删除的
	// 前置机制而非旁路快照，静默退回不可逆直删正是本提案要消灭的形态；挪入
	// 成功后项目内必无该路径（movePath 的 rename/copy+RemoveAll 双分支保证）
	if _, err := moveToTrash(p.ID, p.Path, req.Path, absPath); err != nil {
		if os.IsNotExist(err) {
			// 目标不存在：与 os.RemoveAll 对不存在路径的原语义对齐（幂等成功）
			c.JSON(http.StatusOK, gin.H{"message": "deleted"})
			return
		}
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	// 审计入账：只记项目与相对路径，不记文件内容（内容本体在回收站，7 天内
	// 可经 /trash 列表恢复）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileDelete,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s", p.Name, req.Path),
	})

	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}
