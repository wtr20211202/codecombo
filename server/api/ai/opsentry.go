package ai

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/metrics"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// ============== AI 原生操作入口 ==============
// 本系统把「AI 可操作的全部能力」以操作手册（操作清单）形式对外开放，
// 环境内既有 agent（Claude Code / dsh / DeepSeek Harness…）读手册即可直接调用
// REST API 完成配置与操作；并经 /ws/ops-channel 智能操作通道接收前端联动指令。
// 应用内不实现 Agent Loop——复用环境已有的 agent，这里只提供协议与通道。
//
// 扩展点：手册内容来自 agentops 分节注册表（agentops.RegisterSection）。
// 新增后端能力域时注册一节，/ops-manual 与 SKILL.md 自动包含，无需改本文件。

// OpsNotify 外部 Agent / 前端发布前端联动指令。
// 路由：POST /api/ops-notify（需解锁 token）
//
//	body: { "type": "navigate|notify|projects.changed|settings.changed|自定义", "payload": {...} }
//
// 约束：type 保留字（system 前缀）不可用；payload 需 JSON 对象；
// 内置事件（preview.port / task.progress 等）的载荷在发布口就地校验——坏载荷
// 400 退回，不让畸形数据进广播流（前端各消费分支无需重复防呆）；
// 尺寸限制：请求体 64KB 封顶（LimitBody 超限 413），通知文本字段（task.progress
// 步骤名 / preview.port label）各 4096 字节封顶（超限 400）——通知是短文本语义，
// 尺寸墙防单条巨型载荷经 BroadcastEvent 对全部客户端 JSON marshal 的内存放大
// （三层防护收口：P-91 限频率 × 本墙限尺寸 × P-32 限 WS 读帧）；
// 频率限制：按会话维度 60 条/分钟，超限静默丢弃 + 每窗口一条回告（见下方限流节）。
func OpsNotify(c *gin.Context) {
	shared.LimitBody(c, opsNotifyMaxBody)
	var req struct {
		Type    string      `json:"type" binding:"required"`
		Payload interface{} `json:"payload"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.ErrorWithCode(c, shared.CodeOpsPayloadTooLarge, "ops notify payload too large",
				fmt.Errorf("request body exceeds %d bytes", opsNotifyMaxBody))
			return
		}
		shared.ErrorWithCode(c, shared.CodeOpsPayloadInvalid, "ops notify failed", err)
		return
	}
	req.Type = strings.TrimSpace(req.Type)
	if len(req.Type) == 0 || len(req.Type) > 64 || strings.HasPrefix(req.Type, opschannel.SystemEventPrefix) {
		shared.ErrorWithCode(c, shared.CodeOpsEventTypeInvalid, "invalid event type", nil)
		return
	}
	if req.Type == opschannel.EventPreviewPort {
		p, ok := decodePreviewPortPayload(req.Payload)
		if !ok {
			shared.ErrorWithCode(c, shared.CodeOpsEventPayloadInvalid, "invalid preview.port payload: port must be an integer in [1024, 65535], hostId (optional) max 128 chars, label (optional) max 4096 bytes", nil)
			return
		}
		req.Payload = p
		// 端口注册表登记（P-20261003-293）：探测/上报两路统一登记口的上报侧。
		// 会话归属取 X-Session-ID 头（手册约定 agent 全量携带，CC_TERMINAL_ID
		// 注入值的同款；与下方限流维度同源）；缺头=无法归属，只广播不登记——
		// 挂不到会话的条目等不到「会话关闭即摘除」，反成幽灵占用。
		// hostId 在位 = 端口在远程主机回环上（隧道穿透场景），不进本机注册表：
		// 冲突语义按主机成立，异主机同端口号并非本机 EADDRINUSE。登记在限流
		// 判定之前：端口被真实占用是既成事实，超限丢弃只该影响广播面
		if p.HostID == "" {
			terminal.DefaultManager.RegisterDevPort(strings.TrimSpace(c.GetHeader("X-Session-ID")), p.Port, p.Label, terminal.PortSourceReported)
		}
	}
	if req.Type == opschannel.EventTaskProgress {
		p, ok := normalizeTaskProgressSteps(req.Payload)
		if !ok {
			shared.ErrorWithCode(c, shared.CodeOpsEventPayloadInvalid, "invalid task.progress payload: steps must be an array of at most 20 {name, done} items with non-empty name of at most 4096 bytes", nil)
			return
		}
		req.Payload = p
	}
	// 原子呈现能力注册表校验（P-20261022-3）：open-file-at / watch.invite /
	// notify.persist / locate-in-tree 的载荷校验函数与手册文案同源收编在
	// agentops 注册表——发布口只保留「伴生副作用耦合」的两个特判（上方
	// preview.port 端口登记、task.progress 步骤规整）。坏载荷 400 退回：
	// message 是注册表冻结的原文（e2e 逐字断言，agent 侧分支依据不漂移）
	if atom := agentops.AtomForEvent(req.Type); atom != nil && atom.Validate != nil {
		p, ok := atom.Validate(req.Payload)
		if !ok {
			shared.ErrorWithCode(c, shared.CodeOpsEventPayloadInvalid, atom.InvalidPayloadMessage, nil)
			return
		}
		req.Payload = p
	}
	// 频率限制（P-20261002-91 防上报风暴）：超限静默丢弃 + 按维度节流回告。
	// 限流在载荷校验之后——400 退回的坏请求不占用发布预算
	key := opsNotifyRateKey(c, req.Payload)
	if count := opsNotifyLimiter.Hit(key); count > opsNotifyRateLimit {
		notifyOpsNotifyLimited(key, count)
		// 静默丢弃仍回 200（与正常发布同响应）：错误响应会诱发 agent 重试
		// 放大风暴；守规矩的 agent 经 ops-channel 上的回告事件感知自纠
		c.JSON(http.StatusOK, gin.H{"message": "event published"})
		return
	}
	// task.progress 终态顺带结论摘要（P-20261005-221）：在限流放行之后——
	// 被丢弃的上报不花摘要提取的 IO（transcript 尾读）；尽力而为，失败不拒上报
	if req.Type == opschannel.EventTaskProgress {
		attachTaskProgressSummary(req.Payload)
	}
	// notify.persist 服务端入账（P-20261007-10 通知入账原语）：同样在限流放行
	// 之后——被丢弃的上报不入账（入账与广播面同预算，风暴打不穿通知中心）。
	// 入账先于广播：通知中心 WS/webhook 链由 store.Add 的出站口自行驱动，
	// 广播只承载前端实时弹面；类别静音命中时不入账也不弹面（同偏好过滤
	// 贯穿实时面），响应仍 200（与限流丢弃同款静默语义）
	if req.Type == opschannel.EventNotifyPersist {
		if !persistNotify(req.Payload.(agentops.NotifyPersistPayload)) {
			c.JSON(http.StatusOK, gin.H{"message": "event published"})
			return
		}
	}
	// task.progress 最近上报缓存（P-20261004-120）：发布口旁挂登记——缓存面
	// 与广播面同拍（限流丢弃不入缓存、摘要附加后在册），会话归属取
	// X-Session-ID 头、载荷 terminalId/sessionId 兜底
	if req.Type == opschannel.EventTaskProgress {
		rememberLastProgress(c.GetHeader("X-Session-ID"), req.Payload)
	}
	opschannel.BroadcastEvent(req.Type, req.Payload)
	c.JSON(http.StatusOK, gin.H{"message": "event published"})
}

// previewPortPayload preview.port 事件载荷（P-20261002-70）：agent 把 dev server
// 跑起来后上报一次，前端通知中心 + 悬浮球出现「预览 :N」直达底部预览面板。
// label 可选：服务简称（如 "vite dev server"），通知文案里原样展示。
// hostId 可选（P-20261004-5）：服务跑在远程主机终端里时携带——port 是远端
// 回环端口，前端据此开 SSH 隧道拿本机映射口再进预览面板（「remote:N →
// local:M」徽标）；缺省 = 本机实例端口，直达 /preview/:port
type previewPortPayload struct {
	Port   int    `json:"port"`
	Label  string `json:"label"`
	HostID string `json:"hostId"`
}

// 发布口尺寸墙（P-20261004-130）：ops-notify 逐字段校验（type/hostId/steps 数）
// 之外补总载荷与文本字段上限。三层防护的发布口一层——P-91 限频率、P-32 限
// WS 读帧已就位，此前单条巨型载荷通过校验即广播，是 BroadcastEvent 对全部
// 客户端 JSON marshal 的内存放大面。
const (
	// opsNotifyMaxBody 请求体总限：64KB 对通知文本语义充裕（正常通知/进度上报
	// 远低于此），与终端广播 data 单次上限（broadcastMaxData）同量级
	opsNotifyMaxBody = 64 * 1024
	// opsNotifyTextMax 展示型文本字段字节上限（task.progress steps[].name /
	// preview.port label）：4KB 远超任何正常通知文案，超限即畸形上报。
	// 字节而非 rune：与 opsmessage bodyMax / ops-ask 各字段上限同口径（len）
	opsNotifyTextMax = 4096
)

// decodePreviewPortPayload 校验并规整 preview.port 载荷：
// port 必填且为 1024~65535 的整数（回环高位段，与预览面板输入同口径）；
// hostId 可选，仅做形态校验（长度上限，存在性由隧道端点创建时校验——
// 发布口不依赖 remote store，保持事件通道解耦）；label 可选展示文本，
// 同受 opsNotifyTextMax 封顶（通知文案原样展示，巨型串即畸形上报）。
// 二次编解码而非 map 断言：JSON 数字反序列化为 float64，类型断言会把 3000.5
// 这类小数误当合法端口，int 字段 unmarshal 天然拒绝非整数
func decodePreviewPortPayload(payload interface{}) (previewPortPayload, bool) {
	var p previewPortPayload
	raw, err := json.Marshal(payload)
	if err != nil {
		return p, false
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false
	}
	if p.Port < 1024 || p.Port > 65535 {
		return p, false
	}
	p.HostID = strings.TrimSpace(p.HostID)
	if len(p.HostID) > 128 {
		return p, false
	}
	if len(p.Label) > opsNotifyTextMax {
		return p, false
	}
	return p, true
}

// ============== task.progress 结构化步骤清单（P-20261004-7） ==============

// taskProgressStep task.progress.steps 清单项：结构化步骤清单让悬浮球/值班大屏
// 除「当前在哪一步」外还能呈现「共几步、完成几步」——计划可见性即长任务可信度
type taskProgressStep struct {
	Name string `json:"name"`
	Done bool   `json:"done"`
}

// taskProgressStepsMax 清单长度上限：悬浮件是扫读面而非计划文档，超过即畸形上报
const taskProgressStepsMax = 20

// normalizeTaskProgressSteps 就地校验并规整 task.progress 载荷的 steps 字段：
// 在位且非 null 时必须是 ≤20 项的对象数组，每项含非空字符串 name（规整为去空白，
// 长度受 opsNotifyTextMax 封顶——悬浮件是扫读面，巨型步骤名即畸形上报）与可选
// 布尔 done（缺省 false）——畸形 400 退回不进广播流（同 preview.port 纪律）。
// 只重写 steps 键、其余字段（含 id 等扩展字段）原样保留：发布口全量重建会丢
// 未知字段，且下游限流维度取 payload.sessionId 依赖 map 形态（无 X-Session-ID
// 头的会话记账）；steps 缺省/null 的载荷原样透传，既有上报零变化
func normalizeTaskProgressSteps(payload interface{}) (interface{}, bool) {
	m, ok := payload.(map[string]interface{})
	if !ok {
		return payload, true
	}
	raw, present := m["steps"]
	if !present || raw == nil {
		return payload, true
	}
	arr, ok := raw.([]interface{})
	if !ok || len(arr) > taskProgressStepsMax {
		return payload, false
	}
	steps := make([]taskProgressStep, 0, len(arr))
	for _, item := range arr {
		im, ok := item.(map[string]interface{})
		if !ok {
			return payload, false
		}
		name, _ := im["name"].(string)
		name = strings.TrimSpace(name)
		if name == "" || len(name) > opsNotifyTextMax {
			return payload, false
		}
		done := false
		if d, present := im["done"]; present && d != nil {
			b, ok := d.(bool)
			if !ok {
				return payload, false
			}
			done = b
		}
		steps = append(steps, taskProgressStep{Name: name, Done: done})
	}
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	out["steps"] = steps
	return out, true
}

// ============== open-file-at / watch.invite / notify.persist / locate-in-tree ==============
//
// 上述四个呈现原语的载荷结构体与校验函数已收编 agentops 原子能力注册表
// （P-20261022-3，server/agentops/capabilities.go）——载荷 schema 文档与校验
// 函数单一事实源，手册目录由注册表渲染。本文件保留：
//   - persistNotify（notify.persist 服务端入账，伴生副作用）
//   - 发布限流（下一节）
// preview.port / task.progress 的校验同样留在本文件特判（端口登记 / 步骤规整
// 与终态摘要的副作用耦合），不经注册表。

// persistNotify notify.persist 服务端入账：与系统通知同库同偏好过滤——类别
// 开关在 store.Add 同点判定，此处预查仅用于决定是否广播实时弹面（命中静音
// 返回 false，调用方跳过广播；入账面 store.Add 自身还会再判一次，双查是
// 「过滤语义贯穿实时面」的代价，偏好读取是内存缓存零 IO）。归类 task：agent
// 上报链与任务终态/预览端口通知同门类，「任务」子开关一并管辖
func persistNotify(p agentops.NotifyPersistPayload) bool {
	if !store.Get().Notification.GetPrefs().IsEnabled(notification.CategoryTask) {
		return false
	}
	store.Get().Notification.Add(notification.Notification{
		Type:          p.Level,
		Category:      notification.CategoryTask,
		Title:         p.Title,
		Body:          p.Body,
		Action:        p.Action,
		ActionPayload: p.ActionPayload,
	})
	return true
}

// ============== 发布频率限制（P-20261002-91 防上报风暴） ==============
//
// ops-notify 零限流时，agent 侧 bug 死循环上报（task.progress 每秒百条）会
// 直接变成前端通知轰炸 + WS 广播洪流，且殃及其他会话的广播。agent 代码多为
// 自动生成，无限循环通知正是其高发 bug 形态——通道健壮性需要服务端兜底：
// 超限静默丢弃（不回错误，避免诱发重试放大），并按维度每窗口回告一条
// system:rate-limited 事件供守规矩的 agent 感知自纠；不守的不影响他人。

const (
	// opsNotifyRateLimit 每维度每窗口放行上限：正常进度/事件上报（关键节点才
	// 发、秒级一个）远低于此，只有死循环 bug 才会触顶
	opsNotifyRateLimit = 60
	// opsNotifyWindow 限流窗口长度
	opsNotifyWindow = time.Minute
)

// opsNotifyLimiter 发布准入限流器：复用 middleware.RateLimiter 固定窗口核心
// （与 auth.go IP 限流、ratelimit.go 通用限流同源），按会话维度隔离——
// 单会话风暴只烧自己的预算，不挤占其他会话
var opsNotifyLimiter = middleware.NewRateLimiter(opsNotifyRateLimit, opsNotifyWindow)

// opsNotifyFeedbackGate 回告节流闸门：每维度每窗口仅放行 1 条超限回告事件，
// 防回告自身变成新的广播源
var opsNotifyFeedbackGate = middleware.NewRateLimiter(1, opsNotifyWindow)

// system:rate-limited 回告事件载荷已收编为 opschannel.RateLimitedNotice
// （P-20261004-124，与 opsmessage/搜索限流同形同源），此处直接引用

// opsNotifyRateKey 发布限流维度键：X-Session-ID 头（操作手册建议 agent 全量
// 携带）优先，其次载荷内 sessionId（task.progress 约定字段），再退调用令牌
// （鉴权中间件注入的 tokenID），兜底 ClientIP——同一会话/身份的轰炸共享
// 同一预算，跨身份互不影响
func opsNotifyRateKey(c *gin.Context, payload interface{}) string {
	if sid := strings.TrimSpace(c.GetHeader("X-Session-ID")); sid != "" {
		return "sid:" + sid
	}
	if m, ok := payload.(map[string]interface{}); ok {
		if sid, ok := m["sessionId"].(string); ok {
			if sid = strings.TrimSpace(sid); sid != "" {
				return "sid:" + sid
			}
		}
	}
	if tok := strings.TrimSpace(c.GetString("tokenID")); tok != "" {
		return "tok:" + tok
	}
	return "ip:" + c.ClientIP()
}

// notifyOpsNotifyLimited 超限侧记：丢弃计数进 /api/metrics（超限观测面），
// 回告事件经闸门按维度每窗口放行一条进广播流
func notifyOpsNotifyLimited(key string, count int) {
	metrics.IncCounter("sc_ops_notify_limited_total")
	if opsNotifyFeedbackGate.Hit(key) != 1 {
		return
	}
	dimension, identity := "ip", key
	switch {
	case strings.HasPrefix(key, "sid:"):
		dimension, identity = "session", strings.TrimPrefix(key, "sid:")
	case strings.HasPrefix(key, "tok:"):
		dimension, identity = "token", strings.TrimPrefix(key, "tok:")
	}
	opschannel.BroadcastEvent(opschannel.EventRateLimited, opschannel.RateLimitedNotice{
		Dimension: dimension,
		Key:       identity,
		Dropped:   count - opsNotifyRateLimit, // Hit 恒递增：窗口累计命中数 − 上限 = 已丢弃
		Limit:     opsNotifyRateLimit,
		WindowSec: int(opsNotifyWindow / time.Second),
	})
}

// ============== AI 操作手册 ==============

// GetOpsManual 返回 AI 操作手册（markdown 文本）。
// 路由：GET /ops-manual（?format=skill 返回 SKILL.md 形态，含 front matter）
func GetOpsManual(c *gin.Context) {
	// baseURL 是全部 agent 调用的起点（手册每个端点示例都拼它）：反代终止
	// TLS 的部署形态下硬编码 http:// 会系统性教错 scheme（P-20261004-129），
	// 三态判定收口在 shared.RequestBaseURL
	base := shared.RequestBaseURL(c)

	if c.Query("format") == "skill" {
		skill := agentops.SkillMarkdown(base)
		c.Header("Content-Disposition", "attachment; filename=SKILL.md")
		c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(skill))
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"manual":    agentops.Manual(base),
		"baseURL":   base,
		"updatedAt": time.Now().Format("2006-01-02"),
	}})
}
