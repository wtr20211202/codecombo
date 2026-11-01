package agentchain

// 触发引擎（P-20261004-38 ②③）：复用完成链（P-15）——智能体经 ops-notify 上报
// task.progress 终态时，ai 模块观察者旁路落库（store.AgentTask）、compareexp/
// queue 观察者同流消费，本包观察者追加式挂在同一广播流上：按载荷 terminalId
// 命中链定义 → 判档位 → 构造上下文包（prompt.go）→ LaunchAgentSession 拉起
// 下一棒 → 记账 + 审计 + 通知 + chain.triggered 广播。
//
// 自动拉起会话的三道节制闸（提案红线：自动拉起必须有节制）：
//   1. 源会话存活校验——链源会话关闭/重启后链自动失效（死链不误触发；
//      terminals.changed 快照对账口径的服务端权威位）；
//   2. 同链冷却——一次触发后 triggerCooldown 窗口内同源终态不再触发
//      （防 task.progress 抖动重入，如收尾连报两次 done）；
//   3. 全局链深度上限——链条上的会话数 ≤ MaxChainDepth（A(1)→B(2)→C(3)
//      合法，C 的完成不可再接），防失控级联（死循环接力）。
//
// 拉起的会话是普通 agent 会话：AgentGuard/审批语义全量适用不改（同 agentcron
// 「无人值守不等于免裁」）。观察者在广播方 goroutine 内同步执行（同 queue 引擎），
// 触发频率 = 会话终态频率（低频），launch 的毫秒级串行可接受。

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/opschannel"
	terminalapi "codecombo/server/api/terminal"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

const (
	// MaxChainDepth 全局链深度上限（常量起步，不做每链配置）：深度 = 链条上的
	// 会话数（含最初的用户会话）。用户发起的会话恒为深度 1，链拉起的下一棒 =
	// 源深度 + 1；达到上限的会话完成后不再接续。触发与拉起同锁串行，记账无竞态
	MaxChainDepth = 3

	// triggerCooldown 同链冷却窗口：一次触发后该窗口内的同源终态不再触发。
	// 抖动（收尾连报 done）是秒级形态，1 分钟足量吸收；窗口外同源再次完成 =
	// 用户又派了新活，照常接续（链是长期自动化定义，不是一次性触发器）
	triggerCooldown = time.Minute

	// depthMapCap 链深度记账表容量上限（FIFO 逐出最早）：会话 ID → 深度。
	// 内存态（重启清零——重启后既有会话的深度无从重建，但链源会话同样需经
	// 存活校验才触发，两侧同生共死；重启后的新会话重新从深度 1 起算，三道闸
	// 中冷却与存活校验仍然生效，深度上限在最坏情形放宽为「重启后重新 3 棒」，
	// 属已知边界并写入手册）
	depthMapCap = 512
)

// launcher 会话创建口（生产绑定 terminal.LaunchAgentSession，单测换桩；
// agentcron launcher 同款形态）
type launcher = func(name, runtime, dir, launchArgs string) (*terminalapi.AgentLaunch, error)

// aliveFn 源会话存活判定（生产绑定 terminal.DefaultManager.GetSession != nil，
// 单测换桩；修正项：触发匹配前校验源会话存活，死链不误触发）
type aliveFn = func(sessionID string) bool

// engine 触发引擎：观察者入口 + 三道闸 + 拉起记账。状态量级 = 链深度记账表
// （有界 depthMapCap），锁内全串行（触发是低频事件，launch 毫秒级）
type engine struct {
	launch launcher
	alive  aliveFn
	now    func() time.Time

	mu     sync.Mutex
	depths map[string]int // 会话 ID → 链深度（1 = 用户直接发起；FIFO 上限逐出）
}

func newEngine(launch launcher, alive aliveFn) *engine {
	return &engine{
		launch: launch,
		alive:  alive,
		now:    time.Now,
		depths: map[string]int{},
	}
}

// defaultEngine 包级装配：观察者经此取引擎（模块 Init 装配、Stop 摘除，
// agentcron defaultRunner / terminal defaultQueueEngine 同惯例）
var defaultEngine *engine

func setDefaultEngine(e *engine) { defaultEngine = e }

// taskEventObserver 完成链观察者（模块 Init 注册）：只认 task.progress 的
// done/failed 终结态；载荷 terminalId 归属（与 ai/compareexp 观察者同一
// 拼装事实源——无 terminalId 的上报无从归属，静默跳过）
func taskEventObserver(ev opschannel.Event) {
	e := defaultEngine
	if e == nil || ev.Type != opschannel.EventTaskProgress {
		return
	}
	terminalID, status, task, step := extractTaskProgress(ev.Payload)
	if terminalID == "" || (status != "done" && status != "failed") {
		return
	}
	e.onTaskResult(terminalID, status, task, step)
}

