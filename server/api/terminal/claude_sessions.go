package terminal

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	shared "codecombo/server/api/shared"
	"codecombo/server/claudesessions"
	"codecombo/server/middleware"
	"codecombo/server/sensitive"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ListClaudeSessions GET /api/claude/sessions?projectId=&q=&limit=&offset=&withPressure=
// Claude Code 本地会话列表（只读扫描 ~/.claude/projects）：
//   - projectId 非空 = 项目级（只扫该项目工作目录对应子目录）；空 = 全局（全部项目）
//   - q = id/内容统一的大小写不敏感子串搜索（服务端全量扫描，返回前 limit 条）
//   - limit 默认 50（上限 200），offset 分页；按最后活动时间倒序，星标置顶
//     （P-20261003-67，分页前重排——后页星标也能进第一屏）
//   - withPressure=true：为活跃会话估算上下文压力（P-20261002-58，尾部 usage
//     聚合）——仅活跃行按需扫描（活跃会话通常个位数，避免每次列表全量 IO），
//     非活跃行不带 pressure
func ListClaudeSessions(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	limit := parseBounded(c.Query("limit"), 50, 1, 200)
	offset := parseBounded(c.Query("offset"), 0, 0, 1<<30)
	withPressure := c.Query("withPressure") == "true"
	hiddenView := c.Query("hidden") == "1" || c.Query("hidden") == "true" // 管理视图（P-20261003-112）：只看已隐藏（"true" = axios params 布尔序列化形态，与 withPressure 同款）

	projectPath := ""
	if pid := strings.TrimSpace(c.Query("projectId")); pid != "" {
		p, err := store.Get().Project.GetByID(pid)
		if err != nil || p == nil {
			shared.Error(c, http.StatusNotFound, "project not found", nil)
			return
		}
		projectPath = p.Path
	}

	// 策展数据（P-20261003-67）：一次批量取全量（车道 1 内存遍历，量级 = 用户
	// 策展过的会话数），两条列表路径共用；读失败退化空表不阻断列表
	curation := claudesessions.FetchCuration(store.Get().ClaudeCur, claudesessions.Root())

	// 管理视图（P-20261003-112）：只返回被隐藏且 transcript 仍存活的会话。
	// 不支持 q（隐藏是界面级抹除——已隐藏会话的内容不参与检索面），withPressure
	// 同样无意义（隐藏行无需压力徽标）
	if hiddenView {
		idx := claudesessions.NewIndex(store.Get().ClaudeIndex, claudesessions.Root())
		rows := idx.ListHidden(projectPath, curation)
		// Active 终端注册表校正（P-20261031-1）：管理视图行同口径（「进行中」
		// 徽标虽不在隐藏视图展示，is-active 行态与数据消费面保持一致）
		applyClaudeActiveCorrection(rows, buildClaudeActiveRegistry(),
			loadClaudeAssocs(claudesessions.Root()), time.Now())
		c.JSON(http.StatusOK, gin.H{"data": claudesessions.ListResult{Sessions: rows, Total: len(rows)}})
		return
	}

	// 无搜索词：走可重建索引（车道 3 加速——stat 级对账，未变更文件零内容读，
	// 见 server/claudesessions/index.go）；搜索必须读文件内容，仍走全量扫描
	var res claudesessions.ListResult
	var err error
	if q == "" {
		idx := claudesessions.NewIndex(store.Get().ClaudeIndex, claudesessions.Root())
		res, err = idx.List(projectPath, limit, offset, curation)
	} else {
		res, err = claudesessions.List(claudesessions.Root(), projectPath, q, limit, offset, curation)
	}
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "List claude sessions failed", err)
		return
	}
	// Active 终端注册表校正（P-20261031-1）：mtime 启发式之上的三档精确化——
	// 活终端挂载=活跃（长思考零误判）/ Codecombo 拉起过且终端已关=立即失活
	// （僵尸「进行中」零延迟）/ 原生会话收敛 90s 窄档。判定语义与注册表装配
	// 见 claude_sessions_active.go；压力估算（下方）按校正后的活跃集扫描，
	// 僵尸行不再产生无效 IO
	applyClaudeActiveCorrection(res.Sessions, buildClaudeActiveRegistry(),
		loadClaudeAssocs(claudesessions.Root()), time.Now())
	// 会话花费阈值告警（P-20261003-157）：用量数据面刷新后的判定点——超阈且
	// 未告警过的会话入账通知一次（功能关零成本，见 claude_sessions_spend.go）。
	// 在压力估算之前：告警不依赖 withPressure，任何列表消费路径都判定
	notifyClaudeSpendThreshold(res.Sessions)
	// 压力按需估算：单会话失败（文件恰好消失/不可读）只降级为无徽标，
	// 不让整个列表失败
	if withPressure {
		root := claudesessions.Root()
		for i := range res.Sessions {
			if !res.Sessions[i].Active {
				continue
			}
			p, ok, err := claudesessions.ContextPressure(root, res.Sessions[i].ID)
			if err == nil && ok {
				res.Sessions[i].Pressure = &p
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// GetClaudeSessionsAt GET /api/projects/:id/sessions-at?ts=<RFC3339>
// 会话时间窗溯源（P-20261007-11）：输入任意时刻（blame 行提交时刻/审批时刻/
// 排障时间点），返回该项目（transcript 存储目录=项目路径编码，即 Cwd 归属）
// 当时活跃的 Claude 会话清单——FirstAt ≤ ts ≤ LastAt，按时间接近度升序，
// 上限 10（匹配与截断语义见 claudesessions.SessionsAt）。活会话天然在覆盖面
// 内（运行中持续追加 transcript，mtime 即 LastAt），transcript 已删的会话
// 自然不命中（诚实缺失）。溯源是时段关联非因果确证：并行会话同窗全部列出，
// 因果判断留给人——前端 blame 悬停溯源区带同款注记。
// 隐藏剔除与列表/检索同口径（P-112/P-237：策展 hidden 不进批量读面）。
// 智能体操作面：结构化只读端点（token 门）——agent 排障可编程自查「这个
// 时间点哪些会话在动」；agentops 手册 terminal 节登记。
// 性能面：Index.List 全量页走 stat 级对账（索引命中零内容读），项目会话量级
// 通常几十~几百，悬停单次查询代价与打开会话中心列表同级
func GetClaudeSessionsAt(c *gin.Context) {
	ts, err := time.Parse(time.RFC3339, strings.TrimSpace(c.Query("ts")))
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid ts (RFC3339 required)", err)
		return
	}
	p, err := store.Get().Project.GetByID(c.Param("id"))
	if err != nil || p == nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}
	// 时间窗匹配需要项目会话全集而非分页页：Index.List limit=0 返回全部；
	// 策展注入=隐藏剔除+星标透传（Session.Starred 随行，前端溯源区可标星标）
	curation := claudesessions.FetchCuration(store.Get().ClaudeCur, claudesessions.Root())
	res, err := claudesessions.NewIndex(store.Get().ClaudeIndex, claudesessions.Root()).List(p.Path, 0, 0, curation)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "List claude sessions failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": claudesessions.SessionsAt(res.Sessions, ts, claudesessions.SessionsAtLimitMax)})
}

