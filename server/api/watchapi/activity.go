package watchapi

// 跨项目实时变更流——只读聚合面（P-20261003-232）。
//
// 动机：file.changed 在内核事件总线上的广播是全局的（watch 模块对所有项目
// Publish，Envelope 携 ProjectID），但 WS 桥（api/busbridge.go）是逐项目投递
// ——前端只连当前项目 WS，没有跨项目来源。本处在 api 层直接订阅总线，把
// 事件收进进程内环形缓冲，GET /api/watch/activity 供前端轮询聚合出「跨项目
// 最近变更」时间线（值班大屏卡 / 活动栏独立面板）。
//
// 设计要点：
//   - 纯内存观测态：重启清空、零落盘（不涉持久化三车道；端口注册表 P-293
//     同类 MVP——可查询面只是「最近片刻」的滑动窗口，不是应用拥有的实体）
//   - 风暴防护：容量封顶最旧逐出（内存有界 ~百 KB 量级）；上游 watcher 已有
//     逐路径 500ms 防抖与降级轮询每项目每轮至多一条，环形缓冲只承接残余高频
//     并以容量自然收敛，dropped 计数如实上报供前端标注「风暴期记录不完整」
//   - 只读：GET 单端点，无任何写面；handler 不 import watch 包（分层惯例同
//     fallback.go——事件经总线到达，不经 watch 模块实例）
//   - Subscribe 回调跑在总线 Publish 同步派发路径上：只做一次宽松解码 +
//     O(1) 环写入，不做 IO 不做锁外重活

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"codecombo/server/kernel"

	"github.com/gin-gonic/gin"
)

// activityEntry 单条变更事件（JSON 形态即前端消费契约，字段只增不改）
type activityEntry struct {
	TS        int64  `json:"ts"` // UnixMilli
	ProjectID string `json:"projectId"`
	// Path 变更文件的绝对路径。服务端不折算项目相对形态：项目根在事件产生后
	// 可能增删/迁移，折算放展示层（前端持项目清单，展示时归一分隔符）
	Path string `json:"path"`
}

const (
	// activityRingCap 环形缓冲容量：封顶最旧逐出。取值权衡——值班面轮询间隔
	// 秒级、单次拉取默认 200 条，512 足以覆盖两次轮询间的高频风暴而不至于
	// 把内存/响应体推向无谓的量级
	activityRingCap = 512
	// activityMaxLimit 单次拉取上限（防御 limit=100000 式误用）
	activityMaxLimit = activityRingCap
	// activityDefaultLimit 缺省返回条数
	activityDefaultLimit = 200
)

// activityRing 定长环形缓冲：add O(1)，snapshot 自新向旧扫描（返回 k 条 O(k)）
type activityRing struct {
	mu    sync.Mutex
	buf   []activityEntry // 定长环，len 恒为 activityRingCap
	head  int             // 最旧元素下标（count < cap 时为 0）
	count int
	next  int // 下一写入下标
}

// dropped 容量逐出总数（atomic：总线回调与 HTTP 读并行，锁内加会更简单，
// 但 dropped 只增不改，atomic 换掉快照路径的一次锁内累加）
var droppedTotal atomic.Int64

var activity = &activityRing{buf: make([]activityEntry, activityRingCap)}

func (r *activityRing) add(e activityEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.count == activityRingCap {
		droppedTotal.Add(1)
		r.buf[r.next] = e
		r.head = (r.next + 1) % activityRingCap
	} else {
		r.buf[r.next] = e
		r.count++
	}
	r.next = (r.next + 1) % activityRingCap
}

// snapshot 返回新→旧的至多 limit 条、且 ts > since（0 = 不按时间过滤）；
// 第二返回值为累计逐出数（口径：本次进程生命周期内被挤出的总量）
func (r *activityRing) snapshot(since int64, limit int) ([]activityEntry, int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]activityEntry, 0, min(limit, r.count))
	// 自最新（next-1）向最旧（head）倒序扫
	for i := 1; i <= r.count && len(out) < limit; i++ {
		idx := (r.next - i + activityRingCap) % activityRingCap
		e := r.buf[idx]
		if since > 0 && e.TS <= since {
			continue
		}
		out = append(out, e)
	}
	return out, droppedTotal.Load()
}

// recordActivity 总线回调：宽松解码 file.changed 载荷后入环。
// 载荷形态 = watcher 广播的 {"path": ...}（map 或字符串 JSON 都可能——
// 降级轮询/未来演进同 topic 载荷宽松兼容，坏载荷丢弃不广播路径零影响）
func recordActivity(projectID string, payload any) {
	var raw struct {
		Path string `json:"path"`
	}
	switch v := payload.(type) {
	case string:
		if json.Unmarshal([]byte(v), &raw) != nil {
			return
		}
	default:
		b, err := json.Marshal(payload)
		if err != nil || json.Unmarshal(b, &raw) != nil {
			return
		}
	}
	if raw.Path == "" {
		return
	}
	activity.add(activityEntry{
		TS:        time.Now().UnixMilli(),
		ProjectID: projectID,
		Path:      raw.Path,
	})
}

// activityUnsub 总线退订函数（WireActivityRecorder 写入；测试复位用）
var activityUnsub func()

// WireActivityRecorder 组合根装配：订阅总线 file.changed 收进环形缓冲。
// 在 api.WireBusBridge 同期调用（server/app 内核装配点）；重复装配先退订
// （幂等，测试可反复接线）
func WireActivityRecorder(k kernel.Kernel) {
	if activityUnsub != nil {
		activityUnsub()
		activityUnsub = nil
	}
	activityUnsub = k.Events().Subscribe("file.changed", func(env kernel.Envelope) {
		recordActivity(env.ProjectID, env.Payload)
	})
	slog.Debug("watchapi: activity recorder wired to event bus")
}

// GetActivity GET /api/watch/activity?limit=&since= ——最近跨项目文件变更
// （内存环形缓冲快照，新→旧）。since=UnixMilli 只回该时刻之后（轮询增量），
// 响应附 dropped 供前端标注风暴期记录不完整。未接线（极端装配态）回空集
// 而非报错——读宽容，与 GetFallback 同姿态
func GetActivity(c *gin.Context) {
	limit := activityDefaultLimit
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = min(n, activityMaxLimit)
		}
	}
	var since int64
	if v := c.Query("since"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			since = n
		}
	}
	events, dropped := activity.snapshot(since, limit)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"events":  events,
		"dropped": dropped,
	}})
}
