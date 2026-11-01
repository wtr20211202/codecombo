package terminal

import (
	"testing"
	"time"
)

// 端口注册表单测（P-20261003-293）：登记/刷新/冲突判定/随会话摘除/上限逐出。
// Manager 用内存态裸构造（broadcast_test.go 同款），不起真实 PTY；
// OnPortConflict 是包级单例回调，用例内换桩 + t.Cleanup 复位（portdetect_test.go 同惯例）

// newPortRegistryFixture 内存 Manager 挂两个存活会话
func newPortRegistryFixture() *Manager {
	m := &Manager{sessions: make(map[string]*Session)}
	m.sessions["t-a"] = &Session{ID: "t-a"}
	m.sessions["t-b"] = &Session{ID: "t-b"}
	return m
}

// TestRegisterDevPortFirstAndLookup 首次登记进表，ListDevPorts 按端口升序返回
func TestRegisterDevPortFirstAndLookup(t *testing.T) {
	m := newPortRegistryFixture()

	if c := m.RegisterDevPort("t-a", 5173, "vite", PortSourceDetected); c != nil {
		t.Fatalf("first registration must not conflict: %+v", c)
	}
	if c := m.RegisterDevPort("t-b", 3000, "next", PortSourceReported); c != nil {
		t.Fatalf("first registration must not conflict: %+v", c)
	}

	ports := m.ListDevPorts()
	if len(ports) != 2 {
		t.Fatalf("want 2 entries, got %d: %+v", len(ports), ports)
	}
	if ports[0].Port != 3000 || ports[0].SessionID != "t-b" || ports[0].Source != PortSourceReported {
		t.Fatalf("entry[0] wrong: %+v", ports[0])
	}
	if ports[1].Port != 5173 || ports[1].Label != "vite" {
		t.Fatalf("entry[1] wrong: %+v", ports[1])
	}
	if ports[0].FirstSeen.IsZero() {
		t.Fatalf("firstSeen must be stamped")
	}
}

// TestRegisterDevPortSameSessionRefresh 同会话重复登记（重启服务/防抖过期重扫）
// 只刷新 label/source 与 LastSeen（P-20261007-14 观测时效），FirstSeen 不动、
// 不报冲突
func TestRegisterDevPortSameSessionRefresh(t *testing.T) {
	m := newPortRegistryFixture()
	m.RegisterDevPort("t-a", 5173, "vite", PortSourceDetected)
	first := m.ListDevPorts()[0].FirstSeen
	firstLast := m.ListDevPorts()[0].LastSeen
	time.Sleep(2 * time.Millisecond)

	if c := m.RegisterDevPort("t-a", 5173, "vite preview", PortSourceReported); c != nil {
		t.Fatalf("same-session re-registration must not conflict: %+v", c)
	}
	ports := m.ListDevPorts()
	if len(ports) != 1 {
		t.Fatalf("refresh must not duplicate entry, got %d", len(ports))
	}
	if ports[0].Label != "vite preview" || ports[0].Source != PortSourceReported {
		t.Fatalf("label/source not refreshed: %+v", ports[0])
	}
	if !ports[0].FirstSeen.Equal(first) {
		t.Fatalf("firstSeen must be preserved on refresh")
	}
	// LastSeen 刷新（观测时效语义）且不早于首登值
	if ports[0].LastSeen.Before(firstLast) {
		t.Fatalf("lastSeen must be refreshed on re-registration: %+v", ports[0])
	}
	// 首登路径：FirstSeen 与 LastSeen 同刻落章（都非零）
	if ports[0].LastSeen.IsZero() {
		t.Fatalf("lastSeen must be stamped on registration")
	}
}

// TestRegisterDevPortConflict 异会话登记同端口：返回先占条目、先占条目不被
// 覆盖、新会话不进表；OnPortConflict 收到 (holder, newcomer)
func TestRegisterDevPortConflict(t *testing.T) {
	m := newPortRegistryFixture()
	m.RegisterDevPort("t-a", 5173, "vite", PortSourceDetected)

	var holder, newcomer PortEntry
	called := false
	prev := OnPortConflict
	OnPortConflict = func(h, n PortEntry) { called, holder, newcomer = true, h, n }
	t.Cleanup(func() { OnPortConflict = prev })

	if c := m.RegisterDevPort("t-b", 5173, "vite", PortSourceReported); c == nil || c.SessionID != "t-a" {
		t.Fatalf("conflict must return holder entry, got %+v", c)
	}
	if !called || holder.SessionID != "t-a" || newcomer.SessionID != "t-b" {
		t.Fatalf("OnPortConflict args wrong: called=%v holder=%+v newcomer=%+v", called, holder, newcomer)
	}
	ports := m.ListDevPorts()
	if len(ports) != 1 || ports[0].SessionID != "t-a" {
		t.Fatalf("holder entry must be kept and newcomer rejected: %+v", ports)
	}
}

