package terminal

import (
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 服务端只读闸（P-20261008-17）单测：
//   - 标记生命周期：零值关、SetServerReadOnly 翻转可往返
//   - 自建会话缺省关：CreateSession 产物（含重启恢复形态——recover 构造点
//     同样不置位）不受接管闸影响
//   - 豁免面：闸开着时 BroadcastWrite 仍写（批量运维走审批不经本闸，批注③
//     分层）；WriteInput 本身不读标记（闸只活在 WS 写链入口 api/terminal）
//   - 接管初值：AttachExternalSession 置 true（真实 tmux——用例在
//     serverreadonly_ext_unix_test.go，!windows 构建标签）
//
// store/manager 纪律沿 idle_realpty_test.go：起点 waitManagerDrained +
// 用例自建 store + pinNativeBackend + LIFO 收尾（WSL -race 实测的
// store.SetDefault × 残留 readLoop 竞争防线）

// TestServerReadOnly_Lifecycle 标记生命周期：零值关 + 翻转往返（裸 Session，
// 不需要 PTY——标记是纯 atomic 位，不挂任何 IO）
func TestServerReadOnly_Lifecycle(t *testing.T) {
	s := &Session{}
	if s.ServerReadOnly() {
		t.Fatal("zero-value session must default to writable (serverReadOnly=false)")
	}
	s.SetServerReadOnly(true)
	if !s.ServerReadOnly() {
		t.Fatal("SetServerReadOnly(true) must engage the gate")
	}
	s.SetServerReadOnly(false)
	if s.ServerReadOnly() {
		t.Fatal("SetServerReadOnly(false) must release the gate")
	}
}

// TestServerReadOnly_SelfSessionDefaultOff 自建会话缺省闸关：接管闸只存在于
// origin=external 的会话，自建会话 agent 写入面零变化（回归面注记）
func TestServerReadOnly_SelfSessionDefaultOff(t *testing.T) {
	waitManagerDrained(t)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	t.Cleanup(func() { waitManagerDrained(t) }) // LIFO：先于 SetDefault(nil) 执行
	pinNativeBackend(t)

	s, err := DefaultManager.CreateSession("ro-default-1", "ro-default", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { DefaultManager.CloseSession(s.ID) })
	if s.ServerReadOnly() {
		t.Fatal("self-origin session must default to writable")
	}
	if s.Origin != OriginSelf {
		t.Fatalf("origin = %q, want self", s.Origin)
	}
}

// TestServerReadOnly_BroadcastExempt 豁免面：闸开着时广播写照常达 PTY
// （Written 计数 1）——「单人交互只读可锁、批量运维走审批」的分层结构断言，
// 防未来有人把闸下沉进 WriteInput 误伤广播/队列/运行书三个直写面
func TestServerReadOnly_BroadcastExempt(t *testing.T) {
	waitManagerDrained(t)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	t.Cleanup(func() { waitManagerDrained(t) }) // LIFO：先于 SetDefault(nil) 执行
	pinNativeBackend(t)

	s, err := DefaultManager.CreateSession("ro-bcast-1", "ro-bcast", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { DefaultManager.CloseSession(s.ID) })
	s.SetServerReadOnly(true)

	res := DefaultManager.BroadcastWrite([]string{s.ID}, []byte("echo SC-RO-EXEMPT\r"))
	if res.Written != 1 {
		t.Fatalf("broadcast written = %d, want 1 (gate must not apply to broadcast)", res.Written)
	}
	// WriteInput 同理不被闸：运行书/队列共享的直写通道语义不变
	if err := s.WriteInput([]byte("\r")); err != nil {
		t.Fatalf("WriteInput must not consult the gate, got err=%v", err)
	}
}