// GetClaudeSessionTimeline GET /api/claude/sessions/:id/timeline?limit=&offset=
// 单会话回放时间线（P-20261001-3）：transcript 直读解析（不绕道 claudeindex
// 索引——索引不镜像内容），尾部窗口内时间正序分页；越权 id（目录穿越形态）
// 与不存在的会话一律 404，不区分暴露文件系统布局
func GetClaudeSessionTimeline(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	limit := parseBounded(c.Query("limit"), 50, 1, 200)
	offset := parseBounded(c.Query("offset"), 0, 0, 1<<30)

	res, err := claudesessions.Timeline(claudesessions.Root(), id, limit, offset)
	if err != nil {
		if errors.Is(err, claudesessions.ErrSessionNotFound) {
			shared.Error(c, http.StatusNotFound, "session not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "Read claude session timeline failed", err)
		return
	}
	// 轮级书签注入（P-20261003-122）+ 轮级语义标签注入（P-20261003-256）：
	// 回放弹层的书签清单/星标态/标签 chips 的单一取数点——打开时间线即取策展
	// 条目，不依赖会话列表行的快照（列表刷新前重开回放也是新策展态）。读失败
	// 降级为无策展（策展是增强层，不阻断回放主链路）
	if existing, err := store.Get().ClaudeCur.GetBatch(store.ClaudeCurPrefix(claudesessions.Root())); err == nil {
		if cur, ok := existing[store.ClaudeCurKey(claudesessions.Root(), id)]; ok {
			res.Bookmarks = cur.Bookmarks
			res.Tags = cur.Tags
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// GetClaudeSessionExport GET /api/claude/sessions/:id/export?format=md|jsonl&mode=full|qa
// 会话回放导出（P-20261003-44 + P-20261003-60 双格式）：缺省/md = timeline 解析
// 基建渲染的 Markdown 知识文档（user/assistant 分节、工具摘要行、思考引用块，
// 见 claudesessions/export.go）；format=jsonl = 原始 transcript 流式直传
// （application/x-ndjson，无损零渲染——机读存档/再分析/迁移的原文件本体）。
// mode=qa（P-20261004-132）仅问答档：md 渲染层过滤（只留 user/assistant 正文，
// 解析链零改动），贴文档/发队友读者跳过工具过程噪声；文件名 -qa 尾缀区分。
// mode 缺省/full = 完整档零变化；未知 mode 400 明确拒绝（与未知 format 同款
// 不静默回落纪律）；jsonl 无渲染面，mode=qa 语义不成立 400 拒绝（agent 取结
// 论形态走 md 档）。两者同为 Content-Disposition 附件下载（文件名 =
// claude-<标题摘要>-<日期>[-qa].<ext>）。
// 404 语义与 timeline 一致（不存在/越权 id 不区分，不暴露文件系统布局），
// 未知 format 400 明确拒绝（不静默回落 md——机读消费方拿错格式比报错更糟）。
// 隐藏会话不拦（P-20261003-237 知情边界）：隐藏语义是「批量读面退场」（列表/
// 检索/日报/批量导出均排除），不是加密删除——显式 id 的单会话导出是知情动作
// （深链/回放页逐个显式发起，transcript 本体也从未被触碰），保持可达；批量面
// 的同口径排除见 claude_sessions_batch.go。
// 内容敏感闸（P-20261004-113）：两格式共用同一扫描警示链（默认原样保真语义
// 不变——命中回 JSON warnings 由消费方确认，confirm=1 后全文完整无遮蔽出域；
// jsonl 的扫描挂点在相对化改写链下游，见 exportSessionJSONL）。qa 档同闸同链
// （过滤只去掉工具/思考条目，问答正文仍可能含敏感值）。
// 审计入账（修正项）：导出 = 会话全明文出域，P-54 同族记账惯例（只记动作与
// 会话 id 元数据，内容绝不入账）；Append 尽力而为，不阻断下载。内容闸放行
// 路径在 Detail 追加命中类型/计数（仍不含原文），无命中时 Detail 逐字节不变
func GetClaudeSessionExport(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	mode, ok := claudesessions.ParseExportMode(c.Query("mode"))
	if !ok {
		shared.Error(c, http.StatusBadRequest, "unsupported mode (full|qa)", nil)
		return
	}
	switch format := strings.TrimSpace(c.Query("format")); format {
	case "", "md":
		exportSessionMarkdown(c, id, mode)
	case "jsonl":
		if mode == claudesessions.ExportModeQA {
			shared.Error(c, http.StatusBadRequest, "mode=qa applies to format=md only", nil)
			return
		}
		exportSessionJSONL(c, id)
	default:
		shared.Error(c, http.StatusBadRequest, "unsupported format (md|jsonl)", nil)
	}
}

// exportSessionMarkdown md 导出主链（P-20261003-44）：解析渲染全文明文附件。
// mode 档位（P-20261004-132）：full = P-44 完整文档零变化；qa = 仅问答过滤档
// （claudesessions.ExportAtMode 渲染层过滤），下载名 -qa 尾缀与完整档区分。
// 内容敏感闸（P-20261004-113）：渲染全文先跑共享扫描链，命中且未 confirm=1
// 回 JSON 警示（类型计数不附原文）；确认后附件仍是同一份 Markdown 全文——
// 「默认原样保真」语义不变，扫描只做知情提示不改写内容
func exportSessionMarkdown(c *gin.Context, id string, mode claudesessions.ExportMode) {
	res, err := claudesessions.ExportAtMode(claudesessions.Root(), id, time.Now(), mode)
	if err != nil {
		respondExportError(c, err)
		return
	}
	hits := sensitive.ScanContent(res.Markdown)
	if exportSensitiveGate(c, hits) {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditClaudeExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: id + sensitiveAuditSuffix(hits),
	})
	name := claudesessions.ExportDownloadName(res.Title, id, time.Now(), "md")
	if mode == claudesessions.ExportModeQA {
		name = claudesessions.ExportQADownloadName(res.Title, id, time.Now())
	}
	c.Header("Content-Type", "text/markdown; charset=utf-8")
	// 下载头统一净化 helper（P-20261003-109 收编包内私有实现）：控制字符/引号
	// 剥除 + RFC 5987 双形式，会话标题用户可控
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	c.String(http.StatusOK, res.Markdown)
}

// exportSessionJSONL 原始 transcript 直传（P-20261003-60）：定位 → 头净化的
// 附件头 → 流式拷贝。P-20261003-113 起出域前按会话 cwd（项目 root）逐行相对
// 化改写（transcript 每行都嵌 cwd 字段与绝对路径，直传等于把主机布局整份带
// 出去；改写口径见 claudesessions/relpath.go）——改写后字节与源文件不再一致，
// ServeContent 的 Range/Last-Modified 语义不成立，改走逐行流式拷贝（附件下载
// 无 Range 消费方）；Root 未知（头部窗口无 cwd 字段）降级为 ServeContent 原样
// 直传，出域不因改写锚点缺失而失败。不设体积上限：流式路径无渲染放大，逐行
// 处理内存有界（单行驻留，见 CopyRelativizedJSONL），与 md 导出的输出封顶属
// 两套护栏。
// 内容敏感闸（P-20261004-113）：扫描挂点必须在相对化改写链下游——先逐行
// 预扫「改写后」字节（ScanRelativizedJSONL，与拷贝链共用同一改写真子），
// 未 confirm=1 回 JSON warnings；确认后回绕文件句柄走原拷贝链，出域字节与
// 无闸时逐字节一致（扫描只读）。整文件预扫一趟的 IO 代价只在显式导出动作上
// 发生，换「闸门判定先于响应头」的语义
func exportSessionJSONL(c *gin.Context, id string) {
	raw, err := claudesessions.ExportRaw(claudesessions.Root(), id)
	if err != nil {
		respondExportError(c, err)
		return
	}
	f, err := os.Open(raw.Path)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Export claude session failed", err)
		return
	}
	defer f.Close() //nolint:errcheck // 只读句柄，ServeContent 返回后关闭失败无可补救动作
	st, err := f.Stat()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Export claude session failed", err)
		return
	}
	// 预扫 == 读取整文件，扫完必须回绕到起点再出流
	hits, err := scanJSONLExport(f, raw.Root)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Export claude session failed", err)
		return
	}
	if exportSensitiveGate(c, hits) {
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Export claude session failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditClaudeExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: id + sensitiveAuditSuffix(hits),
	})
	name := claudesessions.ExportDownloadName(raw.Title, id, time.Now(), "jsonl")
	c.Header("Content-Type", "application/x-ndjson")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	if raw.Root == "" {
		http.ServeContent(c.Writer, c.Request, "", st.ModTime(), f)
		return
	}
	// 写失败只发生在客户端断开（响应头已发出，失败无可补救动作），静默结束
	_, _ = claudesessions.CopyRelativizedJSONL(c.Writer, f, raw.Root)
}

