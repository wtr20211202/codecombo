package shareapi

// 快照陈旧徽标（P-20261114-3-S2）管理面单测：主档惰性对比触发（列表投影
// staleAt）、上限护栏 unknown、加速器双守卫（降级档不置位）、生命周期三件
//（摘除/迁键/keep 对账）、基准复位（原地刷新）与幂等重建保留（重复分享不
// 假新鲜）

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/share"
	"codecombo/server/store"
)

// wireStaleHub 装配陈旧中枢（handlers 的 Reset/Bump/Forget/Move/Prune 经包级
// 引用触达；用例结束卸除防串扰）
func wireStaleHub(t *testing.T) *staleHub {
	t.Helper()
	h := newStaleHub(store.Get())
	setStaleHub(h)
	t.Cleanup(func() { setStaleHub(nil) })
	return h
}

// staleAtOf 列表响应里按 token 取 staleAt（行缺字段返回 false）
func staleAtOf(t *testing.T, out map[string]any, token string) (time.Time, bool) {
	t.Helper()
	row := findRow(t, out, token)
	if row == nil {
		return time.Time{}, false
	}
	s, _ := row["staleAt"].(string)
	if s == "" {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("staleAt not RFC3339: %v", s)
	}
	return at, true
}

// touchShareSource 改写分享源文件并前移 mtime（部分 FS mtime 粒度粗，显式
// Chtimes 保证与基准可区分）
func touchShareSource(t *testing.T, projDir, rel string) {
	t.Helper()
	p := filepath.Join(projDir, filepath.FromSlash(rel))
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("-changed"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(p, future, future); err != nil {
		t.Fatal(err)
	}
}

// TestStaleProjectionLazyCompare 主档惰性对比触发：创建基准在场 → 改源 →
// 列表投影 staleAt；未改源/无基准/live 行不携带
func TestStaleProjectionLazyCompare(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	wireStaleHub(t)

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("frozen create status = %d body=%v", code, out)
	}
	token := toString(out["data"].(map[string]any)["token"])

	// 未改源：不携带（提示性面宁缺勿错）
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, present := staleAtOf(t, out, token); present {
		t.Fatal("unchanged source must not project staleAt")
	}

	// 改源 → 列表惰性对比 → staleAt 在场（主档覆盖重启丢事件/降级窗口）
	proj, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatal(err)
	}
	touchShareSource(t, proj.Path, "note.txt")
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, token); !ok {
		t.Fatal("changed source must project staleAt on list")
	}

	// 置位后持续在场（判定带记忆，不因重复列表闪断）
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, token); !ok {
		t.Fatal("staleAt must persist across lists until refresh/reset")
	}

	// live 行与无基准形态不投影：live 创建 + 超限小档位 frozen 各验一路
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("live create status = %d", code)
	}
	liveToken := toString(out["data"].(map[string]any)["token"])
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, liveToken); ok {
		t.Fatal("live share must never project staleAt")
	}

	// 超限档位（采样必失败 → 基准 nil）下重建 frozen：显式撤销旧链防幂等
	// 命中既有基准走既有 staleAt——超限档位只影响「新采样」链路
	old := share.StaleScanEntryCap
	share.StaleScanEntryCap = 0
	defer func() { share.StaleScanEntryCap = old }()
	code, _ = doJSON(r, http.MethodDelete, "/api/share/"+token, "")
	if code != http.StatusOK {
		t.Fatalf("revoke status = %d", code)
	}
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("over-cap frozen create status = %d body=%v", code, out)
	}
	newToken := toString(out["data"].(map[string]any)["token"])
	touchShareSource(t, proj.Path, "note.txt")
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, newToken); ok {
		t.Fatal("baseline-less share (over-cap tree) must not project staleAt — unknown 不置位不误报")
	}
}

// TestStaleAcceleratorGuards 加速器双守卫：无 op 广播（降级档）与 path=项目根
// 均不置位；根内真实文件事件秒级置位；根外事件不串
func TestStaleAcceleratorGuards(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	hub := wireStaleHub(t)

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d", code)
	}
	token := toString(out["data"].(map[string]any)["token"])
	proj, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.ToSlash(filepath.Clean(proj.Path))

	// ① 降级守卫：无 op（降级轮询指纹广播形态）→ 不置位
	hub.onFileChanged(projectEvent{Payload: map[string]string{"path": filepath.Join(proj.Path, "note.txt")}})
	if _, _, stale := hub.staleOf(token); stale {
		t.Fatal("op-less broadcast (degraded fingerprint) must not mark stale")
	}
	// ② 降级守卫②：path=项目根（降级广播的 root 形态；同形态 chmod 事件罕见
	// 且非内容变更）→ 不置位
	hub.onFileChanged(projectEvent{Payload: map[string]string{"path": proj.Path, "op": "write"}})
	if _, _, stale := hub.staleOf(token); stale {
		t.Fatal("project-root path broadcast must not mark stale")
	}
	// ③ 根内真实事件 → 置位（加速器秒级，不等列表对比）
	hub.onFileChanged(projectEvent{Payload: map[string]string{
		"path": filepath.Join(proj.Path, "note.txt"), "op": "write"}})
	at, atIsZero, stale := hub.staleOf(token)
	if !stale || atIsZero {
		t.Fatalf("in-root event must mark stale, got stale=%v at=%v", stale, at)
	}
	// ④ 置位经列表投影可见（快路，不依赖再次 WalkDir）
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, token); !ok {
		t.Fatal("accelerator mark must surface in list projection")
	}
	// ⑤ 根外事件不串（另一项目的文件事件）
	hub.Forget(token)
	hub.onFileChanged(projectEvent{Payload: map[string]string{
		"path": filepath.Join(filepath.Dir(proj.Path), "other", "x.txt"), "op": "write"}})
	if _, _, stale := hub.staleOf(token); stale {
		t.Fatal("event outside share root must not mark stale")
	}
	_ = root
}

