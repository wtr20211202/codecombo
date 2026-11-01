package system

import (
	"bytes"
	"encoding/base64"
	"encoding/csv"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// auditMaxLimit 单页上限：防止 limit=100000 之类的请求把保留窗口全量拖走
// （管理面已有鉴权，封顶只为响应体积可控）
const auditMaxLimit = 500

// auditDefaultLimit 未传 limit 时的默认页大小（与 store.Audit List 默认一致）
const auditDefaultLimit = 100

// ListAudit GET /api/audit?limit&offset&cursor —— 安全事件审计日志（时间倒序分页）。
// 管理面鉴权：挂在全局 api 组（LockMiddleware + TokenAuthMiddleware）之下。
// 只读端点，条目本身只含动作与元数据（不含秘密值）。
// 分页双模式（P-20261003-223）：cursor 携带时走键集游标（(Time, ID) 复合键的
// 不透明 token，取值来自上一页 nextCursor）——深翻不随 offset 线性多扫，翻页
// 间隙新增事件也不会重复/漏读；cursor 与 offset 同携时 cursor 优先，offset 旧
// 参数保留兼容（既有消费方零变化）。任何非空满页响应附 nextCursor——旧客户端
// 忽略该键零影响，新客户端自首页即可切换键集续翻；页未满即已到底，末页/空页
// 不带该键。
// 响应顶面附审计写失败计数（P-20261003-205）——面板展示处与本数据面同源，
// 打开页/刷新一次请求既见列表也见断链警示，不另发健康轮询
func ListAudit(c *gin.Context) {
	limit, offset := parseAuditPage(c.Query("limit"), c.Query("offset"))
	var (
		events []store.AuditEvent
		total  int
		err    error
	)
	if raw := c.Query("cursor"); raw != "" {
		afterTime, afterID, derr := decodeAuditCursor(raw)
		if derr != nil {
			// 非法游标 = 客户端缺陷或游标损坏，静默回落会让客户端拿到无法与
			// 自身锚点对齐的页（比报错更难排查），400 明确拒绝
			c.JSON(http.StatusBadRequest, gin.H{"err": "bad_request", "msg": "invalid audit cursor"})
			return
		}
		events, total, err = store.Get().Audit.ListCursor(limit, afterTime, afterID)
	} else {
		events, total, err = store.Get().Audit.List(limit, offset)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
		return
	}
	failCount, lastFail := auditWriteFailFields()
	resp := gin.H{
		"data":               events,
		"total":              total,
		"auditWriteFails":    failCount,
		"auditLastWriteFail": lastFail,
		// 条数上限第二道闸（P-20261004-80）：面板顶部弱提示的同源数据面——
		// 常量在响应透出而非前端硬编码，改阈值时提示不漂移（P-123 导出窗口
		// 与裁剪窗口同源不漂移的同款纪律）；旧前端忽略该键零影响
		"maxEntries": store.MaxAuditEntries,
	}
	// 满页才给 nextCursor（锚在页尾条目本身）；恰好整除的末尾多一次空页取数
	// 属键集分页的通行语义，换游标稳定性是划算的
	if len(events) == limit {
		resp["nextCursor"] = encodeAuditCursor(events[len(events)-1])
	}
	c.JSON(http.StatusOK, resp)
}

// auditCursorSep 游标载荷分隔符：RFC3339Nano 时间文本与条目 ID（UUID）都不含 "|"
const auditCursorSep = "|"

// encodeAuditCursor 把分页锚点 (Time, ID) 编码为不透明游标。base64url（Raw 去
// padding）免查询串转义，与锁定 token 的编码惯例同形；载荷用分隔符拼接而非
// JSON——两个定形字段的解码错误面更小
func encodeAuditCursor(e store.AuditEvent) string {
	payload := e.Time.Format(time.RFC3339Nano) + auditCursorSep + e.ID
	return base64.RawURLEncoding.EncodeToString([]byte(payload))
}

// decodeAuditCursor 解码游标为键集锚点；任何解析失败都返回错误（ListAudit 据此 400）
func decodeAuditCursor(raw string) (time.Time, string, error) {
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return time.Time{}, "", err
	}
	tPart, id, ok := strings.Cut(string(b), auditCursorSep)
	if !ok {
		return time.Time{}, "", fmt.Errorf("cursor payload missing %q separator", auditCursorSep)
	}
	ts, err := time.Parse(time.RFC3339Nano, tPart)
	if err != nil {
		return time.Time{}, "", err
	}
	return ts, id, nil
}

