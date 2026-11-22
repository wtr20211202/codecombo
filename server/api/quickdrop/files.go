package quickdrop

// 快投递多文件上行（P-20261117-2-S1）：POST /drop/:token 的 multipart 形态
// ——访客拖入/粘贴/多选一把投文件（+可选文本），落盘进车道 2 隔离区
// <DataDir>/artifacts/quickdrop/<token>/（share-drops 兄弟目录），收件箱 doc
// 承载文件元数据行（消费链零改动：「交给当前会话」把文本+目录+文件名写进
// 终端，agent 按目录取件）。
//
// 与 share collab 上行（server/share/drops.go handleGuestDropPost）的关系：
// 校验链模板同款（扩展名白名单 × 大小档 × 单批上限 × 磁盘配额 × 敏感名警示
// × os.Root 落位），原语直接复用（SanitizeDropFileName/DropExtKind/
// WriteDropSidecar/IsSensitiveName/DropMeta/DropSidecarSuffix），但**不**复用
// 其 handler——share 侧深耦合 store.Share（lookup/Collab 门禁/dropNote(sh)/
// dropEvents）。结构差异：
//
//   - 流式直落：2GB 总量配额下 r.ParseMultipartForm(8MB) 的全量缓形与
//     112MB 体闸都不成立——MultipartReader 单遍直落，内存 O(缓冲)；失去
//     fh.Size 预检，配额/单文件闸随拷贝边写边数（quotaBoundedReader），
//     触顶即删残留断 413。
//   - 门禁前置：token Validate 先于任何读体（无效凭据的大体量请求零字节
//     读取即 404，不白吃带宽不落地）——PostDropForm 分流处已前置。
//   - 白名单外/超单文件上限/超单批数的 part：读 filename 即判拒，Copy 至
//     io.Discard 跳过（保连接，后续文件照收）——响应 added[] 以
//     kind=rejected 占位，不搞全批回滚的假原子（drops.go 同契约）。
//   - TTL 单窗：文件与收件箱 doc 同用 store.DropTTL 24h（share 侧的
//     ConsumedAt 消费双窗依赖 ConsumeDrop 语义，快投递无消费面不直搬）。
//
// 响应是 JSON 机器契约（S2 访客页 XHR 消费；S1 期 curl/单测直用）；
// urlencoded 旧表单走 PostDropForm 既有 303 PRG 人面，两形态并存向后兼容。

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 限额体系（用户定向 2GB 总量；单 token 收件配额 2GB × token 单例 = 实例
// 有界上界，滥用面四闸兜底：30/min/IP 路由限流 + 配额 + 24h TTL + 撤销即清）。
// 以包级变量落座而非 const——单测同进程覆写锁小档位验证闸链（生产不改），
// 语义同 const（装配期之后只读）。
var (
	// qdMaxTotalBytes 单 token 收件配额（token 单例 → 全局上界有界）
	qdMaxTotalBytes = int64(2) << 30
	// qdMaxFileBytes 文件档上限（100~200MB 定档区取上沿——10 文件即可吃满
	// 2GB 配额；图片档维持 share.MaxDropImageBytes 10MB 不动）
	qdMaxFileBytes = int64(200) << 20
	// qdMaxBatchFiles 单批上限（10~20 定档区取 20——对齐收件箱 MaxDrops
	// 20 条，一批一 doc 的自然对称）
	qdMaxBatchFiles = 20
	// qdBodyLimit 上传请求体外闸：2GB 配额 + multipart 编码/垃圾 part 余量
	//（io.Discard 排水的白名单外载荷不计配额，体闸是唯一总兜底）
	qdBodyLimit = qdMaxTotalBytes + (64 << 20)
)

const (
	// qdContentField / qdFilesField multipart 字段名（content 与零 JS 表单
	// 的 textarea 同名；files 与 share collab 上行同形——S2 访客页沿用）
	qdContentField = "content"
	qdFilesField   = "files"

	// qdFileBriefMax 文件到达通知 Body 的 rune 上限（名字速览行是短摘要
	// 语义，dropMaxBrief 的多文件放宽档）
	qdFileBriefMax = 240

	// qdSidecarReadLimit sidecar 元数据读取的字节上限（share
	// dropSidecarNameLimit 同值同款——防损坏文件把读取面放大）
	qdSidecarReadLimit = 64 << 10
)

