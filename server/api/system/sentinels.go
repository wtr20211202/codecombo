package system

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"codecombo/server/agentops"
	shared "codecombo/server/api/shared"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// sentinelIDRe 哨兵规则 ID 白名单（sc_sn_ + uuid，防路径穿越形态）
var sentinelIDRe = regexp.MustCompile(`^sc_sn_[A-Za-z0-9-]{1,64}$`)

// sentinelScopeRe 作用域取值白名单："global" 或 projectId（字母数字-_，长度
// 限 64——与项目 ID 形态同宽）。空串归一化为 global
var sentinelScopeRe = regexp.MustCompile(`^(global|[A-Za-z0-9_-]{1,64})$`)

// 输出哨兵规则 CRUD（P-20261004-8）。模型与约束见 server/store/sentinels.go：
// ID 服务端生成（sc_sn_）、空字段 patch 不改写、规则数 ≤10 护栏在存储层。
// pattern 写入口编译校验（Go regexp 为 RE2，天然无回溯，无正则 DoS 面）——
// 匹配侧（terminal 包）对编译失败规则跳过兜底，但此处拒绝才是用户可见反馈

const (
	// sentinelNameMax / sentinelPatternMax 字段级上限（pattern 限长防误存
	// 巨型正则；匹配成本由 RE2 线性时间 + 滑窗上限兜底）
	sentinelNameMax    = 120
	sentinelPatternMax = 512
)

func init() {
	// 智能体手册登记：agent 可代用户部署哨兵（"盯 OOM/盯死锁"自然语言一句话
	// → POST 本端点建规则），与 snippets 分节同款形态
	agentops.RegisterSection(agentops.Section{
		ID: "sentinels", Title: "输出哨兵", Order: 78,
		Summary: "终端输出模式订阅：命中正则即入通知中心（盯 OOM/盯死锁等场景）",
		Body: ` - GET    /api/sentinels                     规则列表
- POST   /api/sentinels                     新建 {"name","pattern","scope"?,"level"?}
                 pattern 为 RE2 正则（服务端编译校验，非法回 400）；
                 scope 缺省/"global" = 全部终端会话，传 projectId = 仅该项目会话；
                 level: info|warning|error（缺省 warning，通知条目样式）
- PUT    /api/sentinels/:id                 修改（空字段 = 不改写）
- DELETE /api/sentinels/:id                 删除（规则数上限 10，超限新建回 400）
- POST   /api/sentinels/test                服务端真跑 {"rules":[{"id","pattern"}],"sample"}
                 样例喂进与生产完全相同的滑窗探测器（RE2 精确语义），返回逐规则
                 {"results":[{ruleId,hit,matched?,error?}],truncated}；不落库、
                 不触发通知（一次性探测器实例，无副作用）。error 非空 = 该模式
                 RE2 编译失败。规则不落库即可先试后建；样例钳制 500 行/128KB

## 推荐用法（示例）

0) 自测哨兵规则（写规则 → 贴样例 → 服务端验证 → 再启用）——id 传临时值即可：
` + "```bash" + `
curl -X POST {{BASE}}/api/sentinels/test -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"rules":[{"id":"t1","pattern":"(?i)(out of memory|OOMKilled)"}],"sample":"service started\npanic: container OOMKilled after 3 retries"}'
# → {"data":{"results":[{"ruleId":"t1","hit":true,"matched":"panic: container OOMKilled after 3 retries"}],"truncated":false}}
` + "```" + `

1) 用户说「帮我盯着 OOM」——建全局哨兵，后续任意终端输出命中即通知用户（带直达会话入口）：
` + "```bash" + `
curl -X POST {{BASE}}/api/sentinels -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"name":"盯 OOM","pattern":"(?i)(out of memory|OOMKilled|fatal error: runtime)","level":"error"}'
` + "```" + `

2) 用户说「构建卡死第一时间叫我」——盯死锁/卡住关键词，仅限当前项目会话：
` + "```bash" + `
curl -X POST {{BASE}}/api/sentinels -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"name":"盯死锁","pattern":"fatal error.*deadlock|hang detected","scope":"<projectId>","level":"warning"}'
` + "```" + `

同一规则 5 分钟内只入账一次通知（防刷屏）；命中的通知点击直达触发会话。`,
	})
}

// normalizeSentinelScope 作用域归一化：空 = global（创建路径写 canonical 值，
// GET 回读即明确语义）
func normalizeSentinelScope(scope string) string {
	if strings.TrimSpace(scope) == "" {
		return store.SentinelScopeGlobal
	}
	return strings.TrimSpace(scope)
}

