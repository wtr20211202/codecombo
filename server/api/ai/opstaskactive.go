package ai

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/opschannel"

	"github.com/gin-gonic/gin"
)

// ============== task.progress 最近上报缓存（P-20261004-120） ==============
//
// per-session 最近一条 task.progress 的内存缓存：ops-notify 发布口旁挂——
// 刷新/重启后悬浮球/进度卡/监控卡即时回填的数据面。agent 的下一条 progress
// 事件可能间隔数分钟（慢步骤），纯内存态的 bySession 在页面刷新/服务重启后
// 全灭，值班盯进度刷新即盲区——GET /api/ops-tasks/active 让 OpsChannelBridge
// 挂载即拉回填（approvals.seedPending / asks seedPending 同款补账链的
// progress 侧，P-20261003-130 先例），瞬态面补账三件套齐套。
//
// 瞬态语义不变：纯内存不落盘（重启清空，agent 下一条上报自会重建）；会话
// 关闭即清（terminals.changed 快照对账，见 PruneLastProgressObserver）。
// 内存量级：每会话至多一条、载荷过发布口尺寸墙（≤64KB），会话数受终端
// MaxSessions 约束，占用可忽略。

// lastProgressEntry 单会话最近一条 task.progress：
// payload 为发布口校验/规整后的原始全量载荷（未知扩展字段原样保留——
// 缓存面与广播面一致，消费方按需取字段）；receivedAt 是服务端收到时刻
// （陈旧判活的诚实时钟：页面关闭期间的沉默在补账后立刻如实计入，
// 而非从补账时刻重新起算）
type lastProgressEntry struct {
	SessionID  string
	Payload    map[string]interface{}
	ReceivedAt time.Time
}

var (
	lastProgressMu    sync.RWMutex
	lastProgressBySid = map[string]lastProgressEntry{}
)

// rememberLastProgress 发布口旁挂登记（OpsNotify 限流放行后调用——被限流
// 丢弃的上报不进广播流，也不入缓存，两面对齐）。会话归属取 X-Session-ID 头
// （手册约定 agent 全量携带，CC_TERMINAL_ID 注入值同源），载荷 terminalId
// （task.progress 约定归属字段）兜底；无归属不缓存——挂不到会话的条目等不到
// 「会话关闭即摘除」，反成幽灵占用（preview.port 登记同裁决）
func rememberLastProgress(headerSession string, payload interface{}) {
	m, ok := payload.(map[string]interface{})
	if !ok {
		return // 非对象载荷（畸形但未被校验拒绝的形态）不缓存
	}
	sid := strings.TrimSpace(headerSession)
	if sid == "" {
		if v, ok := m["terminalId"].(string); ok {
			sid = strings.TrimSpace(v)
		}
	}
	if sid == "" {
		if v, ok := m["sessionId"].(string); ok {
			sid = strings.TrimSpace(v)
		}
	}
	if sid == "" {
		return
	}
	lastProgressMu.Lock()
	lastProgressBySid[sid] = lastProgressEntry{SessionID: sid, Payload: m, ReceivedAt: time.Now()}
	lastProgressMu.Unlock()
}

// lastProgressSnapshot 缓存快照（receivedAt 升序——前端逐条应用时最新一条
// 最后落位，全局字段收敛语义与逐事件到达一致）
func lastProgressSnapshot() []lastProgressEntry {
	lastProgressMu.RLock()
	entries := make([]lastProgressEntry, 0, len(lastProgressBySid))
	for _, e := range lastProgressBySid {
		entries = append(entries, e)
	}
	lastProgressMu.RUnlock()
	sort.Slice(entries, func(i, j int) bool { return entries[i].ReceivedAt.Before(entries[j].ReceivedAt) })
	return entries
}

// ActiveOpsTasks 查询各会话最近一次 task.progress（瞬态内存快照）。
// 路由：GET /api/ops-tasks/active（agent 令牌/解锁令牌均可，与 ops-confirm
// 同鉴权面）——「全舰队在跑什么」（含 task/step/状态）的一瞥可知监控原语，
// 前端 OpsChannelBridge 挂载补账与 agent 值班巡检共用。
//
// 响应：{ "data": { "serverTime": unix 毫秒, "tasks": [ { "sessionId",
// "receivedAt": unix 毫秒, "payload": 最近一条全量载荷 } ] } }
// 已关闭会话的条目被快照对账摘除，不在列（前端 pruneClosedSessions 的
// 服务端权威前置）。
func ActiveOpsTasks(c *gin.Context) {
	entries := lastProgressSnapshot()
	tasks := make([]gin.H, 0, len(entries))
	for _, e := range entries {
		tasks = append(tasks, gin.H{
			"sessionId":  e.SessionID,
			"receivedAt": e.ReceivedAt.UnixMilli(),
			"payload":    e.Payload,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"tasks":      tasks,
		"serverTime": time.Now().UnixMilli(),
	}})
}

// PruneLastProgressObserver 会话关闭即清的观察者（模块 Init 经 AddObserver
// 装配）：terminals.changed 快照的活名单之外，缓存条目随会话消亡摘除——
// 与前端 assistantTask.pruneClosedSessions 同一裁决，服务端是权威面（刷新
// 后的补账因此天然不含死会话）。快照解析失败（sessions 键缺席）不动缓存：
// 不信一份读不懂的对账单；sessions 为空数组是「全部会话已关闭」的真快照，
// 照常清空
func PruneLastProgressObserver() func(opschannel.Event) {
	return func(ev opschannel.Event) {
		if ev.Type != opschannel.EventTerminalsChanged {
			return
		}
		raw, err := json.Marshal(ev.Payload)
		if err != nil {
			return
		}
		var snap struct {
			Sessions []struct {
				ID string `json:"id"`
			} `json:"sessions"`
		}
		if json.Unmarshal(raw, &snap) != nil || snap.Sessions == nil {
			return
		}
		alive := make(map[string]bool, len(snap.Sessions))
		for _, s := range snap.Sessions {
			alive[s.ID] = true
		}
		lastProgressMu.Lock()
		for sid := range lastProgressBySid {
			if !alive[sid] {
				delete(lastProgressBySid, sid)
			}
		}
		lastProgressMu.Unlock()
	}
}