// errQuotaExceeded 配额触顶的拷贝中断信号（quotaBoundedReader 边界探测产出）
var errQuotaExceeded = errors.New("quickdrop quota exceeded")

// qdIDCounter 全局单调收件 id 发号器（纳秒基座 + 撞车即 +1 的纯十进制推进
// ——drops.go 批内发号器的跨请求泛化：全局原子保证并发批次也不撞 id，
// 目录内文件名 = <id>_<净化名> 前缀防同名覆盖）。进程重启回拨时钟的理论
// 撞车面与 drops.go 同口径接受（后果只是同目录残留半成品被覆盖，无穿越面）
var qdIDCounter atomic.Int64

func init() { qdIDCounter.Store(time.Now().UnixNano()) }

func nextQdID() string { return strconv.FormatInt(qdIDCounter.Add(1), 10) }

// ── 落盘区（车道 2） ──

// quickdropFilesRoot 快投递文件隔离区根：<DataDir>/artifacts/quickdrop/
// （share-drops 的兄弟目录——同一 artifacts 约定下的特性子目录）
func quickdropFilesRoot() string {
	return filepath.Join(config.DataDir(), "artifacts", "quickdrop")
}

// qdTokenDirFor 单凭据的收件目录（token 即目录名——scd_ token 是固定结构
// 串，作目录名无穿越面；写盘只发生在 Validate 已验证之后）
func qdTokenDirFor(token string) string {
	return filepath.Join(quickdropFilesRoot(), token)
}

// dirBytes 目录树字节总量（不跟随符号链接；missing 目录 = 0；单条目不可读
// 不阻断——share dirTotalBytes 同口径。直接量测目标目录本身：share 的
// dropDirBytes 把 token 裸名当 skip 参数传给全根 walk（skip 与全路径比较恒
// 不等），量的是整个隔离区而非单目录——快投递配额按目录口径自walk，不循）
func dirBytes(dir string) int64 {
	total := int64(0)
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // 尽力而为的配额估计
		}
		if d.Type()&fs.ModeSymlink != 0 || d.IsDir() {
			return nil
		}
		if fi, ierr := d.Info(); ierr == nil {
			total += fi.Size()
		}
		return nil
	})
	return total
}

// ── 流式 multipart handler（POST /drop/:token multipart 形态） ──

