package terminal

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 真实 PTY（Windows ConPTY / Unix creack-pty）下的空闲分离回归防线：
// idle_test.go 的假连接覆盖不了「单连接恰好一次 Close」的平台硬约束——
// Windows ConPTY 的 ClosePseudoConsole 不可重入，二次关闭实测堆破坏直接
// 杀死进程（STATUS_HEAP_CORRUPTION 0xC0000374，P-192 实施期 e2e 抓获后
// 定位）。本文件两条用例锁定该不变量：Detach 单次关闭（分离态先行置位）+
// 既有 Kill 路径（closed 先行）行为不回退

// waitManagerDrained 等在册会话清空并给 readLoop 留收尾缓冲：会话自移除
// ≠ readLoop 已走完最后一拍——遗留 readLoop 的尾帧 feed() 会经
// currentSentinelRules（sentinel.go）读 store default，与本用例起止处的
// store.SetDefault 换入/换出并发即数据竞争（WSL -race 实测闪红：
// store.go SetDefault 写 × sentinel.go:64 读，clean HEAD 同败与改动无关）。
// 用例起点直呼；收尾侧经 LIFO 配合——注册序 SetDefault(nil) 在前、本函数
// cleanup 在后，执行序先等后换
func waitManagerDrained(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(DefaultManager.ListSessions()) == 0 {
			time.Sleep(300 * time.Millisecond) // readLoop 末拍余量
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// pinNativeBackend 把本用例自建 store 的会话后端钉在 native：两条用例守卫的
// 是「真实 PTY（ConPTY/creak-pty）单次关闭」平台不变量，CreateSession 的
// auto 解析在装了 tmux 的 Linux 上会选 tmux——持久化后端 CloseSession 仅
// detach（会话驻留 manager、readLoop 生命周期越过用例），既偏离用例本意又
// 与 store 换入换出构成数据竞争。settings 对象属用例自建 store，随
// SetDefault(nil) 一并丢弃；prev 还原为 P-46 setShellSetting 同款保险
// （Settings.Get() 可能回落缓存 config.Load() 单例，防跨用例泄漏）
func pinNativeBackend(t *testing.T) {
	t.Helper()
	st := store.Get()
	cfg := st.Settings.Get()
	prev := cfg.Server.TerminalBackend
	t.Cleanup(func() { cfg.Server.TerminalBackend = prev })
	cfg.Server.TerminalBackend = string(BackendNative)
	if err := st.Settings.Save(); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

// TestNativeRealPtyDetachSingleClose native 会话 Detach 全链：真实 ConPTY
// 创建 → Detach（单次 Close）→ readLoop/waitLoop 收尾 → 会话自移除。
// 二次 Close 回归时本用例带堆破坏崩溃（进程级 FAIL 无断言输出即信号）
func TestNativeRealPtyDetachSingleClose(t *testing.T) {
	waitManagerDrained(t)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	t.Cleanup(func() { waitManagerDrained(t) }) // LIFO：先于 SetDefault(nil) 执行
	pinNativeBackend(t)

	s, err := DefaultManager.CreateSession("repro-1", "repro", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { DefaultManager.CloseSession("repro-1") })

	time.Sleep(500 * time.Millisecond) // 让 readLoop/waitLoop 就位并消费初始输出
	if !s.Detach() {
		t.Fatalf("detach should act")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if DefaultManager.GetSession("repro-1") == nil {
			return // native 会话已按「分离=终结」自移除
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("native session should be removed from manager after detach")
}

// TestNativeRealPtyKillBaseline 对照组：既有 Kill 路径（用户关终端，closed
// 先行 → 单次关闭）同场景跑一遍——守卫两条关闭路径的平台约束各自成立
func TestNativeRealPtyKillBaseline(t *testing.T) {
	waitManagerDrained(t)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	t.Cleanup(func() { waitManagerDrained(t) }) // LIFO：先于 SetDefault(nil) 执行
	pinNativeBackend(t)

	_, err := DefaultManager.CreateSession("repro-kill", "repro", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	DefaultManager.CloseSession("repro-kill")
	time.Sleep(2 * time.Second)
}
