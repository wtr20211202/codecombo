package agentcron

import (
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/agentops"
	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 定时任务 CRUD（P-20261002-43）。模型与约束见 server/store/agentcron.go：
// ID 服务端生成（sc_cron_）、运行期事实仅调度器可写（RecordRun）、字段级
// 校验在本层（name/时刻/周几/prompt 字节上限/运行时白名单/dir 存在性）。

const (
	// cronNameMax 名称 rune 上限
	cronNameMax = 120
	// cronPromptMax prompt UTF-8 字节上限（与 agent 会话 launchArgs 服务端
	// 上限同口径，terminal.go launchArgs > 500 拒绝）。配额按存储态模板计：
	// {date}/{time}/{weekday} 变量触发时才展开（cron.go expandPromptVars，
	// 单枚增量有界），展开后形态是注入面事实（注记口径，P-20261003-167）
	cronPromptMax = 500
	// cronTimezoneMax 时区名 rune 上限（IANA 名实测最长 32 左右，64 为宽裕
	// 护栏——真实校验在 LoadLocation，超长只防脏数据入库）
	cronTimezoneMax = 64
)

// cronIDRe 任务 ID 白名单（sc_cron_ + uuid，防路径穿越形态）
var cronIDRe = regexp.MustCompile(`^sc_cron_[A-Za-z0-9-]{1,64}$`)

// cronItem 列表/详情载荷：任务本体 + 服务端计算的下次触发预览（预览算法
// 与调度判定共用同一实现，前端不做第二份 cron 逻辑）。LastRunAt 以指针影写
// 内嵌同名字段：零值 time.Time 不受 omitempty 约束，原样序列化会让前端把
// 「从未运行」渲染成 0001-01-01
type cronItem struct {
	store.AgentCron
	NextRunAt *time.Time `json:"nextRunAt"`
	LastRunAt *time.Time `json:"lastRunAt,omitempty"`
	// Metric 指标时序（P-20261005-237，随任务 API 透出——agent 巡检可编程
	// 读「构建时长趋势」做回归告警）：配置了 extract 且已有抽取点时非 nil，
	// 否则缺省（「无数据」= 键缺席，绝不以空数组/零值冒充）
	Metric *cronMetricSeries `json:"metric,omitempty"`
}

// cronMetricSeries 指标时序段：name 为指标名（规则派生），Points 时间升序
// （旧→新）——趋势消费方直读无需再排序
type cronMetricSeries struct {
	Name   string                  `json:"name"`
	Points []store.CronMetricPoint `json:"points"`
}

// metricSeriesOf 组装任务的指标时序段：无规则/无点位返回 nil（载荷缺省键）。
// 读取按任务隔离（一任务一文档），仅配置了 extract 的任务有此读开销
func metricSeriesOf(t store.AgentCron) *cronMetricSeries {
	if t.Extract == "" {
		return nil
	}
	hist := store.Get().CronMetric.History(t.ID, 0)
	if len(hist) == 0 {
		return nil
	}
	// 存储倒序（最新在前）→ 载荷升序（旧→新）
	pts := make([]store.CronMetricPoint, len(hist))
	for i, p := range hist {
		pts[len(hist)-1-i] = p
	}
	return &cronMetricSeries{Name: ExtractMetricName(t.Extract), Points: pts}
}

func toItem(t store.AgentCron, now time.Time) cronItem {
	item := cronItem{AgentCron: t}
	// 前序完成触发任务没有「下次运行」时刻概念（事件驱动），预览置空，
	// 前端渲染为 —；预览按任务评估时区逐日探测（P-20261005-217），与调度
	// 判定同源同区
	if !t.IsAfterTrigger() {
		next := NextRunAt(t.Hour, t.Minute, t.Weekdays, now.In(TaskLocation(t.Timezone)))
		item.NextRunAt = &next
	}
	if !t.LastRunAt.IsZero() {
		last := t.LastRunAt
		item.LastRunAt = &last
	}
	item.Metric = metricSeriesOf(t)
	return item
}

// validateCronPayload 校验并归一化用户可编辑字段；返回首个错误的用户可读信息
func validateCronPayload(t *store.AgentCron) string {
	t.Name = strings.TrimSpace(t.Name)
	if t.Name == "" {
		return "name is required"
	}
	if utf8.RuneCountInString(t.Name) > cronNameMax {
		return "name too long"
	}
	if t.Hour < 0 || t.Hour > 23 {
		return "hour out of range"
	}
	if t.Minute < 0 || t.Minute > 59 {
		return "minute out of range"
	}
	// 周几集合归一：去重、排序、越界剔除
	seen := map[int]bool{}
	weekdays := make([]int, 0, len(t.Weekdays))
	for _, d := range t.Weekdays {
		if d < 0 || d > 6 || seen[d] {
			continue
		}
		seen[d] = true
		weekdays = append(weekdays, d)
	}
	sort.Ints(weekdays)
	t.Weekdays = weekdays

	// 评估时区（P-20261005-217）：可选 IANA 名，空 = 服务器本地（存量语义
	// 不变）。LoadLocation 前置校验——非法名在保存口拒绝（前端表单同验），
	// 运行期解析不可能失败，TaskLocation 的回落分支只剩平台 tz 数据缺失的
	// 兜底语义
	t.Timezone = strings.TrimSpace(t.Timezone)
	if t.Timezone != "" {
		if utf8.RuneCountInString(t.Timezone) > cronTimezoneMax {
			return "timezone too long"
		}
		if _, err := time.LoadLocation(t.Timezone); err != nil {
			return "unknown timezone"
		}
	}

	t.Runtime = strings.TrimSpace(t.Runtime)
	switch t.Runtime {
	case "", "auto", "shell":
	default:
		if !agentops.IsRegisteredProvider(t.Runtime) {
			return "unknown runtime"
		}
	}
	t.Prompt = strings.TrimSpace(t.Prompt)
	if t.Prompt == "" {
		return "prompt is required"
	}
	if len(t.Prompt) > cronPromptMax {
		return "prompt too long"
	}
	t.Dir = strings.TrimSpace(t.Dir)
	if t.Dir != "" {
		if fi, err := os.Stat(t.Dir); err != nil || !fi.IsDir() {
			return "dir does not exist"
		}
	}
	// 接力源（P-20261005-207）：形态校验（空/latest/显式会话 ID），不做源会话
	// 存在性校验——源可晚于任务创建，失效由触发期降级兜底（relay.go 注记）
	t.RelayFrom = strings.TrimSpace(t.RelayFrom)
	if !validRelayFrom(t.RelayFrom) {
		return "relayFrom too long"
	}
	// 指标抽取规则（P-20261005-237）：保存口压实形态（正则可编译 + 命名捕获组
	// / json: 路径段非空），运行期只可能「无数据」不可能「坏规则」
	if msg := validateExtract(&t.Extract); msg != "" {
		return msg
	}
	return validateTrigger(t)
}

// validateTrigger 触发类型与依赖链字段校验归一（P-20261003-124）：
//   - 空/schedule = 定时（既有任务零迁移，旧数据无 trigger 字段读出即空）；
//     定时任务上的依赖字段清空——类型来回切换不留脏指向
//   - after = 前序完成触发：父任务必填（存在性与成环在 Create/Update 持
//     store 列表后校验，本函数只做无库字段归一）；档位空 = success
func validateTrigger(t *store.AgentCron) string {
	switch t.Trigger {
	case "", store.CronTriggerSchedule:
		t.Trigger = store.CronTriggerSchedule
		t.AfterCronID = ""
		t.AfterMode = ""
	case store.CronTriggerAfter:
		t.AfterCronID = strings.TrimSpace(t.AfterCronID)
		if t.AfterCronID == "" {
			return "parent cron is required for after-trigger"
		}
		switch t.AfterMode {
		case "", store.CronAfterSuccess:
			t.AfterMode = store.CronAfterSuccess
		case store.CronAfterAlways:
		default:
			return "unknown after mode"
		}
	default:
		return "unknown trigger type"
	}
	return ""
}

// validateChain 依赖链保存口校验（父存在 + 链上溯无环）。crons 为当前全量
// 列表；selfID 为被编辑任务 ID（新建传空串——新 ID 服务端生成、尚不在链上，
// 恒不成环，仍校验父存在性）。必须在 validateTrigger 之后调用（after 任务
// 才有父指向语义）
func validateChain(crons []store.AgentCron, selfID, parentID string) string {
	exists := false
	for _, c := range crons {
		if c.ID == parentID {
			exists = true
			break
		}
	}
	if !exists {
		return "parent cron not found"
	}
	if ChainHasCycle(crons, selfID, parentID) {
		return "cron dependency chain would form a cycle"
	}
	return ""
}

// serverTimezoneInfo 服务器时区快照（P-20261005-217 列表载荷增量键 server，
// 旧前端零触及）：跨时区部署的「对表」数据面——用户一眼对出「服务器说的
// 9 点」是几点。Name 为本地时区名（TZ 未设时 Go 报 "Local"，仅展示参考不
// 参与判定）；Now 为 RFC3339 带数字偏移（壁钟部分即服务器本地时刻，前端
// 直读无需换算）；UTCOffset 归一形态（+08:00）供徽标/标注拼接
func serverTimezoneInfo(now time.Time) gin.H {
	return gin.H{
		"name":      time.Local.String(),
		"now":       now.Format(time.RFC3339),
		"utcOffset": now.Format("-07:00"),
	}
}

// ListCrons GET /api/agent-crons
func ListCrons(c *gin.Context) {
	crons, err := store.Get().AgentCron.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent cron operation failed", err)
		return
	}
	now := time.Now()
	items := make([]cronItem, 0, len(crons))
	for _, t := range crons {
		items = append(items, toItem(t, now))
	}
	c.JSON(http.StatusOK, gin.H{"data": items, "server": serverTimezoneInfo(now)})
}