// auditWriteFailFields 审计写失败可见性计数（P-20261003-205）的响应字段：
// /api/audit 与 /api/system/health 两处共用同一形状。lastFail 为 RFC3339
// 文本、空串 = 从未失败（零值哨兵，与 AuditEvent.time 的 RFC3339 序列化
// 惯例同形，前端直接喂既有日期格式化）
func auditWriteFailFields() (count int64, lastFail string) {
	count, last := store.Get().Audit.WriteFailures()
	if !last.IsZero() {
		lastFail = last.Format(time.RFC3339)
	}
	return count, lastFail
}

// parseAuditPage 解析分页参数：非法值回退默认（limit 100 / offset 0）并封顶
func parseAuditPage(rawLimit, rawOffset string) (limit, offset int) {
	limit = auditDefaultLimit
	if n, err := strconv.Atoi(rawLimit); err == nil && n > 0 {
		limit = n
	}
	if limit > auditMaxLimit {
		limit = auditMaxLimit
	}
	if n, err := strconv.Atoi(rawOffset); err == nil && n > 0 {
		offset = n
	}
	return limit, offset
}

// auditExportMaxDays 导出窗口上限（天）：审计保留窗口即全量——保留窗口外的
// 条目已被保留策略清账，窗口再大也无数据可取（防参数漂移成「伪全量」承诺）。
// P-20261003-123 起随 settings.auditRetentionDays 动态读取，导出窗口与裁剪
// 窗口同源不漂移（留存调长后新窗口可整窗导出，调短后窗口随之收窄）
func auditExportMaxDays() int {
	return store.Get().Settings.Get().Server.AuditRetentionDaysOrDefault()
}

// auditExportRowCap 导出行数硬上限：分页循环的无界内存防线。保留 30 天 +
// 人操作级写入频率下远不可及（持续 30 天平均 >2 条/30 秒才触顶），仅防御
// 病态存储；触顶截断收尾。var 而非 const：100k 级种子对 file-per-doc 存储
// 不可负担，测试以小上限注入验证「过滤后仍按导出行数截断」（生产路径零差异）
var auditExportRowCap = 100000

