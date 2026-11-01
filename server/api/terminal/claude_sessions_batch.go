package terminal

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/claudesessions"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/sensitive"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 会话批量导出 zip（P-20261003-165）：多选会话打包为单个归档件——数月会话
// 的离线归档（换机前打包），单会话导出（P-20261003-44/P-20261003-60）逐个
// 点太慢。每会话一个 md（渲染知识文档）或 jsonl（原文件本体）条目，渲染/流式
// 链逐字复用单会话导出同一实现（Export/ExportRaw/CopyRelativizedJSONL，出域
// 路径相对化 P-20261003-113 同口径），本文件只做「批量」的编排：条目命名去重、
// 逐会话跳过记账、MANIFEST 清单与流式护栏。
//
// 打包形态对齐 dir-archive（P-20261002-115）流式惯例：不落盘、不整读进内存，
// zip.Writer 直写响应；未压缩总量触顶即优雅收尾出合法截断包（响应头先于流
// 发出，截断无法事后回传——MANIFEST 尾条目如实记账，dir-archive 的 probe
// 预估通道在批量场景没有对应物，会话体量远小于目录树，总量封顶只是兜底）。
//
// POST 承载 ids：50 会话 UUID 的查询串 ≈2KB 贴近 URL 上限且无下载语义收益
// （前端 axios blob 下载与 curl 直调对 POST 天然兼容，broadcast-write 同款
// ids-in-body 惯例）；全部 id 均无法定位时 404（与单会话导出同语义，不出空包），
// 部分缺失逐条跳过进 MANIFEST（bulk-agent 单项目失败跳过不中断先例）。
//
// 隐藏排除（P-20261003-237）：批量导出与列表/检索/日报同一隐私口径——被策展
// 隐藏的会话不进批量面。前端多选面只在默认视图可用（管理视图不可多选，选择集
// 跨视图即清），但服务端仍按既有「前端预检 + 服务端兜底」惯例同口径把关（陈旧
// 客户端/并发隐藏的选中 id 不静默出域），隐藏 id 记入 MANIFEST 已隐藏清单与
// 审计 hidden 计数如实留痕。显式 id 的单会话深链导出不拦（知情边界，见
// GetClaudeSessionExport 注记）——批量是「捎带面」，单个显式 id 是知情动作。
const (
	// batchExportMaxSessions 单批上限（提案口径 ≤50 会话/批，前端同值预检）
	batchExportMaxSessions = 50
	// batchExportMaxBody 请求体上限（50 × 37 字节 UUID 远够，防滥用批量）
	batchExportMaxBody = 128 * 1024
	// batchExportMaxTotalBytes 包内未压缩总字节上限（dirZipMaxTotalBytes 同值，
	// 8GB——正常会话归档远达不到，防御病态大 transcript 批量）
	batchExportMaxTotalBytes = int64(8) << 30
	// batchManifestName 清单条目名：zip 内平铺，会话条目名恒以 claude- 开头，
	// 无撞名面
	batchManifestName = "MANIFEST.txt"
	// batchEncMaxZipBytes 口令加密档的 zip 缓冲上限：信封格式（P-29）的密文是
	// 单条 base64 串，无法流式——整包先驻内存再封装。峰值 ≈ 3.7×zip（zip 本体
	// + GCM Seal 密文 + base64 串 + JSON 序列化各一份），512MiB 上限对应 ~1.9GB
	// 瞬时内存，正常会话归档（数十 MB）远达不到；触顶 413 干净失败（响应头未
	// 发出，与明文档触顶只能出截断包不同，加密档有能力整体拒绝）。低频导出操作，
	// 瞬时内存换不落盘零临时文件
	batchEncMaxZipBytes = int64(512) << 20
)

// batchExportStats 一次批量导出的记账（MANIFEST 与审计 Detail 的数据源）
type batchExportStats struct {
	files      []batchExportFile
	skipped    []string // 定位失败（不存在/不可读）的会话 id，逐条如实记账
	hiddenSkip []string // 被策展隐藏而排除的会话 id（P-20261003-237），与失败分开记账
	truncated  bool     // 未压缩总量触顶，余下会话未打包
	written    int64    // 已写入未压缩字节（体积护栏记账口径）
}

type batchExportFile struct {
	name  string // zip 内条目名
	id    string
	title string
}