// validateSentinelRule 写入校验：返回首个错误的用户可读信息（空串 = 通过）
func validateSentinelRule(ru store.SentinelRule) string {
	if strings.TrimSpace(ru.Name) == "" {
		return "name is required"
	}
	if utf8.RuneCountInString(ru.Name) > sentinelNameMax {
		return "name too long"
	}
	if strings.TrimSpace(ru.Pattern) == "" {
		return "pattern is required"
	}
	if utf8.RuneCountInString(ru.Pattern) > sentinelPatternMax {
		return "pattern too long"
	}
	if _, err := regexp.Compile(ru.Pattern); err != nil {
		return "invalid pattern: " + err.Error()
	}
	if !sentinelScopeRe.MatchString(normalizeSentinelScope(ru.Scope)) {
		return "invalid scope"
	}
	switch ru.Level {
	case "", store.SentinelLevelInfo, store.SentinelLevelWarn, store.SentinelLevelError:
	default:
		return "invalid level"
	}
	return ""
}

// ListSentinels GET /api/sentinels
func ListSentinels(c *gin.Context) {
	rules, err := store.Get().Sentinel.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "sentinel operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rules})
}

// CreateSentinel POST /api/sentinels
func CreateSentinel(c *gin.Context) {
	var req store.SentinelRule
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "sentinel operation failed", err)
		return
	}
	if msg := validateSentinelRule(req); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Scope = normalizeSentinelScope(req.Scope)
	if req.Level == "" {
		req.Level = store.SentinelLevelWarn // 写 canonical 值，GET 回读即明确语义
	}
	ru, err := store.Get().Sentinel.Create(req)
	if err != nil {
		if errors.Is(err, store.ErrTooManySentinels) {
			shared.Error(c, http.StatusBadRequest, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "sentinel operation failed", err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": ru})
}

// UpdateSentinel PUT /api/sentinels/:id（空字段 = 不改写；pattern 提供即重新编译校验）
func UpdateSentinel(c *gin.Context) {
	id := c.Param("id")
	if !sentinelIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "sentinel not found", nil)
		return
	}
	var req store.SentinelRule
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "sentinel operation failed", err)
		return
	}
	// patch 语义：只校验调用方显式提供的字段（空字段留给存储「不改写」分支；
	// name/pattern 合法性互相独立，无需互相补全样本）
	if req.Name != "" {
		req.Name = strings.TrimSpace(req.Name)
		if req.Name == "" || utf8.RuneCountInString(req.Name) > sentinelNameMax {
			shared.Error(c, http.StatusBadRequest, "invalid name", nil)
			return
		}
	}
	if req.Pattern != "" {
		if utf8.RuneCountInString(req.Pattern) > sentinelPatternMax {
			shared.Error(c, http.StatusBadRequest, "pattern too long", nil)
			return
		}
		if _, err := regexp.Compile(req.Pattern); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid pattern: "+err.Error(), nil)
			return
		}
	}
	if req.Scope != "" && !sentinelScopeRe.MatchString(normalizeSentinelScope(req.Scope)) {
		shared.Error(c, http.StatusBadRequest, "invalid scope", nil)
		return
	}
	switch req.Level {
	case "", store.SentinelLevelInfo, store.SentinelLevelWarn, store.SentinelLevelError:
	default:
		shared.Error(c, http.StatusBadRequest, "invalid level", nil)
		return
	}
	ru, err := store.Get().Sentinel.Update(id, req)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "sentinel not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "sentinel operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": ru})
}

// DeleteSentinel DELETE /api/sentinels/:id
func DeleteSentinel(c *gin.Context) {
	id := c.Param("id")
	if !sentinelIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "sentinel not found", nil)
		return
	}
	if err := store.Get().Sentinel.Delete(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "sentinel not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "sentinel operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "sentinel deleted"})
}

// TestSentinels POST /api/sentinels/test {"rules":[{"id","pattern"}],"sample"}
// 服务端真跑（P-20261004-107）：内联规则经生产同路径滑窗引擎喂样例，RE2 精确
// 语义逐规则返回命中——前端测试框双档之「精确档」（本地 JS 近似档的盲区：
// RE2 专属语法、滑窗口径，恰在此闭合）；也是 agent「写规则→贴样例→服务端
// 验证→启用」编程闭环的原语（手册 sentinel 节已登记）。无副作用面：规则不
// 落库、一次性探测器实例不触通知（引擎侧见 terminal.TestSentinelSample 头注）
func TestSentinels(c *gin.Context) {
	var req struct {
		Rules  []terminal.SentinelProbeRule `json:"rules" binding:"required"`
		Sample string                       `json:"sample"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	// 规则数与模式长度沿写入口同界（SentinelMaxRules / sentinelPatternMax）：
	// 试跑虽无落库面，钳制住编译与扫描的计算上界（引擎侧还有样例行/字节双钳制）
	if len(req.Rules) > store.SentinelMaxRules {
		shared.Error(c, http.StatusBadRequest, store.ErrTooManySentinels.Error(), nil)
		return
	}
	for _, r := range req.Rules {
		if strings.TrimSpace(r.Pattern) == "" {
			shared.Error(c, http.StatusBadRequest, "pattern is required", nil)
			return
		}
		if utf8.RuneCountInString(r.Pattern) > sentinelPatternMax {
			shared.Error(c, http.StatusBadRequest, "pattern too long", nil)
			return
		}
	}
	results, truncated := terminal.TestSentinelSample(req.Rules, []byte(req.Sample))
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"results": results, "truncated": truncated}})
}