// postDropMultipart 多文件投递（PostDropForm 分流进入；token 门禁已前置）。
// 响应是 JSON 机器契约（S2 访客页 XHR 消费）：
//
//	200 {"data":{"ok":true},"added":[DropMeta...],"warnings":[...]}
//	404 品牌页（HTML）                        凭据无效——分流处前置闸渲染，
//	                                          存在性不可探测口径不变
//	400 {"error":"invalid multipart request"}  multipart 解析/读流失败
//	400 {"error":"content or files required"}  内容与文件全空（文件全被拒
//	                                          时另携 added[]/warnings 逐文件
//	                                          失败位）
//	413 {"error":"too_large"}                  体闸越界 / 文本超 4KB
//	413 {"error":"drop_quota"}                 单 token 配额触顶
//	500 {"error":"internal error"}             落盘/存储故障
//
// added[] 内 kind=rejected 的条目 = 白名单外/超单文件上限/超单批数（id 空
// = 未落盘）——可达的照收、被拒的占位，单文件可重传。
func postDropMultipart(c *gin.Context, token string) {
	st := store.Get() // 调用方（PostDropForm）已判空——防御未来直调
	if st == nil {
		shared.Error(c, http.StatusInternalServerError, "internal error", nil)
		return
	}
	// 外层体闸：先于 MultipartReader 置位——垃圾/超量载荷在读流阶段即断
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, qdBodyLimit)
	mr, err := c.Request.MultipartReader()
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid multipart request", nil)
		return
	}
	dir := qdTokenDirFor(token)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		shared.Error(c, http.StatusInternalServerError, "internal error", err)
		return
	}
	root, rerr := os.OpenRoot(dir)
	if rerr != nil {
		shared.Error(c, http.StatusInternalServerError, "internal error", rerr)
		return
	}
	defer root.Close()

	quotaUsed := dirBytes(dir)
	now := time.Now()
	var text []byte            // content 字段累计（≤4KB，超限整批断）
	var added []share.DropMeta // 逐文件终态（含 rejected 占位——访客页呈现面）
	var warnings []string      // 敏感文件名命中（警示不阻断，处置权在主人）
	var batch []string         // 本批落盘账本（半成品清理的唯一依据——含未完成的当前文件）
	acceptedCount := 0

	// 本批残留清账（断连/超限/配额顶/落盘故障共用——本体与 sidecar 成对删；
	// 目录本身留着，GC 对账兜底）
	cleanup := func() {
		for _, f := range batch {
			_ = root.Remove(f)
			_ = root.Remove(f + share.DropSidecarSuffix)
		}
	}
	// 读流失败分型收口：体闸越界 413 too_large；断连不写响应（无处投递）；
	// 其余 400。恒先清本批残留
	fenceErr := func(err error) {
		cleanup()
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "too_large", nil)
			return
		}
		if c.Request.Context().Err() != nil {
			return
		}
		shared.Error(c, http.StatusBadRequest, "invalid multipart request", nil)
	}

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			fenceErr(err)
			return
		}
		switch {
		case part.FormName() == qdContentField && part.FileName() == "":
			// 文本字段：与文本通道同口径 ≤4KB（字节口径，累计判顶）；
			// 超限整批断——文本是访客显式载荷，静默裁剪不诚实
			data, rerr := io.ReadAll(io.LimitReader(part, int64(store.MaxDropBytes)+1))
			if rerr != nil {
				fenceErr(rerr)
				return
			}
			if len(text)+len(data) > store.MaxDropBytes {
				cleanup()
				shared.Error(c, http.StatusRequestEntityTooLarge, "too_large", nil)
				return
			}
			text = append(text, data...)
		case part.FormName() == qdFilesField && part.FileName() != "":
			name := share.SanitizeDropFileName(part.FileName())
			// 白名单按客户端原始名扩展判（drops.go 同口径——"x.png." 这类
			// 尾点杂名在净化前即拒，不给「双扩展伪装」留缝）
			kind := share.DropExtKind(strings.ToLower(filepath.Ext(part.FileName())))
			if kind == "" || acceptedCount >= qdMaxBatchFiles {
				// 白名单外 / 超单批数：读 filename 即判拒，排水跳过保连接
				//（后续文件照收）；占位进 added[]，不消耗配额不落盘
				if _, derr := io.Copy(io.Discard, part); derr != nil {
					fenceErr(derr)
					return
				}
				added = append(added, share.DropMeta{Name: name, Kind: "rejected"})
				continue
			}
			maxBytes := int64(share.MaxDropImageBytes)
			if kind == "file" {
				maxBytes = qdMaxFileBytes
			}
			meta, done := writeStreamedFile(c, root, dir, part, name, kind,
				maxBytes, quotaUsed, now, &batch)
			if !done {
				// 当前文件已由 writeStreamedFile 移除记账——整批残留在此清
				//（配额断/落盘故障/读流失败，响应已写或无处投递）
				cleanup()
				return
			}
			if meta == nil {
				// 超单文件上限：半成品已删，排水跳过（rejected 占位）
				if _, derr := io.Copy(io.Discard, part); derr != nil {
					fenceErr(derr)
					return
				}
				added = append(added, share.DropMeta{Name: name, Kind: "rejected"})
				continue
			}
			quotaUsed += meta.Size
			acceptedCount++
			added = append(added, *meta)
			if meta.Sensitive {
				warnings = append(warnings, meta.Name)
			}
		default:
			// 未知/杂项字段：排水忽略（垃圾不计配额——外层体闸兜底）
			if _, derr := io.Copy(io.Discard, part); derr != nil {
				fenceErr(derr)
				return
			}
		}
	}

	content := strings.TrimSpace(string(text))
	if acceptedCount == 0 && content == "" {
		// 内容或文件至少一项；文件全被拒的形态把逐文件占位如实随响应
		//（访客页据此呈现每个失败位），纯空载荷才给裸 400
		if len(added) > 0 {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "content or files required", "added": added, "warnings": warnings,
			})
			return
		}
		shared.Error(c, http.StatusBadRequest, "content or files required", nil)
		return
	}
	if acceptedCount == 0 {
		// 纯文本投递（文件全被拒）：走文本通道同一到达语义（notify/audit
		// 文本口径），响应仍携 added[] 供访客页呈现失败位
		q, ie := ingest(c, token, content)
		switch ie {
		case ingestOK: // token/长度已前置校验，此处只剩成功或存储故障
		case ingestErrStore:
			shared.Error(c, http.StatusInternalServerError, "save quickdrop failed", nil)
			return
		default:
			shared.Error(c, http.StatusBadRequest, "content is required", nil)
			return
		}
		writeMultipartOK(c, q, added, warnings)
		return
	}

	// 收件箱 doc：Content 存文件元数据行（评审倾向形态——通知行内动作
	// payload 仍指 quickdrop:<id>，前端回查/转交链零改动）
	accepted := make([]share.DropMeta, 0, acceptedCount)
	for _, m := range added {
		if m.Kind != "rejected" {
			accepted = append(accepted, m)
		}
	}
	body := buildFileDropContent(content, dir, accepted)
	q, err := st.Quickdrop.Add(store.Quickdrop{Content: body, From: c.ClientIP()})
	if err != nil {
		// 收件箱入账失败：删本批文件（宁失败不留「通知已发而文件无账」的
		// 悬空面——访客重传是干净路径）
		cleanup()
		shared.Error(c, http.StatusInternalServerError, "save quickdrop failed", err)
		return
	}
	// 批次链回填（P-20261117-3）：Add 之后才有 doc id——逐文件把 dropId 补写
	// 进 sidecar（机器元数据单一事实源仍是磁盘 sidecar，store 五字段不扩；
	// 文件落盘在先、doc 发号在后，归属链只能后写）。失败尽力而为：缺链文件
	// 不进清单投影、摘除不联动，下载仍可按 fid 等值自证，TTL GC 兜底收尸
	for i := range accepted {
		accepted[i].DropID = q.ID
		_ = share.WriteDropSidecar(dir, &accepted[i])
	}
	notifyFilesArrived(st, q, accepted)
	auditFilesIngest(c, q, accepted)
	writeMultipartOK(c, q, added, warnings)
}

