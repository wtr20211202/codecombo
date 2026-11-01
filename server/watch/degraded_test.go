package watch

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/model"
)

// mustTree 造一棵测试目录树：root/{f.txt, sub/{a.txt, deep/{x.txt}}, .git/{h}}
func mustTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, d := range []string{"sub", filepath.Join("sub", "deep"), ".git"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"f.txt", filepath.Join("sub", "a.txt"), filepath.Join("sub", "deep", "x.txt"), filepath.Join(".git", "HEAD")} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("v1"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// settleTree 等目录树指纹沉降（Windows NTFS 目录元数据惰性刷平，见
// TestShallowFingerprint_ShallowScope 注）：连续两次一致即视为稳定
func settleTree(t *testing.T, root string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		a, ok1 := shallowFingerprint(root)
		b, _ := shallowFingerprint(root)
		if ok1 && a == b {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("tree fingerprint never settled")
}

// TestShallowFingerprint_ShallowScope 浅层指纹的感知边界：根/一级子目录的
// 结构与内容变化必须可感知（含 create/delete/mtime）；深层内容修改不承诺
// （降级态浅层边界）；.git 与 skipDirs 不进指纹
func TestShallowFingerprint_ShallowScope(t *testing.T) {
	root := mustTree(t)
	// 基线沉降：Windows NTFS 目录元数据惰性刷平——新建子树的目录 mtime 会在
	// 短窗口内漂移（实测两次读取可差 ~150ms 粒度值），连续两次一致才作基线，
	// 防测试把刷平噪声误判为「无变化应稳定」失败
	var base string
	settleTree(t, root)
	base, _ = shallowFingerprint(root)

	rewrite := func(rel, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	expectChanged := func(name string) {
		t.Helper()
		fp, ok := shallowFingerprint(root)
		if !ok {
			t.Fatalf("%s: fingerprint failed", name)
		}
		if fp == base {
			t.Fatalf("%s: fingerprint should change", name)
		}
		// 沉降后重定基线：NTFS 目录元数据惰性刷平会让变更点的残留漂移在
		// 数秒内陆续落定，不沉降会污染下一条「应稳定」断言
		settleTree(t, root)
		base, _ = shallowFingerprint(root)
	}
	expectStable := func(name string) {
		t.Helper()
		fp, _ := shallowFingerprint(root)
		if fp != base {
			t.Fatalf("%s: fingerprint should stay stable", name)
		}
	}

	expectStable("no-op reread")
	rewrite(filepath.Join("f.txt"), "v2") // 根文件内容变化（mtime）
	expectChanged("root file modify")
	rewrite(filepath.Join("sub", "a.txt"), "v3") // 一级子目录文件内容
	expectChanged("level-1 file modify")
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("n"), 0o644); err != nil {
		t.Fatal(err)
	}
	expectChanged("root file create")
	if err := os.Remove(filepath.Join(root, "new.txt")); err != nil {
		t.Fatal(err)
	}
	expectChanged("root file delete")

	// 深层（三级）与 .git 的覆盖边界以「条目清单（名字+深度）」断言——
	// Windows Dev Drive/异步元数据文件系统上 mtime 会在写入后漂移，指纹
	// 等值断言在写入后不可靠，覆盖边界与 mtime 漂移正交
	entryNames := func() map[string]bool {
		t.Helper()
		entries, ok := shallowEntries(root)
		if !ok {
			t.Fatal("shallowEntries failed")
		}
		names := map[string]bool{}
		for _, e := range entries {
			names[fmt.Sprintf("%d:%s", e.depth, e.name)] = true
		}
		return names
	}
	before := entryNames()
	rewrite(filepath.Join("sub", "deep", "x.txt"), "v4") // 深层内容修改
	rewrite(filepath.Join(".git", "HEAD"), "ref: moved") // .git 变化
	if got := entryNames(); !maps.Equal(got, before) {
		t.Fatalf("depth-3/.git changes must not alter shallow entry set, before=%v after=%v", before, got)
	}
	want := map[string]bool{"1:f.txt": true, "1:sub": true, "2:a.txt": true, "2:deep": true}
	if !maps.Equal(before, want) {
		t.Fatalf("shallow coverage mismatch, got %v want %v", before, want)
	}

	// 根不可读（跨平台口径：直接移除——Windows 的 chmod 不产生读拒绝）：
	// ok=false 是「项目删除中」的跳过信号
	os.RemoveAll(root)
	if _, ok := shallowFingerprint(root); ok {
		t.Fatal("missing root must report ok=false")
	}
}

// TestSetFallback_ManualCycle 手动开关闭环：开启即 manual 来源（自动恢复不
// 抢切）；扫描轮把浅层变化广播成 file.changed（与 watcher 同管道）；关闭
// 后状态归零且指纹基线清除；未跟踪项目（根缺失）轮询跳过不 panic
func TestSetFallback_ManualCycle(t *testing.T) {
	root := mustTree(t)
	settleTree(t, root) // 先沉降再建基线，防刷平噪声伪装成「变化」
	rw, err := NewRepoWatcher(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rw.Stop)

	var broadcasts []string
	rw.bcFunc = func(projectID string, msg model.WSMessage) {
		broadcasts = append(broadcasts, projectID)
		if msg.Type != "file.changed" {
			t.Errorf("broadcast type = %s, want file.changed", msg.Type)
		}
	}

	// 项目接入（索引 + 真实监听）
	if err := rw.TrackProject("p1", root); err != nil {
		t.Fatal(err)
	}

	enabled, src, since := rw.SetFallback(boolPtr(true))
	if !enabled || src != fallbackSrcManual || since.IsZero() {
		t.Fatalf("after enable: enabled=%v src=%q since=%v, want true/manual/non-zero", enabled, src, since)
	}

	// 开启时首轮已建基线并广播一次（对齐漂移）；此后无变化轮不再广播
	rw.pollOnce()
	nAfterBaseline := len(broadcasts)
	if nAfterBaseline == 0 {
		t.Fatal("first poll after enable must broadcast once to align the tree")
	}
	rw.pollOnce()
	if len(broadcasts) != nAfterBaseline {
		t.Fatal("unchanged tree must not broadcast again")
	}

	// 浅层变化 → 下一轮广播
	if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	rw.pollOnce()
	if len(broadcasts) != nAfterBaseline+1 {
		t.Fatalf("shallow change must broadcast, got %d broadcasts", len(broadcasts))
	}

	// 关闭：状态归零；已删项目的指纹随 Untrack 清理
	enabled, src, since = rw.SetFallback(boolPtr(false))
	if enabled || src != "" || !since.IsZero() {
		t.Fatalf("after disable: enabled=%v src=%q since=%v, want all zero", enabled, src, since)
	}
	rw.UntrackProject("p1", root)
	rw.fallbackMu.Lock()
	left := len(rw.fingerprints)
	rw.fallbackMu.Unlock()
	if left != 0 {
		t.Fatalf("fingerprints must be cleaned on untrack, left %d", left)
	}

	// 根已删的幽灵项目：轮询跳过（不广播不 panic）
	rw.addIndexEntry("ghost", filepath.Join(root, "gone"))
	rw.pollOnce()
}

// TestCheckHook_AutoEnableAndIdempotent 配额耗尽钩子接线：ENOSPC 事实触发
// 自动降级（来源 auto）；重复 ENOSPC 幂等；手动关闭后再次 ENOSPC 重新启用
// （新证据重新触发）；通知顺序 = 降级通知先于配额告警（钩子先于投递口解析）
func TestCheckHook_AutoEnableAndIdempotent(t *testing.T) {
	rw, err := NewRepoWatcher(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rw.Stop)
	rec := &recorder{}
	rw.inotify.notify = rec.add
	rw.inotify.limit = func() (int, bool) { return 0, false }

	rw.inotify.check(0, 4, 4)
	enabled, src, _ := rw.FallbackStatus()
	if !enabled || src != fallbackSrcAuto {
		t.Fatalf("exhausted check must auto-enable (auto), got enabled=%v src=%q", enabled, src)
	}
	if len(rec.got) != 2 {
		t.Fatalf("want [fallback-enabled, quota-exhausted], got %d notifications", len(rec.got))
	}
	if rec.got[0].TitleKey != "notify.watchfallback.enabled.title" || rec.got[0].Type != "info" {
		t.Errorf("first notification = %s/%s, want fallback enabled info", rec.got[0].Type, rec.got[0].TitleKey)
	}
	if rec.got[1].TitleKey != "notify.inotify.exhausted.title" {
		t.Errorf("second notification = %s, want quota exhausted warning", rec.got[1].TitleKey)
	}

	rw.inotify.check(0, 8, 8) // 重复 ENOSPC：降级已开幂等，告警去重
	if len(rec.got) != 2 {
		t.Fatalf("repeated exhaustion must be fully idempotent, got %d", len(rec.got))
	}

	rw.SetFallback(boolPtr(false)) // 手动关闭
	rw.inotify.check(0, 12, 12)    // 新一轮 ENOSPC：重新自动启用
	enabled, src, _ = rw.FallbackStatus()
	if !enabled || src != fallbackSrcAuto {
		t.Fatalf("re-newed exhaustion must re-enable (auto), got enabled=%v src=%q", enabled, src)
	}
}

// TestCheckHook_NilSafe 零值 guard（直构路径）无钩子时 check 不 panic
func TestCheckHook_NilSafe(t *testing.T) {
	g := &inotifyGuard{limit: func() (int, bool) { return 0, false }}
	g.check(0, 4, 4) // 无投递口无钩子：静默
}

// TestProbeAndMaybeRestore_AutoRestores 配额释放自动恢复（测试环境配额恒
// 充足 = 探针恒成功）：auto 降级 → 探测+重挂全过 → 切回 watcher（状态关闭）
// + 恢复通知；manual 降级不参与自动恢复
func TestProbeAndMaybeRestore_AutoRestores(t *testing.T) {
	root := mustTree(t)

	restoreAuto := func(t *testing.T) (*RepoWatcher, *recorder) {
		t.Helper()
		rw, err := NewRepoWatcher(nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(rw.Stop)
		rec := &recorder{}
		rw.inotify.notify = rec.add
		rw.inotify.limit = func() (int, bool) { return 0, false }
		if err := rw.TrackProject("p1", root); err != nil {
			t.Fatal(err)
		}
		rw.inotify.check(0, 4, 4) // 触发自动降级
		return rw, rec
	}

	t.Run("auto source restores", func(t *testing.T) {
		rw, rec := restoreAuto(t)
		rw.probeAndMaybeRestore()
		enabled, _, _ := rw.FallbackStatus()
		if enabled {
			t.Fatal("healthy quota must restore to watcher (fallback off)")
		}
		var restored bool
		for _, n := range rec.got {
			if n.TitleKey == "notify.watchfallback.restored.title" {
				restored = true
				if n.Type != "success" {
					t.Errorf("restored notification type = %s, want success", n.Type)
				}
			}
		}
		if !restored {
			t.Fatalf("restored notification missing, got %+v", rec.got)
		}
	})

	t.Run("manual source stays", func(t *testing.T) {
		rw, rec := restoreAuto(t)
		rw.SetFallback(boolPtr(false))
		rw.SetFallback(boolPtr(true)) // 手动开启
		rw.probeAndMaybeRestore()
		enabled, src, _ := rw.FallbackStatus()
		if !enabled || src != fallbackSrcManual {
			t.Fatalf("manual fallback must not auto-restore, got enabled=%v src=%q", enabled, src)
		}
		for _, n := range rec.got {
			if n.TitleKey == "notify.watchfallback.restored.title" {
				t.Error("manual fallback must not fire restored notification")
			}
		}
	})
}

// TestExhaustedNotificationCarriesFallbackAction 配额耗尽通知必须携「切换轮询」
// 动作（告警条手动降级入口，P-20261003-140）
func TestExhaustedNotificationCarriesFallbackAction(t *testing.T) {
	n := inotifyExhaustedNotification(3, 8192, true)
	if n.Action != "watch-fallback" || n.ActionPayload != "toggle" {
		t.Fatalf("action = %s/%s, want watch-fallback/toggle", n.Action, n.ActionPayload)
	}
	if n.TitleKey != "notify.inotify.exhausted.title" {
		t.Fatalf("TitleKey = %s", n.TitleKey)
	}
}

// TestSetFallback_ToggleNil 翻转语义：enable=nil 按当前态取反
func TestSetFallback_ToggleNil(t *testing.T) {
	rw, err := NewRepoWatcher(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rw.Stop)
	enabled, _, _ := rw.SetFallback(nil)
	if !enabled {
		t.Fatal("toggle from off must enable")
	}
	enabled, _, _ = rw.SetFallback(nil)
	if enabled {
		t.Fatal("toggle from on must disable")
	}
}

// TestFallbackStateBroadcast_Transitions 状态迁移广播（P-20261006-34）：手动
// 开启/关闭与自动启用/自动恢复各广播一次，载荷与 GET /api/watch/fallback 快照
// 同形；幂等开关不广播。缺省广播口（nil）= notification.BroadcastEvent，对 nil
// hub 自短路——不注入时本链路静默无 panic（SetFallback 循环用例隐式覆盖）
func TestFallbackStateBroadcast_Transitions(t *testing.T) {
	rw, err := NewRepoWatcher(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rw.Stop)
	var events []fallbackEvent
	rw.fallbackBroadcast = func(msgType string, payload any) {
		if msgType != fallbackStateEvent {
			t.Errorf("event type = %s, want %s", msgType, fallbackStateEvent)
		}
		ev, ok := payload.(fallbackEvent)
		if !ok {
			t.Fatalf("payload type = %T, want fallbackEvent", payload)
		}
		events = append(events, ev)
	}

	// 手动开启：一次 {true, manual, since}
	rw.SetFallback(boolPtr(true))
	if len(events) != 1 || !events[0].Enabled || events[0].Source != fallbackSrcManual || events[0].Since == "" {
		t.Fatalf("manual enable must broadcast once {true,manual,since}, got %+v", events)
	}
	// 幂等开启：状态未迁移不广播
	rw.SetFallback(boolPtr(true))
	if len(events) != 1 {
		t.Fatalf("idempotent enable must not broadcast, got %+v", events)
	}
	// 关闭：一次零形载荷（omitempty 序列化后 enabled=false 裸形）
	rw.SetFallback(boolPtr(false))
	if len(events) != 2 || events[1].Enabled || events[1].Source != "" || events[1].Since != "" {
		t.Fatalf("disable must broadcast once zero-shaped, got %+v", events)
	}

	// auto 路径：耗尽钩子自动启用广播一次 {true, auto}；配额释放探针自动恢复
	// 再广播一次 {false}（测试环境配额恒充足 = 探针恒成功）
	rw.inotify.limit = func() (int, bool) { return 0, false }
	rw.inotify.check(0, 4, 4)
	if len(events) != 3 || !events[2].Enabled || events[2].Source != fallbackSrcAuto {
		t.Fatalf("auto enable must broadcast once {true,auto}, got %+v", events)
	}
	rw.probeAndMaybeRestore()
	if len(events) != 4 || events[3].Enabled {
		t.Fatalf("auto restore must broadcast once {false}, got %+v", events)
	}
}

// TestFallbackLoop_StopsOnDisableAndDone 扫描循环生命周期：手动关闭即退出
// （fallbackStop 关闭）；RepoWatcher.Stop 兜底退出（rw.done）——两路径都不得
// 泄漏常驻 goroutine（由 go test 检测泄漏的惯例靠 -race + 不挂死保证）
func TestFallbackLoop_StopsOnDisableAndDone(t *testing.T) {
	root := mustTree(t)
	rw, err := NewRepoWatcher(nil)
	if err != nil {
		t.Fatal(err)
	}
	rw.inotify.limit = func() (int, bool) { return 0, false }

	rw.addIndexEntry("p1", root)
	rw.SetFallback(boolPtr(true))
	time.Sleep(20 * time.Millisecond) // 让循环进入 select
	done := make(chan struct{})
	go func() {
		rw.SetFallback(boolPtr(false))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("disable must not block")
	}

	// rw.done 兜底：再启用后直接 Stop，循环经 done 退出且 Stop 不挂死
	rw.SetFallback(boolPtr(true))
	time.Sleep(20 * time.Millisecond)
	stopped := make(chan struct{})
	go func() {
		rw.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop must not block with fallback loop running")
	}
}

func boolPtr(v bool) *bool { return &v }