// respondExportError 导出双格式共用的错误出口：不存在/越权 id 404，其余 500
func respondExportError(c *gin.Context, err error) {
	if errors.Is(err, claudesessions.ErrSessionNotFound) {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	shared.Error(c, http.StatusInternalServerError, "Export claude session failed", err)
}

// SearchClaudeSessions GET /api/claude/sessions/search?q=&limit=&projectId=
// 会话历史全文搜索（P-20261003-19）：跨 transcripts 提取 user/assistant 消息
// 文本做大小写不敏感子串匹配，命中带 ≤2 条上下文（已做 P-108 敏感遮蔽）与
// 消息时刻（供前端回放 focusAt 定位直达）。护栏（单文件 5MB 跳过/会话上限
// 200/总时限 5s）在 server/claudesessions/search.go，超限以 truncated 如实
// 上报。projectId 语义与列表一致；q 为空 = 无效请求（无「空词全量」语义）
func SearchClaudeSessions(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		shared.Error(c, http.StatusBadRequest, "query required", nil)
		return
	}
	limit := parseBounded(c.Query("limit"), claudesessions.SearchLimitDefault, 1, claudesessions.SearchLimitMax)

	projectPath := ""
	if pid := strings.TrimSpace(c.Query("projectId")); pid != "" {
		p, err := store.Get().Project.GetByID(pid)
		if err != nil || p == nil {
			shared.Error(c, http.StatusNotFound, "project not found", nil)
			return
		}
		projectPath = p.Path
	}

	ix := claudesessions.NewIndex(store.Get().ClaudeIndex, claudesessions.Root())
	res := ix.Search(projectPath, q, limit)
	curation := claudesessions.FetchCuration(store.Get().ClaudeCur, claudesessions.Root())
	// 隐藏剔除（P-20261003-112）：检索默认排除 hidden——transcript 命中与备注
	// 命中同口径退场
	claudesessions.DropHiddenHits(&res, curation)
	// 备注命中源（P-20261003-67）：P-19 检索扫描逻辑零改动，note 作为其外的
	// 额外命中源并入（命中带备注原文，前端打「备注」来源标识）
	if len(curation) > 0 {
		ix.MergeNoteHits(&res, curation, projectPath, q, limit)
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// SetClaudeSessionCuration POST /api/claude/sessions/curation
// 会话策展 upsert（P-20261003-67 + P-20261003-112 + P-20261003-122 +
// P-20261003-256）：{sessionId, starred?, note?, hidden?, bookmarkAdd?,
// bookmarkRemove?, tagAdd?, tagRemove?} 部分更新语义——指针字段承载「是否携带」：
// 只带 starred 不动备注，只带 bookmarkAdd 不动星标/备注（切换星标不会抹掉备注，
// 加书签不会动星标）；全部清空时删除条目（不留零值孤儿）。
// bookmarkAdd/bookmarkRemove 是轮级书签（P-20261003-122）的增量操作面：值为
// timeline 条目的 At 原串（RFC3339），服务端验形 + 集合增删后钳制（去重/排序/
// 上限，store.ClampBookmarks）——前端不直写整表，防并发互覆。
// tagAdd/tagRemove 是轮级语义标签（P-20261003-256）的增量操作面：(At,Tag) 对，
// At 验形同书签、Tag 经 store.NormalizeTag 消毒后验空/验长（超长 400 拒绝不
// 截断，截断残词会与既有标签撞名致过滤失真），集合增删后钳制（store.ClampTags）。
// 隐藏/恢复写审计事件（隐私操作留痕，Detail 含会话名自明化），仅在值实际变化
// 时记录（重复提交同一值不算动作）。transcript 存在性不做校验：策展可先于/
// 晚于 transcript 生命周期（同 id 重建自动跟回），列表/搜索按「存活会话 ∩ 策展」
// 消费孤儿条目，无幽灵展示面
func SetClaudeSessionCuration(c *gin.Context) {
	var req struct {
		SessionID      string               `json:"sessionId"`
		Starred        *bool                `json:"starred"`
		Note           *string              `json:"note"`
		Hidden         *bool                `json:"hidden"`
		BookmarkAdd    *string              `json:"bookmarkAdd"`
		BookmarkRemove *string              `json:"bookmarkRemove"`
		TagAdd         *store.ClaudeTurnTag `json:"tagAdd"`
		TagRemove      *store.ClaudeTurnTag `json:"tagRemove"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	if req.Starred == nil && req.Note == nil && req.Hidden == nil && req.BookmarkAdd == nil &&
		req.BookmarkRemove == nil && req.TagAdd == nil && req.TagRemove == nil {
		shared.Error(c, http.StatusBadRequest, "starred or note or hidden or bookmark or tag required", nil)
		return
	}
	// id 形态防御（与 FindResumeCwd 同款守卫）：会话 UUID 不含路径分隔符与点号
	//（键直拼进 filestore 文档键，非法形态拒绝而非事后报错）
	if id := req.SessionID; id == "" || len(id) > 128 || strings.ContainsAny(id, `\/.`) {
		shared.Error(c, http.StatusBadRequest, "invalid session id", nil)
		return
	}
	// 书签值验形：必须是 RFC3339 时刻串（timeline 条目 At 的原样透传），拒绝
	// 任意字符串塞进策展文档——形态错的书签永远匹配不到条目，纯垃圾数据
	for _, p := range []*string{req.BookmarkAdd, req.BookmarkRemove} {
		if p == nil {
			continue
		}
		if len(*p) > 64 {
			shared.Error(c, http.StatusBadRequest, "invalid bookmark timestamp", nil)
			return
		}
		if _, err := time.Parse(time.RFC3339, *p); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid bookmark timestamp (RFC3339 required)", err)
			return
		}
	}
	// 标签值验形（P-20261003-256）：At 同书签 RFC3339 验形；Tag 消毒（trim+剥
	// 前导 #）后非空且不超 rune 上限——就地归一 req 内的值，后续集合运算拿到的
	// 即消毒形态，remove 的键与存储形态恒一致（#架构 与 架构 移除同一标签）
	for _, p := range []*store.ClaudeTurnTag{req.TagAdd, req.TagRemove} {
		if p == nil {
			continue
		}
		if len(p.At) > 64 {
			shared.Error(c, http.StatusBadRequest, "invalid tag timestamp", nil)
			return
		}
		if _, err := time.Parse(time.RFC3339, p.At); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid tag timestamp (RFC3339 required)", err)
			return
		}
		p.Tag = store.NormalizeTag(p.Tag)
		if p.Tag == "" || utf8.RuneCountInString(p.Tag) > store.TagMaxRunes {
			shared.Error(c, http.StatusBadRequest, "invalid tag (1.."+strconv.Itoa(store.TagMaxRunes)+" runes required)", nil)
			return
		}
	}

	root := claudesessions.Root()
	key := store.ClaudeCurKey(root, req.SessionID)
	entry := store.ClaudeSessionCur{
		Key:       key,
		ID:        req.SessionID,
		UpdatedAt: time.Now(),
	}
	// 部分更新：未携带的字段沿用既有值（无既有值 = 零值）
	wasHidden := false
	if existing, err := store.Get().ClaudeCur.GetBatch(store.ClaudeCurPrefix(root)); err == nil {
		if old, ok := existing[key]; ok {
			entry.Starred = old.Starred
			entry.Note = old.Note
			entry.Hidden = old.Hidden
			entry.Bookmarks = old.Bookmarks
			entry.Tags = old.Tags
			wasHidden = old.Hidden
		}
	}
	if req.Starred != nil {
		entry.Starred = *req.Starred
	}
	if req.Note != nil {
		entry.Note = store.ClampNote(*req.Note)
	}
	if req.Hidden != nil {
		entry.Hidden = *req.Hidden
	}
	if req.BookmarkAdd != nil || req.BookmarkRemove != nil {
		// 集合增删后统一钳制（去重/排序/上限）：add 已在集合 = 幂等，remove
		// 不在集合 = 幂等（书签 toggle 重放无副作用）
		set := make(map[string]struct{}, len(entry.Bookmarks)+1)
		for _, at := range entry.Bookmarks {
			set[at] = struct{}{}
		}
		if req.BookmarkAdd != nil {
			set[*req.BookmarkAdd] = struct{}{}
		}
		if req.BookmarkRemove != nil {
			delete(set, *req.BookmarkRemove)
		}
		entry.Bookmarks = make([]string, 0, len(set))
		for at := range set {
			entry.Bookmarks = append(entry.Bookmarks, at)
		}
		entry.Bookmarks = store.ClampBookmarks(entry.Bookmarks)
	}
	if req.TagAdd != nil || req.TagRemove != nil {
		// 集合增删后统一钳制（去重/排序/上限），幂等语义与书签同族
		type tagKey struct{ at, tag string }
		set := make(map[tagKey]struct{}, len(entry.Tags)+1)
		for _, p := range entry.Tags {
			set[tagKey{p.At, p.Tag}] = struct{}{}
		}
		if req.TagAdd != nil {
			set[tagKey{req.TagAdd.At, req.TagAdd.Tag}] = struct{}{}
		}
		if req.TagRemove != nil {
			delete(set, tagKey{req.TagRemove.At, req.TagRemove.Tag})
		}
		entry.Tags = make([]store.ClaudeTurnTag, 0, len(set))
		for k := range set {
			entry.Tags = append(entry.Tags, store.ClaudeTurnTag{At: k.at, Tag: k.tag})
		}
		entry.Tags = store.ClampTags(entry.Tags)
	}

	// 隐藏/恢复审计（P-20261003-112 修正项）：值实际变化才算动作；Detail = 会话
	// 名（索引标题）+ 短 id，翻台账自明。Append 尽力而为，不阻断策展主链路
	if req.Hidden != nil && entry.Hidden != wasHidden {
		ix := claudesessions.NewIndex(store.Get().ClaudeIndex, root)
		short := req.SessionID
		if len(short) > 8 {
			short = short[:8]
		}
		detail := fmt.Sprintf("%s (%s…)", ix.LookupTitle(req.SessionID), short)
		action := store.AuditClaudeUnhide
		if entry.Hidden {
			action = store.AuditClaudeHide
		}
		middleware.AuditAppend(c, store.AuditEvent{
			Action: action,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: detail,
		})
	}

	if !entry.Starred && entry.Note == "" && !entry.Hidden && len(entry.Bookmarks) == 0 && len(entry.Tags) == 0 {
		// 全部清空：删条目而非存零值（kind 保持「只含有策展的会话」）。
		// 条目本就不存在 = 幂等成功（postcondition 已满足）——双清删条目的
		// 契约语义含「无残留可清」形态，报错会让清理方（e2e 播种前对账/
		// 前端重复双清）拿到 500 假失败（fulle2e run7 抓得 document not found）
		if err := store.Get().ClaudeCur.Delete(key); err != nil && !errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusInternalServerError, "claude session curation failed", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"sessionId": req.SessionID, "starred": false, "note": "", "hidden": false, "bookmarks": []string{}, "tags": []store.ClaudeTurnTag{}}})
		return
	}
	if err := store.Get().ClaudeCur.Put(entry); err != nil {
		shared.Error(c, http.StatusInternalServerError, "claude session curation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"sessionId": entry.ID,
		"starred":   entry.Starred,
		"note":      entry.Note,
		"hidden":    entry.Hidden,
		"bookmarks": entry.Bookmarks,
		"tags":      entry.Tags,
	}})
}

// parseBounded 整数查询参数：解析失败回默认值，并夹紧到 [min, max]
func parseBounded(raw string, def, min, max int) int {
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return def
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}
