package terminal

import (
	"sort"
	"time"
)

// 端口注册表（P-20261003-293）：把 dev 端口探测命中（portdetect.go →
// OnDevPortDetected）与 agent 主动上报（ops-notify preview.port 发布口）两路
// 信号沉淀为「端口 → 会话」登记表。EADDRINUSE 时冲突通知直接点名先占会话
//（Action 直达占用方终端），agent 起服务前可查已知占用选自由端口。
// 登记面 = 探测/上报面：未被探测正则覆盖或 agent 未上报的监听不在列（前端
// 文案用「已知占用」措辞，不做进程级 netstat 对账）；内存态 MVP，重启清空，
// 持久化非必需。

// 端口登记来源：detected = 终端输出被动探测（portdetect.go）；reported =
// agent 经 ops-notify preview.port 主动上报（P-70 手册约定）。与 preview.port
// 广播 payload 的 source 字段同词表
const (
	PortSourceDetected = "detected"
	PortSourceReported = "reported"
)

// portRegistryMax 登记条目上限：正常个位数~几十条（会话上限 MaxSessions、
// 探测有 5 分钟防抖、上报有 ops-notify 限流），封顶只为 agent 上报死循环的
// 极端场景兜底无界增长；满员逐出最早登记（firstSeen 最旧）
const portRegistryMax = 1024

// PortEntry 端口登记条目。会话显示名/项目归属不落条目——改名无需同步钩子，
// GET 口读取时经 GetSession 现查（sessionSnapshot 同款直读惯例）。
// LastSeen（P-20261007-14 环境画像引入）：最近一次登记/刷新时刻——FirstSeen
// 是「先占时点」（同会话重登记不动的既有语义），画像页标注观测时效用最近
// 见到时刻才诚实（服务还活着 ≈ 探测/上报仍在刷新）。内存态，零持久化面
type PortEntry struct {
	Port      int       `json:"port"`
	SessionID string    `json:"sessionId"`
	Label     string    `json:"label"`
	Source    string    `json:"source"`
	FirstSeen time.Time `json:"firstSeen"`
	LastSeen  time.Time `json:"lastSeen"`
}

// OnPortConflict 端口冲突回调（API 层 init 装配，注入通知中心；nil = 只登记
// 不通知）。holder = 先占条目，newcomer = 触发冲突的本次登记。锁外调用
// （回调链落通知中心，代价不可控，不拖住 Manager 锁）——与 OnSentinelHit
// 同款注入手法、同款锁外纪律
var OnPortConflict func(holder, newcomer PortEntry)

// validDevPort 端口合法性（与 devPortMin/devPortMax 同口径：回环高位段）。
// 两路登记口上游各自校验过，此处兜底防新调用方绕过
func validDevPort(port int) bool {
	return port >= devPortMin && port <= devPortMax
}

// RegisterDevPort 登记一个 dev 端口观测：
//   - 首次登记：写入注册表，返回 nil
//   - 同会话重复登记（重启服务/防抖过期重扫）：刷新 label/source 与 LastSeen，
//     FirstSeen 不动（「先占时点」语义），返回 nil
//   - 异会话登记同端口（冲突）：不覆盖先占条目——第二个服务通常起不来，
//     端口归属以先到者为准；返回先占条目并由 OnPortConflict 发冲突通知
//
// 会话不存在（已关闭/恢复前的幽灵 id）不登记：条目随会话关闭摘除，挂在不
// 存在会话上的条目永远等不到摘除时机，会变成长期幽灵占用。
// 锁序：仅持 m.mu 临界区做 map 读写，回调在锁外触发
func (m *Manager) RegisterDevPort(sessionID string, port int, label, source string) *PortEntry {
	if sessionID == "" || !validDevPort(port) {
		return nil
	}
	m.mu.Lock()
	if m.sessions[sessionID] == nil {
		m.mu.Unlock()
		return nil
	}
	if m.ports == nil {
		m.ports = make(map[int]PortEntry)
	}
	existing, ok := m.ports[port]
	var conflict PortEntry
	if ok && existing.SessionID != sessionID {
		conflict = existing // 先占条目不动：归属以先到者为准
	} else {
		if !ok {
			// 满员逐出最早登记：O(n) 扫描只在满员时发生（个位数量级，非热点）
			if len(m.ports) >= portRegistryMax {
				var oldestKey int
				var oldest PortEntry
				first := true
				for k, v := range m.ports {
					if first || v.FirstSeen.Before(oldest.FirstSeen) {
						oldestKey, oldest, first = k, v, false
					}
				}
				delete(m.ports, oldestKey)
			}
			now := time.Now()
			existing = PortEntry{Port: port, FirstSeen: now, LastSeen: now}
		}
		existing.SessionID = sessionID
		existing.Label = label
		existing.Source = source
		existing.LastSeen = time.Now()
		m.ports[port] = existing
	}
	m.mu.Unlock()

	if conflict.SessionID != "" && OnPortConflict != nil {
		OnPortConflict(conflict, PortEntry{Port: port, SessionID: sessionID, Label: label, Source: source, FirstSeen: time.Now(), LastSeen: time.Now()})
	}
	if conflict.SessionID != "" {
		return &conflict
	}
	return nil
}

// removeSessionPortsLocked 摘除某会话的全部端口登记（m.mu 已持有时调用）。
// 摘除不发通知：会话关闭后端口自然释放，无需打扰
func (m *Manager) removeSessionPortsLocked(sessionID string) {
	for port, e := range m.ports {
		if e.SessionID == sessionID {
			delete(m.ports, port)
		}
	}
}

// ListDevPorts 当前登记快照（按端口升序，列表展示序稳定）。
// 只列登记面内的端口：未被探测/上报覆盖的监听不在列（诚实边界，前端注记）
func (m *Manager) ListDevPorts() []PortEntry {
	m.mu.RLock()
	out := make([]PortEntry, 0, len(m.ports))
	for _, e := range m.ports {
		out = append(out, e)
	}
	m.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}