// CreateCron POST /api/agent-crons
func CreateCron(c *gin.Context) {
	var req store.AgentCron
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "agent cron operation failed", err)
		return
	}
	if msg := validateCronPayload(&req); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	if req.IsAfterTrigger() {
		crons, err := store.Get().AgentCron.List()
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "agent cron operation failed", err)
			return
		}
		if msg := validateChain(crons, "", req.AfterCronID); msg != "" {
			shared.Error(c, http.StatusBadRequest, msg, nil)
			return
		}
	}
	t, err := store.Get().AgentCron.Create(req)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "agent cron operation failed", err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": toItem(*t, time.Now())})
}

// UpdateCron PUT /api/agent-crons/:id（全量替换用户可编辑字段，运行期事实保留）
func UpdateCron(c *gin.Context) {
	id := c.Param("id")
	if !cronIDRe.MatchString(id) {
		shared.Error(c, http.StatusBadRequest, "invalid cron id", nil)
		return
	}
	var req store.AgentCron
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "agent cron operation failed", err)
		return
	}
	if msg := validateCronPayload(&req); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	if req.IsAfterTrigger() {
		crons, err := store.Get().AgentCron.List()
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "agent cron operation failed", err)
			return
		}
		if msg := validateChain(crons, id, req.AfterCronID); msg != "" {
			shared.Error(c, http.StatusBadRequest, msg, nil)
			return
		}
	}
	t, err := store.Get().AgentCron.Update(id, req)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "agent cron not found", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": toItem(*t, time.Now())})
}

