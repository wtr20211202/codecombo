// Package hooks 入站事件 Hook（P-20261003-23）：外部事件（CI 失败/监控告警/
// 自托管脚本）→ 工作台通知中心的统一收口，和出站 webhook（P-20261002-31）
// 对称成环。三块面：
//
//   - 入站原语 POST /api/hooks[/:token]（公开注册，独立 hook token 即凭据，
//     LockMiddleware/unlock token 不挡——与 quickdrop 投递原语同级的入站面；
//     无有效凭据一律 401）
//   - 管理面 /api/hook-token（元信息/签发轮换/销毁，api 组内鉴权）
//   - 限流 60 条/分钟（按有效 token 维度；无效凭据按 IP 维度，防随机凭据刷爆
//     限流器 key 空间）——复用 middleware.RateLimitMiddleware 既有固定窗实现
//
// 请求体白名单 {title, body?, category?, action?}：只读取这四个字段，未知字段
// 忽略（外部胶水常把整包 CI 事件直接 POST 上来，严格拒绝会让人先写转换脚本）。
// action 接受 `panel:<白名单面板>` 与 `url:<http(s) 链接>`（P-20261003-164，
// 域白名单双闸见 parseURLAction）——通知动作是前端可执行路由/跳转，任意
// action 等于把通知中心变成任意功能入口，故白名单收口（panel 枚举 = deploy/
// share-manager 先例 + 侧栏/底部面板注册名；url 域清单默认空 = 关闭）。
package hooks

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// HeaderToken 凭据载体的首选通道：header 不进 URL/访问日志，是推荐形态；
// URL 段载体兼容保留（设置页示例可照抄），访问日志由 share.RedactLogLine
// 统一打码（P-20261002-95 教训，P-20261003-23 扩面）
const HeaderToken = "X-Hook-Token"

const (
	// hookMaxBody 入站请求体上限：事件载荷是通知级短文本，16KB 给 JSON 包裹
	// 留足余量；解析前经 shared.LimitBody 置位，超限 413
	hookMaxBody = 16 << 10
	// hookMaxTitleRunes / hookMaxBodyRunes 通知条目展示上限：标题是单行摘要、
	// 正文进通知面板与 webhook 外发，超长内容截断而非拒收（事件语义不因
	// 文案过长丢失）
	hookMaxTitleRunes = 200
	hookMaxBodyRunes  = 4000
	// panelActionPrefix 通知动作的 panel 前缀（Notification.Action="panel" +
	// ActionPayload=<面板名> 是前端既有消费形态，P-31 部署通知同款）
	panelActionPrefix = "panel:"
	// urlActionPrefix 通知动作的 url 前缀（P-20261003-164）：CI 失败「打开
	// CI 页面」类外链跳转。放行边界双闸：仅 http(s) 协议（javascript:/data:
	// 伪协议由 scheme 白名单拒绝，与 agent 侧 isHTTPExternalURL 同哲学）+
	// host 命中允许域清单（config.Server.HookURLAllowHosts，空清单 = url
	// 动作整体关闭，仅 panel: 现状零变化）。前端消费链 Notification.Action=
	// "url" + ActionPayload=<完整链接> → window.open(url, "_blank",
	// "noopener") 已由 P-20261007-15 落地，本侧只需放行入站
	urlActionPrefix = "url:"
)

// allowedPanels 通知动作可直达的面板白名单：侧栏六视图 + 底部 git/terminal
// + deploy/share-manager（非注册面板，前端 togglePanel 分支单独接）。与
// web/src/composables/useLayoutShell.ts 的 togglePanel 消费面同源维护。
var allowedPanels = map[string]struct{}{
	"files": {}, "changes": {}, "todos": {}, "notes": {}, "stream": {}, "env": {},
	"git": {}, "terminal": {},
	"deploy": {}, "share-manager": {},
}