// extractTaskProgress 载荷提取（二次编解码而非 map 断言：广播载荷是
// map[string]interface{} 形态，compareexp.extractTaskProgress 同款；本链额外
// 取 task/step 组上下文三元组）
func extractTaskProgress(payload interface{}) (terminalID, status, task, step string) {
	if payload == nil {
		return "", "", "", ""
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", "", "", ""
	}
	var p struct {
		TerminalID string `json:"terminalId"`
		Status     string `json:"status"`
		Task       string `json:"task"`
		Step       string `json:"step"`
	}
	if json.Unmarshal(b, &p) != nil {
		return "", "", "", ""
	}
	return strings.TrimSpace(p.TerminalID), strings.TrimSpace(p.Status),
		strings.TrimSpace(p.Task), strings.TrimSpace(p.Step)
}

// onTaskResult 终态 → 链触发主链路。链量有 AgentChainKeepMax 上限兜底，
// 线性扫无性能面；同源多条链逐条判定（各自过闸）。
// 全程持 engine.mu：闸判定（冷却读改写 / 深度记账）与拉起记账的原子性由
// 同一把锁保证——并发到达的同源终态不会双双过闸（触发竞态单测钉死）
func (e *engine) onTaskResult(terminalID, status, task, step string) {
	chains, err := store.Get().AgentChain.List()
	if err != nil {
		return // 查询失败不阻塞广播主链路（观察者语义：尽力而为）
	}
	for i := range chains {
		if chains[i].SourceTerminalID != terminalID {
			continue
		}
		e.fire(chains[i].ID, terminalID, status, task, step)
	}
}

// fire 单链触发：锁内重读链定义（并发同源终态都在彼此记账前读表，锁外判定
// 会拿着陈旧的 LastTriggeredAt 全部过闸——冷却/深度闸必须基于锁内最新事实；
// OnFailure 档位与模板同为存储态定义，同以重读结果为准）→ 三道闸 → 展开模板
// → 拉起 → 记账/审计/通知/广播。launch 全程持锁：触发是低频事件（会话终态
// 频率），串行换「闸判定与记账原子」是合算交易。
// 返回是否实际拉起（测试断言用）
func (e *engine) fire(chainID, terminalID, status, task, step string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()

	ch, err := store.Get().AgentChain.Get(chainID)
	if err != nil {
		return false // 判定间隙被删除：静默跳过
	}
	if status != "done" && !ch.OnFailure {
		// onFailure=false（默认）时 failed 不接续——前序失败时后续任务
		// 不应在错误状态上执行（agentcron 依赖链 success 档同语义）
		return false
	}

	// 闸 1：源会话存活（死链不误触发——源会话关闭/重启后链自动失效）
	if !e.alive(terminalID) {
		slog.Debug("agentchain: source session gone, chain inert", "chain", ch.ID, "source", terminalID)
		return false
	}

	// 闸 2：同链冷却（防 task.progress 抖动重入）
	now := e.now()
	if !ch.LastTriggeredAt.IsZero() && now.Sub(ch.LastTriggeredAt) < triggerCooldown {
		slog.Debug("agentchain: chain in cooldown, skip", "chain", ch.ID)
		return false
	}

	// 闸 3：全局链深度上限（防失控级联）
	depth := e.depthOf(terminalID)
	if depth >= MaxChainDepth {
		slog.Info("agentchain: depth cap reached, chain stops here", "chain", ch.ID,
			"source", terminalID, "depth", depth, "cap", MaxChainDepth)
		return false
	}

	launchArgs := ExpandPrompt(ch.PromptTemplate, task, status, step)
	res, err := e.launch("", ch.Runtime, ch.Dir, launchArgs)
	if err != nil {
		// 发起失败记账 + 审计 + 通知（agentcron notifyLaunchFailed 同语义）：
		// 冷却照记（防失败风暴重入——下一棒起不来时同源抖动连发只会反复失败）
		_ = store.Get().AgentChain.RecordTrigger(ch.ID, now, "", storeAgentChainStatusErrorPrefix+err.Error())
		auditChainTrigger(ch.ID, terminalID, status, "", err)
		notifyTriggerFailed(ch, terminalID, err)
		return false
	}

	// 记账：链运行期事实 + 下一棒深度（三道闸的记账面）
	_ = store.Get().AgentChain.RecordTrigger(ch.ID, now, res.ID, statusChainLaunched)
	e.recordDepth(res.ID, depth+1)

	auditChainTrigger(ch.ID, terminalID, status, res.ID, nil)
	notifyTriggered(ch, terminalID, status, res)
	// 链拉起是后台路径（无 HTTP 创建响应），下一棒会话须经 terminals.changed
	// 全量快照广播进前端会话列表——否则值班大屏会话卡/协作流卡接续行的会话
	// 名解析与行点击直达、P-38 接续通知的会话直达全都查无此会话（runbook 执行
	// 现场同一桥，session_snapshot.go BroadcastTerminalsChanged）
	terminalapi.BroadcastTerminalsChanged()
	// chain.triggered 直通分发型广播：agent 感知自己被链拉起（自动化闭环），
	// 前端链列表面板据此外部触发刷新（docs/OPS_EVENTS.md 已登记）
	opschannel.BroadcastEvent(opschannel.EventChainTriggered, map[string]any{
		"chainId":          ch.ID,
		"sourceTerminalId": terminalID,
		"status":           status,
		"sessionId":        res.ID,
		"runtime":          res.Runtime,
	})
	return true
}