// writeMultipartOK 200 成功响应（data 与文本通道同形：id/expiresAt 入账面 +
// 逐文件终态 + 警示——S2 访客页 XHR 据此渲染成功态与逐文件失败位）
func writeMultipartOK(c *gin.Context, q store.Quickdrop, added []share.DropMeta, warnings []string) {
	if added == nil {
		added = []share.DropMeta{}
	}
	if warnings == nil {
		warnings = []string{}
	}
	c.JSON(http.StatusOK, gin.H{
		"data":     gin.H{"ok": true, "id": q.ID, "expiresAt": q.ExpiresAt},
		"added":    added,
		"warnings": warnings,
	})
}

// quotaBoundedReader 配额有界读：放行至多 remaining 字节；闸值后探 1 字节
// 区分「恰好收满」（EOF——配额精确填满属合法）与「仍有余量」（errQuota
// Exceeded——断请求删残留）。单文件上限闸由内层 LimitReader 承担（本读链
// 组合见 writeStreamedFile）——本类型只管配额一个闸
type quotaBoundedReader struct {
	r         io.Reader
	remaining int64
}

func (q *quotaBoundedReader) Read(p []byte) (int, error) {
	if q.remaining > 0 {
		if int64(len(p)) > q.remaining {
			p = p[:q.remaining]
		}
		n, err := q.r.Read(p)
		q.remaining -= int64(n)
		return n, err
	}
	// 闸值已满：边界探测（EOF = 恰好收满；有数据 = 超限）
	var probe [1]byte
	for {
		n, err := q.r.Read(probe[:])
		if n > 0 {
			return 0, errQuotaExceeded
		}
		if err == io.EOF {
			return 0, io.EOF
		}
		if err != nil {
			return 0, err
		}
		// n==0 && err==nil：底层要求重试
	}
}