// allowedCategories 可入账的通知类别（Notification.Add 的偏好开关与前端
// 筛选按此值域工作）；未识别的 category 回落 system，不让分类噪声拒收事件
var allowedCategories = map[string]struct{}{
	notification.CategoryGit: {}, notification.CategoryTask: {},
	notification.CategoryClone: {}, notification.CategorySystem: {},
	notification.CategoryError: {},
}

// tokenFrom 解析凭据：X-Hook-Token header 优先（主推载体），URL 段兼容兜底。
// 两处都不做存在性/格式判断——无效值统一由 Validate 判 401
func tokenFrom(c *gin.Context) string {
	if t := strings.TrimSpace(c.GetHeader(HeaderToken)); t != "" {
		return t
	}
	return strings.TrimSpace(c.Param("token"))
}

// looksLikeToken 快速形态判定（sch_ + 32 位 hex）。仅用于限流分桶：格式都
// 不对的值按来源 IP 合桶，避免随机凭据每请求一个新 key 撑大 RateLimiter
func looksLikeToken(raw string) bool {
	return len(raw) == 4+32 && strings.HasPrefix(raw, "sch_")
}

// RateLimitKey 限流维度：有效凭据按 token 哈希（不把明文留在限流器内存里），
// 无效/缺失凭据按客户端 IP——固定窗口 60 次/分钟（P-20261003-23 用户拍板）
func RateLimitKey(c *gin.Context) string {
	tok := tokenFrom(c)
	if looksLikeToken(tok) && store.Get() != nil && store.Get().HookToken.Validate(tok) {
		sum := sha256.Sum256([]byte(tok))
		return "hook:" + hex.EncodeToString(sum[:8])
	}
	return "ip:" + c.ClientIP()
}