// statusChainLaunched / storeAgentChainStatusErrorPrefix 链触发结果词汇
// （LastStatus：launched / error:<摘要>，agentcron LastResult 同形态）
const (
	statusChainLaunched              = "launched"
	storeAgentChainStatusErrorPrefix = "error: "
)

// depthOf 会话链深度：链拉起的会话按记账；无记账 = 用户直接发起的会话，
// 恒为深度 1（链的第一棒）
func (e *engine) depthOf(sessionID string) int {
	if d, ok := e.depths[sessionID]; ok {
		return d
	}
	return 1
}

// recordDepth 记下一棒深度（上限逐出一个最早项：会话 ID 唯一不复用，
// 上限只为内存有界，portregistry 同策略；map 遍历序随机，逐出精度不作承诺）
func (e *engine) recordDepth(sessionID string, depth int) {
	if len(e.depths) >= depthMapCap {
		for k := range e.depths {
			delete(e.depths, k)
			break
		}
	}
	e.depths[sessionID] = depth
}

// auditChainTrigger 触发审计：ID 与档位形态摘要（无内容；通知/列表承载人读面）。
// 接续链由引擎后台拉起（无 *gin.Context），走裸 Append 口 Rid 留零值——
// 双口口径见 middleware.AuditAppend 注释（P-20261006-53）
func auditChainTrigger(chainID, sourceID, status, nextID string, launchErr error) {
	result := store.AuditResultSuccess
	detail := fmt.Sprintf("chain=%s source=%s status=%s next=%s", chainID, sourceID, status, nextID)
	if launchErr != nil {
		result = store.AuditResultFailure
		detail = fmt.Sprintf("chain=%s source=%s status=%s err=%v", chainID, sourceID, status, launchErr)
	}
	store.Get().Audit.Append(store.AuditEvent{
		Action: store.AuditAgentChainTrigger,
		Result: result,
		Detail: detail,
	})
}

// notifyTriggered 接续通知入账：「A 已完成，B 已接续」（Action 直达下一棒会话，
// P-31 terminal action 惯例）
func notifyTriggered(ch *store.AgentChain, sourceID, status string, res *terminalapi.AgentLaunch) {
	sourceName := sourceSessionName(sourceID)
	nextName := res.Name
	if nextName == "" {
		nextName = res.ID
	}
	store.Get().Notification.Add(notification.Notification{
		Type:     "info",
		Category: notification.CategoryTask,
		TitleKey: "agentchain.notify.triggered.title",
		BodyKey:  "agentchain.notify.triggered.body",
		Title:    "会话接续",
		Body:     fmt.Sprintf("%s → %s", sourceName, nextName),
		MsgParams: map[string]any{
			"source": sourceName,
			"next":   nextName,
			"status": status,
		},
		Action:        "terminal",
		ActionPayload: res.ID,
	})
}

// notifyTriggerFailed 发起失败入账（error 类，terminal 无动作可跳）
func notifyTriggerFailed(ch *store.AgentChain, sourceID string, err error) {
	sourceName := sourceSessionName(sourceID)
	store.Get().Notification.Add(notification.Notification{
		Type:     "error",
		Category: notification.CategoryTask,
		TitleKey: "agentchain.notify.failed.title",
		BodyKey:  "agentchain.notify.failed.body",
		Title:    "会话接续失败",
		Body:     fmt.Sprintf("%s: %v", sourceName, err),
		MsgParams: map[string]any{
			"source": sourceName,
			"error":  err.Error(),
		},
	})
}

// sourceSessionName 链源会话显示名（元数据缺失降级会话 ID——通知文案不谎称）
func sourceSessionName(sessionID string) string {
	if meta, err := store.Get().AgentSession.Get(sessionID); err == nil && meta != nil && meta.Name != "" {
		return meta.Name
	}
	return sessionID
}

// aliveByManager 生产存活判定：终端管理器在册即在（tmux/native 双后端同语义）
func aliveByManager(sessionID string) bool {
	return terminal.DefaultManager.GetSession(sessionID) != nil
}

// launchByTerminal 生产会话创建口：LaunchAgentSession 核心（agentcron 调度器
// 同层调用，HTTP 无关）；lang 传空 = 会话名英文默认（无请求上下文）。
// WithDisplayNameDedup（P-20261023-3）：链棒显式名与存量会话同名自动步进，
// 多链并行/同链重跑不再产出雷同名
func launchByTerminal(name, runtime, dir, launchArgs string) (*terminalapi.AgentLaunch, error) {
	return terminalapi.LaunchAgentSession(name, runtime, dir, launchArgs, "", terminalapi.WithDisplayNameDedup())
}