// DeleteCron DELETE /api/agent-crons/:id。有子任务（after 指向本任务）拒绝
// 删除：级联链中段删除会让子任务悬空（永不再触发且无提示），强制先解除或
// 删除子任务——显式处置优于静默失联
func DeleteCron(c *gin.Context) {
	id := c.Param("id")
	if !cronIDRe.MatchString(id) {
		shared.Error(c, http.StatusBadRequest, "invalid cron id", nil)
		return
	}
	if crons, err := store.Get().AgentCron.List(); err == nil {
		for _, dep := range crons {
			if dep.IsAfterTrigger() && dep.AfterCronID == id {
				shared.Error(c, http.StatusConflict, "cron has dependent tasks (re-point or delete them first)", nil)
				return
			}
		}
	}
	if err := store.Get().AgentCron.Delete(id); err != nil {
		shared.Error(c, http.StatusNotFound, "agent cron not found", err)
		return
	}
	// 指标时序级联清理（P-20261005-237：一任务一文档，随任务同生命周期）
	store.Get().CronMetric.Delete(id)
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// RunCron POST /api/agent-crons/:id/run 立即试跑：与到期触发同一执行链
// （prompt 组装/lastRunAt 记账/失败入账一致），不做当日去重拦截
func RunCron(c *gin.Context) {
	id := c.Param("id")
	if !cronIDRe.MatchString(id) {
		shared.Error(c, http.StatusBadRequest, "invalid cron id", nil)
		return
	}
	t, err := store.Get().AgentCron.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "agent cron not found", err)
		return
	}
	res, err := runNow(*t)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "run failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"id":       res.ID,
		"name":     res.Name,
		"path":     res.Path,
		"runtime":  res.Runtime,
		"launched": res.Launched,
	}})
}