// PostHook POST /api/hooks[/:token]——入站事件原语（公开端点）。
// 凭据无效/未签发/已销毁一律 401（用户拍板的主动销毁语义：无有效 token 时
// 入站整体关闭）；合法事件经 Notification.Add 入账，站内通知 / WS 广播 /
// 出站 webhook 三条下游通道自然跟随既有语义。
// 错误响应刻意不经 shared.Error：其错误日志会拼 c.Request.URL.Path，URL 载体
// 形态下等于把凭据打进日志（P-95 教训）
func PostHook(c *gin.Context) {
	shared.LimitBody(c, hookMaxBody)
	st := store.Get()
	if st == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "store unavailable"})
		return
	}
	if !st.HookToken.Validate(tokenFrom(c)) {
		// 401 而非 404：端点存在性不是秘密，凭据才是门禁（与 quickdrop 的
		// 404 隐身在产品语义上不同——Hook 是给脚本看的稳定端点）
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or missing hook token"})
		return
	}
	var req struct {
		Title    string `json:"title"`
		Body     string `json:"body"`
		Category string `json:"category"`
		Action   string `json:"action"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("request body exceeds %d bytes", hookMaxBody)})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	title := sanitizeSingleLine(req.Title)
	if title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title is required"})
		return
	}
	action, actionPayload, ok := parseAction(req.Action)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "action must be panel:<allowed panel> or url:<http(s) url in allowlist>"})
		return
	}
	category := normalizeCategory(req.Category)
	st.Notification.Add(notification.Notification{
		// type 不在 body 白名单内：由 category 派生——error 类事件（CI 失败/
		// 监控告警）落 error 使出站 webhook 的 important 范围能自然外发
		Type:          typeForCategory(category),
		Category:      category,
		Title:         clampRunes(title, hookMaxTitleRunes),
		Body:          clampRunes(sanitizeMultiline(req.Body), hookMaxBodyRunes),
		Action:        action,
		ActionPayload: actionPayload,
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// GetHookToken GET /api/hook-token——凭据元信息（不含明文）
func GetHookToken(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": store.Get().HookToken.Meta()})
}

// RotateHookToken POST /api/hook-token/rotate——签发/轮换（无凭据即签发，
// 已有则旧值立即失效；明文仅本次响应出现一次）。动作入审计，明文绝不入账
func RotateHookToken(c *gin.Context) {
	existed := store.Get().HookToken.Meta().Exists
	plain, err := store.Get().HookToken.Rotate()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "hook token operation failed", err)
		return
	}
	action := "created"
	if existed {
		action = "rotated"
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHookTokenRotate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: action,
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"token": plain,
		"meta":  store.Get().HookToken.Meta(),
	}})
}

// RevokeHookToken DELETE /api/hook-token——主动销毁（入站立即整体关闭）。
// 审计只记动作与来源 IP，不含任何凭据材料
func RevokeHookToken(c *gin.Context) {
	if err := store.Get().HookToken.Revoke(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "hook token operation failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHookTokenRevoke,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// parseAction 通知动作白名单解析：空值 = 无动作；panel: 前缀按面板枚举、
// url: 前缀按协议+域白名单双闸（见 parseURLAction），其余一律拒绝（防
// 「通知」被用作任意前端路由/外链入口）
func parseAction(raw string) (action, payload string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", true
	}
	if strings.HasPrefix(raw, panelActionPrefix) {
		name := strings.TrimSpace(strings.TrimPrefix(raw, panelActionPrefix))
		if _, allowed := allowedPanels[name]; !allowed {
			return "", "", false
		}
		return "panel", name, true
	}
	if strings.HasPrefix(raw, urlActionPrefix) {
		return parseURLAction(strings.TrimSpace(strings.TrimPrefix(raw, urlActionPrefix)))
	}
	return "", "", false
}

// allowedURLHosts 允许域清单读取注入口（单测可换——RepoWatcher.fallbackBroadcast
// 同款惯例）：生产实现现读设置，入站每请求解析一次、读内存配置零开销，设置
// 保存即时生效无需重启。store 未装配时返回 nil（url 动作关闭，安全默认）
var allowedURLHosts = func() []string {
	if st := store.Get(); st != nil {
		return st.Settings.Get().Server.HookURLAllowHosts
	}
	return nil
}

// parseURLAction URL 动作白名单（P-20261003-164）：仅 http(s) 绝对链接 + host
// 命中允许域清单。匹配口径与 config.NormalizeHookURLAllowHosts 归一口径同源
// （url.Hostname() 小写、不限端口）；userinfo/@ 混淆形态由解析后取 Hostname()
// 天然免疫——`https://ci.example.com@evil.com/` 的 Hostname 是 evil.com，不
// 命中清单。禁空白/控制符（URL 内嵌空白是解析歧义面，与 agent 侧
// isHTTPExternalURL 同理由）。payload 存完整链接原样交前端 window.open
func parseURLAction(raw string) (action, payload string, ok bool) {
	if raw == "" {
		return "", "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Host == "" {
		return "", "", false
	}
	for _, r := range raw {
		if r <= ' ' || r == 0x7f {
			return "", "", false
		}
	}
	host := strings.ToLower(u.Hostname())
	allowed := allowedURLHosts()
	for _, h := range allowed {
		if h == host {
			return "url", raw, true
		}
	}
	return "", "", false
}

// normalizeCategory 类别归一：小写去空白后命中已知类别，否则回落 system
func normalizeCategory(raw string) string {
	cat := strings.ToLower(strings.TrimSpace(raw))
	if _, ok := allowedCategories[cat]; ok {
		return cat
	}
	return notification.CategorySystem
}

func typeForCategory(category string) string {
	if category == notification.CategoryError {
		return "error"
	}
	return "info"
}

// sanitizeSingleLine 控制字符折叠为空格（标题单行展示；防 ANSI/换行把通知
// 面板行结构打乱——quickdrop dropBrief 同款）
func sanitizeSingleLine(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s))
}

// sanitizeMultiline 保留换行/制表符的多行文本消毒：其余 C0 控制字符折叠为
// 空格（正文允许换行展示，但不允许 ESC 序列/回车覆盖进入通知面板与 webhook）
func sanitizeMultiline(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s))
	return s
}

// clampRunes 按 rune 截断（CJK 与 emoji 不切半个字符），超限加省略号
func clampRunes(s string, max int) string {
	if max <= 0 || utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max]) + "…"
}