// writeStreamedFile 单文件流式落盘（直落 + 边写边数三闸：单文件上限 / 剩余
// 配额 / 外层体闸）。返回 (meta, true)=已入账；(nil, true)=超单文件上限
// （半成品已删，调用方排水跳过）；(_, false)=请求已终止响应（残留已清）。
// sidecar 与本体的先后与 drops.go 同纪律：本体先于 sidecar（sidecar 在场
// 即清单可见，无「清单可见而文件缺失」的坏条目）
func writeStreamedFile(c *gin.Context, root *os.Root, dir string, part io.Reader,
	name, kind string, maxBytes, quotaUsed int64, now time.Time, batch *[]string,
) (*share.DropMeta, bool) {
	// 双层读链：内层 LimitReader(maxBytes+1) 承担单文件上限闸（+1 让
	// 「恰好收满」与「超限」在 n 上可分），外层 quotaBoundedReader 承担
	// 配额闸（剩余配额探到数据即断——配额触顶优先于单文件上限判拒）
	quotaRemaining := qdMaxTotalBytes - quotaUsed
	id := nextQdID()
	fileName := id + "_" + name
	dst, cerr := root.Create(fileName)
	if cerr != nil {
		shared.Error(c, http.StatusInternalServerError, "internal error", cerr)
		return nil, false
	}
	*batch = append(*batch, fileName) // 先记账后拷贝——任何中断路径都清得到
	n, cerr := io.Copy(dst, &quotaBoundedReader{
		r:         io.LimitReader(part, maxBytes+1),
		remaining: quotaRemaining,
	})
	if cerr == nil {
		cerr = dst.Close()
	} else {
		_ = dst.Close()
	}
	if cerr != nil {
		// 当前文件移除+退账（整批残留由调用方 cleanup 收口）
		_ = root.Remove(fileName)
		*batch = (*batch)[:len(*batch)-1]
		switch {
		case errors.Is(cerr, errQuotaExceeded):
			// 配额触顶：整批断 413（后续文件必然同顶——拆批重传是唯一出路）
			shared.Error(c, http.StatusRequestEntityTooLarge, "drop_quota", nil)
		default:
			var mbe *http.MaxBytesError
			if errors.As(cerr, &mbe) {
				shared.Error(c, http.StatusRequestEntityTooLarge, "too_large", nil)
			} else if c.Request.Context().Err() != nil {
				// 客户端断连：残留清账即收，响应无处投递
			} else {
				shared.Error(c, http.StatusInternalServerError, "internal error", cerr)
			}
		}
		return nil, false
	}
	if n > maxBytes {
		// 超单文件上限：拒绝位（删半成品，不消耗配额；调用方排水跳过）
		_ = root.Remove(fileName)
		*batch = (*batch)[:len(*batch)-1]
		return nil, true
	}
	meta := &share.DropMeta{
		ID: id, FileName: fileName, Name: name, Size: n, Kind: kind,
		At: now, Sensitive: share.IsSensitiveName(name),
	}
	if err := share.WriteDropSidecar(dir, meta); err != nil {
		// 本体已落、元数据失败：删本体重来（宁失败不留坏条目——drops.go 同款）
		_ = root.Remove(fileName)
		*batch = (*batch)[:len(*batch)-1]
		shared.Error(c, http.StatusInternalServerError, "internal error", err)
		return nil, false
	}
	return meta, true
}

// ── 收件箱正文与通知/审计（文件投递口径） ──