// TestRegisterDevPortNoCallbackWhenNoConflict 非冲突登记不触发回调
func TestRegisterDevPortNoCallbackWhenNoConflict(t *testing.T) {
	m := newPortRegistryFixture()
	called := false
	prev := OnPortConflict
	OnPortConflict = func(h, n PortEntry) { called = true }
	t.Cleanup(func() { OnPortConflict = prev })

	m.RegisterDevPort("t-a", 5173, "vite", PortSourceDetected)
	m.RegisterDevPort("t-a", 5173, "vite", PortSourceDetected) // 同会话刷新
	if called {
		t.Fatalf("callback must not fire without conflict")
	}
}

// TestRegisterDevPortGuards 未知会话不登记（幽灵条目等不到摘除）、空会话 id
// 与越界端口直接拒绝
func TestRegisterDevPortGuards(t *testing.T) {
	m := newPortRegistryFixture()

	if c := m.RegisterDevPort("ghost", 5173, "vite", PortSourceDetected); c != nil {
		t.Fatalf("unknown session must be rejected: %+v", c)
	}
	if c := m.RegisterDevPort("", 5173, "vite", PortSourceDetected); c != nil {
		t.Fatalf("empty session id must be rejected: %+v", c)
	}
	if c := m.RegisterDevPort("t-a", 80, "http", PortSourceDetected); c != nil {
		t.Fatalf("privileged port must be rejected: %+v", c)
	}
	if c := m.RegisterDevPort("t-a", 70000, "x", PortSourceDetected); c != nil {
		t.Fatalf("out-of-range port must be rejected: %+v", c)
	}
	if ports := m.ListDevPorts(); len(ports) != 0 {
		t.Fatalf("registry must stay empty, got %+v", ports)
	}
}

// TestPortsRemovedOnCloseSession 会话关闭即摘除其全部端口登记（CloseSession 路径）
func TestPortsRemovedOnCloseSession(t *testing.T) {
	m := newPortRegistryFixture()
	m.RegisterDevPort("t-a", 5173, "vite", PortSourceDetected)
	m.RegisterDevPort("t-a", 5174, "", PortSourceDetected)
	m.RegisterDevPort("t-b", 3000, "next", PortSourceReported)

	m.CloseSession("t-a")

	ports := m.ListDevPorts()
	if len(ports) != 1 || ports[0].SessionID != "t-b" || ports[0].Port != 3000 {
		t.Fatalf("closed session entries must be removed: %+v", ports)
	}
}

// TestPortsRemovedOnRemoveSession native shell 自行退出路径（removeSession）同样摘除
func TestPortsRemovedOnRemoveSession(t *testing.T) {
	m := newPortRegistryFixture()
	s := &Session{ID: "t-a"}
	m.sessions["t-a"] = s
	m.RegisterDevPort("t-a", 5173, "vite", PortSourceDetected)

	m.removeSession(s)

	if ports := m.ListDevPorts(); len(ports) != 0 {
		t.Fatalf("removed session entries must be gone: %+v", ports)
	}
}

// TestRegisterDevPortCapEvictsOldest 满员逐出最早登记（agent 上报死循环的
// 无界增长兜底）：第 portRegistryMax+1 个登记挤掉 FirstSeen 最旧的条目。
// 最旧条目显式回拨时间戳——紧循环登记的 time.Now 可能同 tick 打平，回拨保证
// 「最早」判定确定性
func TestRegisterDevPortCapEvictsOldest(t *testing.T) {
	m := newPortRegistryFixture()
	m.RegisterDevPort("t-a", 1024, "", PortSourceReported) // 最早登记，应被逐出
	for p := 1025; p < 1024+portRegistryMax; p++ {
		m.RegisterDevPort("t-a", p, "", PortSourceReported)
	}
	if len(m.ListDevPorts()) != portRegistryMax {
		t.Fatalf("cap not enforced")
	}
	oldest := m.ports[1024]
	oldest.FirstSeen = time.Now().Add(-time.Hour)
	m.ports[1024] = oldest

	m.RegisterDevPort("t-a", 1024+portRegistryMax, "", PortSourceReported)

	ports := m.ListDevPorts()
	if len(ports) != portRegistryMax {
		t.Fatalf("cap must hold after eviction, got %d", len(ports))
	}
	if ports[0].Port != 1025 {
		t.Fatalf("oldest entry (1024) must be evicted, got %+v", ports[0])
	}
	if ports[len(ports)-1].Port != 1024+portRegistryMax {
		t.Fatalf("newest entry must be present, got %+v", ports[len(ports)-1])
	}
}