// parseAuditFilterSet 解析逗号分隔多值过滤参数（P-20261007-2）：空/仅分隔符
// 返回 nil = 该维度不过滤（零参数 = 全窗口口径，向后兼容）。值不归一不改写
// ——与前端 AuditLogPane 行内过滤严格同构的原值精确匹配（大小写敏感），两侧
// 均不引入新枚举：action 值域 = store.Audit* 常量点分值（前端从已加载列表
// 去重派生）、result 值域 = store.AuditResult* 三值；未知值只是匹配不到行
// （空 CSV 不报错）——与前端「选了窗口内没出现的动作必是空结果」的选项语义
// 一致，也无须维护会漂移的枚举白名单
func parseAuditFilterSet(raw string) map[string]bool {
	set := map[string]bool{}
	for _, v := range strings.Split(raw, ",") {
		if v = strings.TrimSpace(v); v != "" {
			set[v] = true
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

// auditFilterDetail 自审计 Detail 的过滤参数段（P-20261007-2）：导出切片语义
// 可追溯（台账里看得出这次 audit.export 是全窗口还是过滤切片）。维度内多值用
// "|" 连接（action 点分值与 result 词值都不含 | 与逗号，无歧义）、维度间仍用
// 逗号，整体以空格挂在 days/rows 之后；维度内排序输出保证同一参数集 Detail
// 稳定（map 迭代序随机，不排序则同参数两次导出台账文本不同）。零过滤返回
// 空串——Detail 保持「days=%d rows=%d」逐字节不变（存量消费者零感知）
func auditFilterDetail(actionSet, resultSet map[string]bool) string {
	if len(actionSet) == 0 && len(resultSet) == 0 {
		return ""
	}
	segment := func(prefix string, set map[string]bool) string {
		vals := make([]string, 0, len(set))
		for v := range set {
			vals = append(vals, v)
		}
		sort.Strings(vals)
		return prefix + strings.Join(vals, "|")
	}
	var segs []string
	if len(actionSet) > 0 {
		segs = append(segs, segment("action:", actionSet))
	}
	if len(resultSet) > 0 {
		segs = append(segs, segment("result:", resultSet))
	}
	return " filters=" + strings.Join(segs, ",")
}

// ExportAudit GET /api/audit/export?days=30[&action=...&result=...] —— 当前
// 窗口审计 CSV 导出（P-20261003-66）：time/action/result/ip/detail 五列，
// encoding/csv 按 RFC 4180 转义（含逗号/引号/换行的字段自动加引号），表格软件
// 公式注入防护见 sanitizeCSVCell。鉴权同 List 面（全局 api 组 LockMiddleware +
// TokenAuthMiddleware 同域）；导出 = 审计数据出域，同路入账（workspace/claude
// 导出同族惯例），入账在 CSV 构建之后——导出动作自身不进本次文件。
//
// 过滤联动（P-20261007-2）：action= 与 result= 各接受逗号分隔多值，分页循环内
// 按原值精确匹配（与前端 AuditLogPane 行内过滤同构的查看面语义）——过滤是
// 服务端全窗口过滤，覆盖前端 500 条查看窗口之外的更早条目（P-131 窗口钳制的
// 能力补全）；零参数 = 两集合皆空 = 全窗口口径，输出与行为逐字节同现状
// （向后兼容，旧调用方零变化）。自审计 Detail 追加 filters= 段记录切片口径
// （零过滤时不出现在 Detail，存量形态不变）
//
// 实施注记：必须分页循环拉全量——List 单页钳制 auditMaxLimit（500）且
// limit<=0 回落默认 100，单次 List(0) 会把 30 天窗口截断成首页
func ExportAudit(c *gin.Context) {
	days := parseAuditDays(c.Query("days"))
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	actionSet := parseAuditFilterSet(c.Query("action"))
	resultSet := parseAuditFilterSet(c.Query("result"))

	var buf bytes.Buffer
	// UTF-8 BOM：Detail 常含非 ASCII（主机名/路径），Excel 无 BOM 按 ANSI 误读
	buf.WriteString("\xEF\xBB\xBF")
	w := csv.NewWriter(&buf)
	// 表头语言中立小写（机器可读口径，与时间 RFC3339 一致，消费方是表格软件与脚本）
	_ = w.Write([]string{"time", "action", "result", "ip", "detail"})

	rows := 0
	for offset := 0; ; offset += auditMaxLimit {
		page, total, err := store.Get().Audit.List(auditMaxLimit, offset)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
			return
		}
		for _, e := range page {
			if e.Time.Before(cutoff) {
				continue
			}
			// 过滤联动（P-20261007-2）：集合空即该维度放行（零参数全量）；
			// 过滤在行数上限记账之前——cap 计的是导出行数而非扫描行数
			if len(actionSet) > 0 && !actionSet[e.Action] {
				continue
			}
			if len(resultSet) > 0 && !resultSet[e.Result] {
				continue
			}
			if rows >= auditExportRowCap {
				break
			}
			rows++
			_ = w.Write([]string{
				e.Time.Format(time.RFC3339),
				sanitizeCSVCell(e.Action),
				e.Result,
				e.IP,
				sanitizeCSVCell(e.Detail),
			})
		}
		if len(page) < auditMaxLimit || offset+auditMaxLimit >= total || rows >= auditExportRowCap {
			break
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
		return
	}

	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditLogExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("days=%d rows=%d%s", days, rows, auditFilterDetail(actionSet, resultSet)),
	})

	name := fmt.Sprintf("simple-coding-audit-%s.csv", time.Now().Format("2006-01-02"))
	c.Header("Content-Type", "text/csv; charset=utf-8")
	// 下载名为服务端常量（无用户内容），unquoted-token 形式即安全，无需净化 helper
	c.Header("Content-Disposition", "attachment; filename="+name)
	c.String(http.StatusOK, buf.String())
}

// parseAuditDays 解析窗口参数：非法/缺省回退上限（=保留窗口全量），请求
// 再大也只可能拿到保留窗口内的数据
func parseAuditDays(raw string) int {
	days := auditExportMaxDays()
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		days = n
	}
	if days > auditExportMaxDays() {
		days = auditExportMaxDays()
	}
	return days
}

// sanitizeCSVCell 防 CSV 公式注入：实现已提升为导出族公共 helper
// （P-20261003-247，shared.SanitizeCSVCell——审批裁决 CSV 导出同用），此处
// 保留同名薄封装以最小化本文件 diff；新消费方直接引用 shared 版本
func sanitizeCSVCell(s string) string {
	return shared.SanitizeCSVCell(s)
}