// buildFileDropContent 文件投递的收件箱正文：文本在前（用户显式载荷完整
// 优先），文件块在后——头部行 + 目录行恒在（agent ls 目录即可还原全量
// 清单），逐文件「- 名 (大小)」明细行在剩余预算内尽力填。总预算 =
// store.MaxDropBytes（收件箱 doc 硬闸）：超支先裁文件明细行、文本仍超再裁
// （截断标记如实呈现）。「交给当前会话」把整段写进终端——目录行是消费链
// 的闭环锚（DropAbsPath 纪律：绝对路径只在主人侧投影，访客响应零路径泄露
// 的口径不因本函数松动——Content 是收件箱 doc 的主人侧面）
func buildFileDropContent(text, dir string, metas []share.DropMeta) string {
	truncMark := "\n[文本已截断 / truncated]"
	fixed := fmt.Sprintf("[文件 %d 个，24h 内有效]\n目录: %s\n", len(metas), dir)
	// 目录行兜底截断（DataDir 异常超长时保 doc 硬闸不破——rune 安全截；
	// 尾随换行占 1 字节先预留）
	if len(fixed) > store.MaxDropBytes {
		fixed = trimRunesToBytes(fixed, store.MaxDropBytes-1) + "\n"
	}
	rest := store.MaxDropBytes - len(fixed)
	// 文本段：预算内完整保留；超预算裁剪+标记（裁剪标记自身占位先预留；
	// 预算 -1 是与文件块之间的换行分隔符——总长不越 store.MaxDropBytes 硬闸）
	textPart := ""
	if text != "" && rest > 1 {
		budget := rest - 1
		if len(text) > budget {
			if budget <= len(truncMark) {
				textPart = ""
			} else {
				textPart = trimRunesToBytes(text, budget-len(truncMark)) + truncMark
			}
		} else {
			textPart = text
		}
	}
	// 文件明细行：文本之后的剩余预算内尽力填（超支只丢明细行——目录行恒在）
	var b strings.Builder
	if textPart != "" {
		b.WriteString(textPart)
		b.WriteByte('\n')
	}
	b.WriteString(fixed)
	lineBudget := rest - len(textPart)
	for _, m := range metas {
		line := "- " + m.Name + " (" + share.FmtSize(m.Size) + ")\n"
		if len(line) > lineBudget {
			break
		}
		b.WriteString(line)
		lineBudget -= len(line)
	}
	return strings.TrimRight(b.String(), "\n")
}

// trimRunesToBytes 字节预算内的 rune 安全截断（不产生半 rune 破字；
// rune 逐个累计字节数单遍定位切点——不做逐轮重建的 O(n²)）
func trimRunesToBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	runes := []rune(s)
	total := 0
	cut := 0
	for i, r := range runes {
		size := utf8.RuneLen(r)
		if total+size > max {
			break
		}
		total += size
		cut = i + 1
	}
	return string(runes[:cut])
}

// notifyFilesArrived 文件投递到达通知：标题模板区分文件形态（titleKey
// notify.quickdrop.filesArrived + count/size 参数——通知文案区分文本/文件
// 投递的评审建议⑤），Body 带文件名/大小速览行（drops.go dropNote 的
// fmtSize 同款口径）；行内动作双出口与文本投递同形（payload=quickdrop:<id>）
func notifyFilesArrived(st *store.Store, q store.Quickdrop, metas []share.DropMeta) {
	total := int64(0)
	for _, m := range metas {
		total += m.Size
	}
	st.Notification.Add(notification.Notification{
		Type:     "info",
		Category: notification.CategoryDrop,
		TitleKey: "notify.quickdrop.filesArrived",
		MsgParams: map[string]any{
			"from":  q.From,
			"count": len(metas),
			"size":  share.FmtSize(total),
		},
		Body:                fileBrief(metas),
		Action:              "quickdrop-active",
		ActionPayload:       PayloadPrefix + q.ID,
		SecondAction:        "quickdrop-new",
		SecondActionPayload: PayloadPrefix + q.ID,
	})
}

// fileBrief 文件名/大小速览行（单行「、」连结；超 qdFileBriefMax 截断并以
// 「（共 N 个）」如实注记总数——明细在收件箱 doc 的 Content，通知只做抬头）
func fileBrief(metas []share.DropMeta) string {
	var b strings.Builder
	runes := 0
	for i, m := range metas {
		item := m.Name + " (" + share.FmtSize(m.Size) + ")"
		if i > 0 {
			item = "、" + item
		}
		r := len([]rune(item))
		if runes+r > qdFileBriefMax {
			b.WriteString("…（共 " + strconv.Itoa(len(metas)) + " 个）")
			return b.String()
		}
		b.WriteString(item)
		runes += r
	}
	return b.String()
}

