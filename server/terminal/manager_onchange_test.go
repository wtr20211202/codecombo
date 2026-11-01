package terminal

import (
	"sync/atomic"
	"testing"
)

// 会话集合变更回调接线：removeSession 实际删除时触发一次（指针比对防误删不触发），
// CloseSession 未命中 id 不触发。API 层经 SetOnChange 注册 terminals.changed 广播
func TestSetOnChangeNotify(t *testing.T) {
	var fired int32
	SetOnChange(func() { atomic.AddInt32(&fired, 1) })
	t.Cleanup(func() { SetOnChange(nil) })

	m := &Manager{sessions: make(map[string]*Session)}

	// 未命中 id：不触发
	m.CloseSession("nonexistent")
	if atomic.LoadInt32(&fired) != 0 {
		t.Fatalf("CloseSession on missing id should not fire onChange, fired=%d", fired)
	}

	// removeSession 实际删除：触发一次
	s := &Session{ID: "chg-1"}
	m.sessions[s.ID] = s
	m.removeSession(s)
	if atomic.LoadInt32(&fired) != 1 {
		t.Fatalf("removeSession should fire onChange once, fired=%d", fired)
	}

	// 指针比对失配（同 ID 新会话已存在）：旧会话自移除不触发
	s2 := &Session{ID: "chg-2"}
	m.sessions[s2.ID] = s2
	m.removeSession(&Session{ID: "chg-2"})
	if atomic.LoadInt32(&fired) != 1 {
		t.Fatalf("stale pointer removal should not fire onChange, fired=%d", fired)
	}

	// CloseSession 命中：触发
	m.sessions["chg-3"] = &Session{ID: "chg-3"}
	m.CloseSession("chg-3")
	if atomic.LoadInt32(&fired) != 2 {
		t.Fatalf("CloseSession hit should fire onChange, fired=%d", fired)
	}
}