// batchLocated 定位阶段的单会话锚点（路径必在；标题/cwd 为 jsonl 条目命名与
// 出域相对化锚点，md 路径在渲染段由 ExportAt 自取）
type batchLocated struct {
	id    string
	path  string
	title string
	cwd   string
}

// BatchExportClaudeSessions POST /api/claude/sessions/export-archive
// {"ids":[...],"format":"md"(缺省)|"jsonl","passphrase"?} → application/zip 流式附件；
// 携非空 passphrase 时改出 application/json 口令信封（P-29 EncryptWithPassphrase
// 惯例，*.zip.enc.json 附件）。护栏：ids 1..50（超出 400 明确拒绝，与前端单批
// 上限同值）；未知 format 400 不静默回落（单会话导出同语义）；口令 <8 位 400
// （remotehost 导出同口径，双保险——前端 validate 已把一道）；畸形 id（路径
// 分隔符/点号/超长）400 拒绝（curation 同款守卫——畸形 id 不可能是合法会话，
// 属调用方缺陷，早失败优于静默跳过）。逐会话渲染/拷贝失败（含导出中途
// transcript 消失）跳过并记入 MANIFEST，不中断整批。内容敏感闸（P-20261003-225）：
// 全批预扫聚合同一份 JSON 警示，命中且未 confirm=1 不出附件（单会话导出同族
// 契约，见函数体闸注释）。审计 claude.export_batch
// 记账（明细=N/M/truncated/enc/sensitive，内容与口令绝不入账）。
func BatchExportClaudeSessions(c *gin.Context) {
	shared.LimitBody(c, batchExportMaxBody)
	var req struct {
		IDs        []string `json:"ids"`
		Format     string   `json:"format"`
		Passphrase string   `json:"passphrase"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "batch export request too large",
				fmt.Errorf("request body exceeds %d bytes", batchExportMaxBody))
			return
		}
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	// 口令逐字使用不 trim（口令语义，空白字符合法）；空串=明文 zip（既有档位
	// 零变化，旧客户端不携该字段自动落明文）
	passphrase := req.Passphrase
	if passphrase != "" && len(passphrase) < 8 {
		shared.Error(c, http.StatusBadRequest, "passphrase too short (min 8)", nil)
		return
	}
	format := strings.TrimSpace(req.Format)
	if format == "" {
		format = "md"
	}
	if format != "md" && format != "jsonl" {
		shared.Error(c, http.StatusBadRequest, "unsupported format (md|jsonl)", nil)
		return
	}
	if len(req.IDs) == 0 {
		shared.Error(c, http.StatusBadRequest, "ids is required", nil)
		return
	}
	if len(req.IDs) > batchExportMaxSessions {
		shared.Error(c, http.StatusBadRequest,
			fmt.Sprintf("too many sessions for batch export (max %d)", batchExportMaxSessions), nil)
		return
	}
	for _, id := range req.IDs {
		if id == "" || len(id) > 128 || strings.ContainsAny(id, `\/.`) {
			shared.Error(c, http.StatusBadRequest, "invalid session id", nil)
			return
		}
	}

	// 定位前置（头发出前完成，全部落空 404 不出空包）：md 只需 stat 级定位
	//（渲染留到流式段逐会话做，峰值内存 = 单会话渲染文档 ≤8MB，绝不整批驻留）；
	// jsonl 顺带取头部元数据（标题/Root），流式段免二次扫描。
	// 隐藏排除在定位前做（P-20261003-237，策略先于存在性）：策展一次批量取
	//（车道 1 内存遍历，量级 = 用户策展过的会话数，低频导出操作零负担），与
	// 列表 FetchCuration 同一读取口径
	root := claudesessions.Root()
	curation := claudesessions.FetchCuration(store.Get().ClaudeCur, root)
	found := make([]batchLocated, 0, len(req.IDs))
	var missing []string
	var hiddenSkipped []string
	for _, id := range req.IDs {
		if c, ok := curation[id]; ok && c.Hidden {
			hiddenSkipped = append(hiddenSkipped, id)
			continue
		}
		if format == "jsonl" {
			raw, err := claudesessions.ExportRaw(root, id)
			if err != nil {
				missing = append(missing, id)
				continue
			}
			found = append(found, batchLocated{id: id, path: raw.Path, title: raw.Title, cwd: raw.Root})
			continue
		}
		path, ok := claudesessions.LocateSession(root, id)
		if !ok {
			missing = append(missing, id)
			continue
		}
		found = append(found, batchLocated{id: id, path: path})
	}
	if len(found) == 0 {
		// 全部落空（不存在/不可读/已隐藏同口径）404 不出空包——隐藏 id 在
		// 批量面的语义就是「不可见」，与缺失一致不区分暴露
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}

	now := time.Now()

	// 内容敏感闸（P-20261003-225，P-20261004-113 导出族同族接入）：批量此前
	// 完全绕过单导的出域闸——同一批内容的两条出域路径警示不对称（单会话直链
	// 有二次确认、批量直包零确认），属安全缺口。闸判定必须先于响应头（JSON
	// 警示与 zip 流不能同响应），故全批预扫：md 逐会话渲染后扫描、jsonl 逐
	// 会话按相对化改写下游扫描（scanJSONLExport 与单导同一实现，扫的就是最终
	// 出域字节），命中跨会话聚合成同一份 {warnings, sensitiveHits}——前端弹层
	// 与 agent 编程感知拿到的契约与单导逐字节同形（类型计数，不含原文、不含
	// 会话归因）。预扫代价 = 写段前整批多渲染/多读一遍（md 逐会话渲染后即弃，
	// 内存仍只有单会话驻留；显式低频导出动作，与单会话 jsonl「整文件预扫换
	// 闸门判定先于响应头」同一取舍）；confirm=1 跳同样全批预扫——闸重判与
	// 审计后缀都需要命中集。逐会话预扫失败不中断（批量「逐会话失败跳过留账」
	// 契约）：失败会话在写段有同款失败面（同路径重开/同渲染链），未扫到的
	// 字节大概率同样出不去；错误前已计的命中仍入闸（宁可多警示）。警示分支
	// 零审计（单导同口径），放行审计追加 sensitiveAuditSuffix（无命中时
	// Detail 逐字节不变，存量 spec 精确断言零回归）
	var prescanned sensitive.Counter
	for _, it := range found {
		if format == "jsonl" {
			f, err := os.Open(it.path)
			if err != nil {
				slog.Warn("claude batch export: prescan open failed", "session", it.id, "err", err)
				continue
			}
			hits, scanErr := scanJSONLExport(f, it.cwd)
			_ = f.Close() //nolint:errcheck // 只读句柄，关闭失败无可补救动作
			if scanErr != nil {
				slog.Warn("claude batch export: prescan scan failed", "session", it.id, "err", scanErr)
			}
			prescanned.AddHits(hits)
			continue
		}
		res, err := claudesessions.ExportAt(root, it.id, now)
		if err != nil {
			// 预扫渲染失败（transcript 恰好消失/IO 错）：写段同链会再失败并跳过
			if !errors.Is(err, claudesessions.ErrSessionNotFound) {
				slog.Warn("claude batch export: prescan render failed", "session", it.id, "err", err)
			}
			continue
		}
		prescanned.AddText(res.Markdown)
	}
	if exportSensitiveGate(c, prescanned.Hits()) {
		return
	}

	st := &batchExportStats{skipped: missing, hiddenSkip: hiddenSkipped}
	used := make(map[string]bool, len(found))

	// 打包主体两条出路：明文（缺省）zip.Writer 直写响应（头先发、触顶优雅
	// 截断，既有档位零变化）；口令加密档信封密文是单条 base64 串无法流式，
	// 先驻内存缓冲封装后再整体回写（未超 413 干净失败，头未发出有能力整体拒绝）
	var buf bytes.Buffer
	var w io.Writer = c.Writer
	if passphrase != "" {
		w = &buf
	} else {
		zipName := fmt.Sprintf("claude-sessions-%s.zip", now.Format("20060102-1504"))
		c.Header("Content-Type", "application/zip")
		// 下载头统一净化 helper（P-20261003-109）：与单会话导出同出口
		c.Header("Content-Disposition", shared.ContentDispositionFile(zipName))
		c.Status(http.StatusOK)
	}

	zw := zip.NewWriter(w)
	for _, it := range found {
		// 体积护栏（dir-archive 同语义）：触顶后余下会话整条跳过，zip 中央
		// 目录照常写出（合法但截断的包）
		if st.written > batchExportMaxTotalBytes {
			st.truncated = true
			st.skipped = append(st.skipped, it.id)
			continue
		}
		if format == "jsonl" {
			writeBatchJSONL(zw, it, now, used, st)
		} else {
			writeBatchMarkdown(zw, root, it, now, used, st)
		}
	}
	writeBatchManifest(zw, format, now, st, passphrase != "")
	if err := zw.Close(); err != nil {
		// 客户端断开为主：头已发出，失败只日志留痕（dir-archive 同）；加密档
		// 此刻仍在内存缓冲，失败同样只留痕（封装前还有 413 兜底）
		slog.Warn("claude batch export: zip close failed", "err", err)
	}

	if passphrase != "" {
		if int64(buf.Len()) > batchEncMaxZipBytes {
			shared.Error(c, http.StatusRequestEntityTooLarge, "encrypted batch export too large",
				fmt.Errorf("zip buffer %d bytes exceeds %d", buf.Len(), batchEncMaxZipBytes))
			return
		}
		env, err := config.EncryptWithPassphrase(buf.Bytes(), []byte(passphrase))
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "encrypt batch export", err)
			return
		}
		zipName := fmt.Sprintf("claude-sessions-%s.zip.enc.json", now.Format("20060102-1504"))
		c.Header("Content-Type", "application/json")
		c.Header("Content-Disposition", shared.ContentDispositionFile(zipName))
		c.Status(http.StatusOK)
		_, _ = c.Writer.Write(env)
	}

	detail := fmt.Sprintf("batch %s %d/%d", format, len(st.files), len(req.IDs))
	if passphrase != "" {
		detail += " enc"
	}
	if len(st.skipped) > 0 {
		detail += fmt.Sprintf(" skipped %d", len(st.skipped))
	}
	// hidden 计数与 skipped 分列：定位失败是异常，隐藏排除是策略（P-20261003-237），
	// 台账上两种「未打包」不混记
	if len(st.hiddenSkip) > 0 {
		detail += fmt.Sprintf(" hidden %d", len(st.hiddenSkip))
	}
	if st.truncated {
		detail += " truncated"
	}
	// 内容闸放行路径追加命中类型计数（P-20261003-225）：与单会话导出同一
	// sensitiveAuditSuffix 口径，无命中时为空串（存量 Detail 逐字节不变）
	detail += sensitiveAuditSuffix(prescanned.Hits())
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditClaudeBatchZip,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}

// writeBatchMarkdown 单会话 md 条目：渲染链 = 单会话导出同一 Export 实现
// （窗口/体积护栏与截断注记全继承），条目名同约定、同题同日撞名以短 id 后缀
// 去重。渲染/写失败跳过留账，不中断整批
func writeBatchMarkdown(zw *zip.Writer, root string, it batchLocated, now time.Time, used map[string]bool, st *batchExportStats) {
	res, err := claudesessions.ExportAt(root, it.id, now)
	if err != nil {
		// 定位成功后渲染失败（文件恰好消失/IO 错）：跳过留账
		if !errors.Is(err, claudesessions.ErrSessionNotFound) {
			slog.Warn("claude batch export: render markdown failed", "session", it.id, "err", err)
		}
		st.skipped = append(st.skipped, it.id)
		return
	}
	// 条目名一次算定：batchEntryName 会写 used 表，两处调用会产生两个不同名
	name := batchEntryName(used, res.Title, it.id, now, "md")
	w, err := zw.Create(name)
	if err != nil {
		slog.Warn("claude batch export: zip entry create failed", "session", it.id, "err", err)
		st.skipped = append(st.skipped, it.id)
		return
	}
	if _, err := io.WriteString(w, res.Markdown); err != nil {
		// 客户端断开为主：字节已流出无从补救，按已写出量记账后返回
		slog.Warn("claude batch export: zip entry write failed", "session", it.id, "err", err)
		st.written += int64(len(res.Markdown))
		return
	}
	st.written += int64(len(res.Markdown))
	st.files = append(st.files, batchExportFile{name: name, id: it.id, title: res.Title})
}

// writeBatchJSONL 单会话原始 transcript 条目：流式逐行相对化拷贝（单会话
// 导出同一 CopyRelativizedJSONL 实现，Root 未知降级原样直传同口径），逐行
// 处理内存有界
func writeBatchJSONL(zw *zip.Writer, it batchLocated, now time.Time, used map[string]bool, st *batchExportStats) {
	f, err := os.Open(it.path)
	if err != nil {
		slog.Warn("claude batch export: open transcript failed", "session", it.id, "err", err)
		st.skipped = append(st.skipped, it.id)
		return
	}
	defer f.Close() //nolint:errcheck // 只读句柄，关闭失败无可补救动作
	name := batchEntryName(used, it.title, it.id, now, "jsonl")
	w, err := zw.Create(name)
	if err != nil {
		slog.Warn("claude batch export: zip entry create failed", "session", it.id, "err", err)
		st.skipped = append(st.skipped, it.id)
		return
	}
	// 体积预算按拷贝实际字数计（相对化改写与源文件略有出入，实数为准）
	copied, err := func() (int64, error) {
		if it.cwd != "" {
			return claudesessions.CopyRelativizedJSONL(w, f, it.cwd)
		}
		return io.Copy(w, f)
	}()
	st.written += copied
	if err != nil {
		slog.Warn("claude batch export: zip entry copy failed", "session", it.id, "err", err)
		// 拷贝中断（客户端断开/源读失败）：已流出部分无从补救，条目记为已
		// 导出（截断与否不再细分——MANIFEST 的清单位保持完整）
	}
	st.files = append(st.files, batchExportFile{name: name, id: it.id, title: it.title})
}

// writeBatchManifest 清单尾条目（zip 读侧按中央目录列条目，写入顺序不影响
// 展示——放最后才能汇总全批结果）。逐文件一行「条目名 + 会话 id + 标题」，
// 跳过明细如实列出（不存在/不可读与已隐藏分节——原因自明）；审计与 MANIFEST
// 同源记账。encrypted 时注记一行：清单在信封内，此行是解密后归档的自描述
// （证明不了什么，如实记账而已）
func writeBatchManifest(zw *zip.Writer, format string, now time.Time, st *batchExportStats, encrypted bool) {
	w, err := zw.Create(batchManifestName)
	if err != nil {
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Codecombo 会话批量导出\n")
	fmt.Fprintf(&b, "导出时间：%s\n", now.Format("2006-01-02 15:04:05"))
	fmt.Fprintf(&b, "格式：%s\n", map[string]string{"md": "Markdown", "jsonl": "原始 JSONL"}[format])
	if encrypted {
		b.WriteString("口令加密：已启用（口令信封，解密需导出时设置的口令）\n")
	}
	// 汇总行的「跳过」= 全部未打包（缺失 + 隐藏，P-20261003-237），原因在下方
	// 分节自明
	fmt.Fprintf(&b, "导出 %d 个会话，跳过 %d 个\n", len(st.files), len(st.skipped)+len(st.hiddenSkip))
	if st.truncated {
		b.WriteString("注：超出单包体积上限，部分会话未打包（跳过清单含被省略会话）。\n")
	}
	if len(st.files) > 0 {
		b.WriteString("\n# 已导出\n")
		for _, f := range st.files {
			fmt.Fprintf(&b, "%s\t%s\t%s\n", f.name, f.id, f.title)
		}
	}
	if len(st.skipped) > 0 {
		b.WriteString("\n# 跳过（会话不存在或不可读）\n")
		for _, id := range st.skipped {
			fmt.Fprintf(&b, "%s\n", id)
		}
	}
	if len(st.hiddenSkip) > 0 {
		b.WriteString("\n# 跳过（已隐藏：批量导出排除隐藏会话，单会话导出不受影响）\n")
		for _, id := range st.hiddenSkip {
			fmt.Fprintf(&b, "%s\n", id)
		}
	}
	_, _ = io.WriteString(w, b.String())
}

// batchEntryName 条目名：与单会话导出同一 ExportDownloadName 净化/摘要约定
// （claude-<标题摘要>-<yyyymmdd>.<ext>）。同题同日的会话在批量里高频撞名
// （zip 同名条目在部分解压器上互相覆盖），以短 id 后缀去重——id 全局唯一，
// 逐级加长必收敛；used 表跨全批去重
func batchEntryName(used map[string]bool, title, id string, now time.Time, ext string) string {
	name := claudesessions.ExportDownloadName(title, id, now, ext)
	if !used[name] {
		used[name] = true
		return name
	}
	dot := strings.LastIndex(name, ".")
	base, extPart := name[:dot], name[dot:]
	for n := 8; n <= len(id); n += 8 {
		candidate := fmt.Sprintf("%s-%s%s", base, id[:n], extPart)
		if !used[candidate] {
			used[candidate] = true
			return candidate
		}
	}
	// 理论不可达（id 唯一）：兜底序号保证恒收敛
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d%s", base, i, extPart)
		if !used[candidate] {
			used[candidate] = true
			return candidate
		}
	}
}