// auditFilesIngest 文件投递审计：只记条数/字节量/敏感名命中元数据——正文与
// 文件名不入账（P-13 纪律同款，quickdrop 文本投递的 id/bytes 口径加列）
func auditFilesIngest(c *gin.Context, q store.Quickdrop, metas []share.DropMeta) {
	if store.Get() == nil || store.Get().Audit == nil {
		return
	}
	total := int64(0)
	sensitive := false
	for _, m := range metas {
		total += m.Size
		if m.Sensitive {
			sensitive = true
		}
	}
	detail := fmt.Sprintf("id=%s bytes=%d files=%d", q.ID, total, len(metas))
	if sensitive {
		detail += " sensitive-name"
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditQuickdropDrop,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}

// ── 清账面（显式清 + GC 对账兜底） ──

// purgeQuickdropFiles 凭据失效的显式清账：token 是单例——隔离区下任何目录
// 都挂在某个历史 token 名下，凭据生成（即轮换）/撤销后全部目录即刻失效
// （share DeleteDropsFor 撤销级联清同款语义：「凭据终止 → 素材面一体失效」）。
// 旧目录名不可从哈希反推，清的是隔离区全量子目录（token 单例天然简化）。
// 竞态面：清账瞬间在途的旧凭据上传可再落新目录——GC keep 对账兜底收尸
func purgeQuickdropFiles() {
	root, err := os.OpenRoot(quickdropFilesRoot())
	if err != nil {
		return // 根不在 = 无文件面
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return
	}
	for _, e := range entries {
		_ = root.RemoveAll(e.Name())
	}
}

// gcQuickdropFiles 文件隔离区对账清账（quickdrop 模块 10 分钟 ticker + 启动
// 即跑一轮）。keep 集对账的 token 单例简化版：
//
//	① 孤儿目录：目录名不再通过现役 token 校验（撤销/轮换显式清账的崩溃/
//	   竞态兜底）整树删除；
//	② TTL：文件 24h（store.DropTTL——与收件箱 doc 同窗，投递与文件一体
//	   过窗）到期删本体+sidecar；sidecar 缺失的裸文件（崩溃残骸）按 mtime
//	   口径同窗清；
//	③ 清空目录一并移除（隔离区紧凑）。
//
// 守卫：store 不可用即拒绝清账——keep 集判不了就不清（share GcOrphanDrops
// keep=nil 拒绝清账守卫同旨，防误删全库）
func gcQuickdropFiles(st *store.Store, now time.Time, logger *slog.Logger) int {
	if st == nil || st.QuickdropToken == nil {
		return 0
	}
	root, err := os.OpenRoot(quickdropFilesRoot())
	if err != nil {
		return 0
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if !st.QuickdropToken.Validate(name) {
			// 孤儿：失效凭据名下的目录（目录名 = 原 token 明文，校验不过
			// 即已不在册）
			if root.RemoveAll(name) == nil {
				removed++
			}
			continue
		}
		dir, derr := root.OpenRoot(name)
		if derr != nil {
			continue
		}
		live := 0
		files, ferr := fs.ReadDir(dir.FS(), ".")
		if ferr != nil {
			dir.Close()
			continue
		}
		for _, f := range files {
			fname := f.Name()
			if strings.HasSuffix(fname, share.DropSidecarSuffix) {
				continue // sidecar 随本体判定/删除，不独立计时
			}
			var cutoff time.Time
			if meta, merr := readQdSidecar(dir, fname); merr == nil {
				cutoff = meta.At.Add(store.DropTTL)
			} else {
				info, ierr := f.Info()
				if ierr != nil {
					continue
				}
				cutoff = info.ModTime().Add(store.DropTTL)
			}
			if now.After(cutoff) {
				_ = dir.Remove(fname)
				_ = dir.Remove(fname + share.DropSidecarSuffix)
				removed++
				continue
			}
			live++
		}
		dir.Close()
		if live == 0 {
			_ = root.RemoveAll(name)
		}
	}
	if removed > 0 && logger != nil {
		logger.Info("quickdrop files gc", "removed", removed)
	}
	return removed
}

// readQdSidecar 读单个文件的 sidecar 元数据（sidecar 名 = 本体名 + 后缀——
// WriteDropSidecar 的落位规则，无需前缀搜索）
func readQdSidecar(dir *os.Root, fileName string) (*share.DropMeta, error) {
	f, err := dir.Open(fileName + share.DropSidecarSuffix)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, qdSidecarReadLimit))
	if err != nil {
		return nil, err
	}
	var m share.DropMeta
	if json.Unmarshal(data, &m) != nil {
		return nil, fs.ErrInvalid
	}
	return &m, nil
}