// staleOf 测试读取面：token 的（staleAt, 是否零值, 是否置位）
func (h *staleHub) staleOf(token string) (time.Time, bool, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	at, ok := h.stale[token]
	return at, at.IsZero(), ok
}

// TestStaleLifecycleHub 生命周期三件：Forget 摘除 / Move 迁键（徽标不闪断）/
// Prune keep 集对账；Reset 清标记且节流预热（投影即时回落）
func TestStaleLifecycleHub(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	hub := wireStaleHub(t)

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d", code)
	}
	token := toString(out["data"].(map[string]any)["token"])
	proj, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatal(err)
	}
	// 加速器置位
	hub.onFileChanged(projectEvent{Payload: map[string]string{
		"path": filepath.Join(proj.Path, "note.txt"), "op": "write"}})
	if _, _, stale := hub.staleOf(token); !stale {
		t.Fatal("precondition: stale mark expected")
	}

	// Reset（原地刷新链路）：标记清零 + 节流预热
	hub.Reset(token)
	if _, _, stale := hub.staleOf(token); stale {
		t.Fatal("Reset must clear stale mark (基准复位)")
	}

	// 再置位 → Rotate 迁键：新 token 继承陈旧时点，旧键摘除
	hub.onFileChanged(projectEvent{Payload: map[string]string{
		"path": filepath.Join(proj.Path, "note.txt"), "op": "write"}})
	_, atZero1, _ := hub.staleOf(token)
	code, out = doJSON(r, http.MethodPost, "/api/share/"+token+"/rotate", "")
	if code != http.StatusOK {
		t.Fatalf("rotate status = %d", code)
	}
	newToken := toString(out["data"].(map[string]any)["token"])
	if _, _, stale := hub.staleOf(token); stale {
		t.Fatal("old token mark must be dropped on rotate")
	}
	_, atZero2, stale := hub.staleOf(newToken)
	if !stale || atZero2 {
		t.Fatalf("rotated token must inherit stale mark (at zero=%v)", atZero1 || atZero2)
	}

	// Prune keep 集对账：集外 token 摘除（过期清账同族钩子）
	hub.Prune(map[string]bool{"someone-else": true})
	if _, _, stale := hub.staleOf(newToken); stale {
		t.Fatal("Prune must drop marks outside keep set")
	}
	hub.Prune(map[string]bool{newToken: true})
	hub.onFileChanged(projectEvent{Payload: map[string]string{
		"path": filepath.Join(proj.Path, "note.txt"), "op": "write"}})
	if _, _, stale := hub.staleOf(newToken); !stale {
		t.Fatal("Prune keep-in-set must retain live marks")
	}

	// Forget（撤销链路）：摘除 + 索引失效
	hub.Forget(newToken)
	if _, _, stale := hub.staleOf(newToken); stale {
		t.Fatal("Forget must clear mark")
	}
}

// TestStaleBaselineIdempotentPreserve 幂等重建保留基准（防「假新鲜」）：
// 改源后重复分享同目标（命中既有链）→ staleAt 仍在——重复分享不得复位基准
func TestStaleBaselineIdempotentPreserve(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	wireStaleHub(t)

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d", code)
	}
	token := toString(out["data"].(map[string]any)["token"])
	proj, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatal(err)
	}
	touchShareSource(t, proj.Path, "note.txt")

	// 幂等重建（副本未换内容，重复分享）：请求不带采样 → store 保留既有基准
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("idempotent create status = %d", code)
	}
	if got := toString(out["data"].(map[string]any)["token"]); got != token {
		t.Fatalf("idempotent create should return same token, got %s want %s", got, token)
	}
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, token); !ok {
		t.Fatal("idempotent re-share must preserve baseline — stale badge stays (防假新鲜)")
	}
}

// TestStaleBaselineResetOnRefresh 原地刷新基准复位：改源 → staleAt 在场 →
// refresh → 列表与响应都不带 staleAt，记录基准已更新
func TestStaleBaselineResetOnRefresh(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	wireStaleHub(t)

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d", code)
	}
	token := toString(out["data"].(map[string]any)["token"])
	proj, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatal(err)
	}
	touchShareSource(t, proj.Path, "note.txt")
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, token); !ok {
		t.Fatal("precondition: stale expected after source change")
	}

	code, out = doJSON(r, http.MethodPost, "/api/share/"+token+"/refresh", "")
	if code != http.StatusOK {
		t.Fatalf("refresh status = %d body=%v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("refresh response missing data: %v", out)
	}
	if _, has := data["staleAt"]; has {
		t.Fatal("refresh response must not carry staleAt (基准复位即时生效)")
	}
	rec, err := store.Get().Share.Get(token)
	if err != nil {
		t.Fatal(err)
	}
	if len(rec.SourceMtimes) == 0 {
		t.Fatal("refresh must refresh record baseline (SourceMtimes)")
	}
	// 刷新后的基准与当前源一致：再次列表不置位
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if _, ok := staleAtOf(t, out, token); ok {
		t.Fatal("post-refresh list must not project staleAt")
	}
}
