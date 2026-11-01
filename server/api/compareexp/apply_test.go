package compareexp

// 采用落盘二阶段测试（P-20261004-72）：任务书要求的验证面——apply 编排
//（保留/回滚/删除）、强制备份前置、失配拒绝（指纹对账）、写锁域、同目录
// 无操作语义、未结算拒绝。分目录夹具 = 真 git 仓库双开（与 e2e 同构）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/api/opschannel"
	"codecombo/server/store"
)

// ─────────────── 行动集规划（纯函数） ───────────────

func TestPlanApplyRows_Forms(t *testing.T) {
	rows := []CompareFileRow{
		{Path: "a-only.ts", InA: true, StatusA: "M"},
		{Path: "b-only.ts", InB: true, StatusB: "M"},
		{Path: "b-new.ts", InB: true, StatusB: "?"},
		{Path: "both.ts", InA: true, InB: true, StatusA: "M", StatusB: "A"},
	}
	// 分目录形态：采用 A → B 独有 tracked 回滚 / untracked 删除，A 独有保留
	split := planApplyRows(rows, sideA, false)
	if len(split.keep) != 1 || split.keep[0].Path != "a-only.ts" {
		t.Fatalf("split keep: %+v", split.keep)
	}
	if len(split.rollback) != 1 || split.rollback[0].Path != "b-only.ts" {
		t.Fatalf("split rollback: %+v", split.rollback)
	}
	if len(split.remove) != 1 || split.remove[0].Path != "b-new.ts" {
		t.Fatalf("split remove: %+v", split.remove)
	}
	if len(split.noopBoth) != 1 || split.noopBoth[0].Path != "both.ts" {
		t.Fatalf("split noopBoth: %+v", split.noopBoth)
	}
	if got := split.destructive(); len(got) != 2 {
		t.Fatalf("destructive set: %+v", got)
	}

	// 同目录形态：他侧独有 = 已在采用基线，零破坏动作
	same := planApplyRows(rows, sideA, true)
	if len(same.rollback) != 0 || len(same.remove) != 0 {
		t.Fatalf("same-dir must have no destructive actions: %+v %+v", same.rollback, same.remove)
	}
	if len(same.noopBaseline) != 2 {
		t.Fatalf("same-dir noopBaseline: %+v", same.noopBaseline)
	}

	// 采用 B：镜像对称
	mirror := planApplyRows(rows, sideB, false)
	if len(mirror.keep) != 2 || len(mirror.rollback) != 1 || len(mirror.remove) != 0 {
		t.Fatalf("mirror b plan: keep=%d rollback=%d remove=%d", len(mirror.keep), len(mirror.rollback), len(mirror.remove))
	}
}

// ─────────────── 分目录全链：回滚 + 删除 + 备份可查 ───────────────

func TestAdoptApply_SplitDirRollbackAndBackup(t *testing.T) {
	r := setupExpTest(t)
	dirA, headA := newApplyRepo(t, "alpha.ts", "a base\n", "a changed\n")
	// B 侧带一枚基线后删除的 tracked 文件（D 状态回滚路径：指纹缺席语义）
	dirB, headB := newApplyRepo(t, "beta.ts", "b base\n", "b changed\n", "gone.ts")
	writeApplyFile(t, dirB, "b-only-new.txt", "delete me\n")

	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "落盘",
		A:      store.CompareSide{SessionID: "ag-a"},
		B:      store.CompareSide{SessionID: "ag-b"},
	})
	seedSideSession(t, "ag-a", dirA, headA)
	seedSideSession(t, "ag-b", dirB, headB)
	settleBoth(t, "ag-a", "ag-b")

	// 直接 mode=apply（无先期标注）：零间隙重拍快照后执行
	w := doAdopt(t, r, exp.ID, `{"side":"a","mode":"apply"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("apply status = %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Applied AdoptApplyResult `json:"applied"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	ap := body.Data.Applied
	if ap.Kept != 1 || ap.RolledBack != 2 || ap.Deleted != 1 || ap.BackupID == "" {
		t.Fatalf("applied = %+v", ap)
	}

	// B 侧工作区：tracked 回到基线、被删 tracked 复活、untracked 消失；A 侧零触碰
	if got := readApplyFile(t, dirB, "beta.ts"); got != "b base\n" {
		t.Fatalf("B tracked not rolled back: %q", got)
	}
	if got := readApplyFile(t, dirB, "gone.ts"); got != "to be deleted\n" {
		t.Fatalf("B deleted tracked not restored: %q", got)
	}
	if _, err := os.Stat(filepath.Join(dirB, "b-only-new.txt")); !os.IsNotExist(err) {
		t.Fatalf("B untracked not deleted: %v", err)
	}
	if got := readApplyFile(t, dirA, "alpha.ts"); got != "a changed\n" {
		t.Fatalf("A side must stay untouched: %q", got)
	}

	// 备份可查：列表 + 单条还原补丁（含被删 untracked 字节）
	w = doGet(r, "/api/compare-experiments/"+exp.ID+"/applies")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"rolledBack":2`) {
		t.Fatalf("applies list = %d: %s", w.Code, w.Body.String())
	}
	w = doGet(r, "/api/compare-experiments/"+exp.ID+"/applies/"+ap.BackupID+"/patch")
	if w.Code != http.StatusOK {
		t.Fatalf("backup patch = %d", w.Code)
	}
	var rec struct {
		Data struct {
			Patch     string            `json:"patch"`
			Untracked map[string][]byte `json:"untracked"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &rec); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rec.Data.Patch, "diff --git a/beta.ts b/beta.ts") ||
		!strings.Contains(rec.Data.Patch, "+b changed") {
		t.Fatalf("backup patch not restorable-looking: %q", rec.Data.Patch)
	}
	if string(rec.Data.Untracked["b-only-new.txt"]) != "delete me\n" {
		t.Fatalf("untracked backup missing: %v", rec.Data.Untracked)
	}

	// 坏 apply id 400 / 他实验记录 404
	if w = doGet(r, "/api/compare-experiments/"+exp.ID+"/applies/expapply-bad/patch"); w.Code != http.StatusBadRequest {
		t.Fatalf("bad aid should 400, got %d", w.Code)
	}
	if w = doGet(r, "/api/compare-experiments/"+exp.ID+"/applies/expapply-404/patch"); w.Code != http.StatusNotFound {
		t.Fatalf("missing aid should 404, got %d", w.Code)
	}
}

// ─────────────── 失配拒绝：标注后手改 → 整体拒 + 工作区不动 ───────────────

func TestAdoptApply_ConflictAfterAdoption(t *testing.T) {
	r := setupExpTest(t)
	dirA, headA := newApplyRepo(t, "alpha.ts", "a base\n", "a changed\n")
	dirB, headB := newApplyRepo(t, "beta.ts", "b base\n", "b changed\n")

	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "落盘",
		A:      store.CompareSide{SessionID: "ag-a"},
		B:      store.CompareSide{SessionID: "ag-b"},
	})
	seedSideSession(t, "ag-a", dirA, headA)
	seedSideSession(t, "ag-b", dirB, headB)
	settleBoth(t, "ag-a", "ag-b")

	// 先标注（快照在案），再手改 B 侧行动文件
	if w := doAdopt(t, r, exp.ID, `{"side":"a"}`); w.Code != http.StatusOK {
		t.Fatalf("annotate status = %d: %s", w.Code, w.Body.String())
	}
	// 标注响应携快照（行动文件指纹在案）
	got, _ := store.Get().CompareExp.Get(exp.ID)
	if got.Adopted != "a" || got.ApplySnapshot == nil || len(got.ApplySnapshot.Files) == 0 {
		t.Fatalf("annotate must capture snapshot: %+v", got.ApplySnapshot)
	}
	if got.ApplySnapshot.Side != "a" {
		t.Fatalf("snapshot side = %q", got.ApplySnapshot.Side)
	}
	writeApplyFile(t, dirB, "beta.ts", "hand edited after adoption\n")

	w := doAdopt(t, r, exp.ID, `{"side":"a","mode":"apply"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("conflict apply should 409, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), ApplyConflictMarker) {
		t.Fatalf("conflict marker missing: %s", w.Body.String())
	}
	// 工作区一个字节不动 + 不留备份记录
	if got := readApplyFile(t, dirB, "beta.ts"); got != "hand edited after adoption\n" {
		t.Fatalf("workspace must stay untouched: %q", got)
	}
	recs, _ := store.Get().ExpApply.ListByExperiment(exp.ID)
	if len(recs) != 0 {
		t.Fatalf("refused apply must not leave backup: %d", len(recs))
	}
}

// ─────────────── 同目录形态：零破坏动作（已在采用基线） ───────────────

func TestAdoptApply_SameDirNoop(t *testing.T) {
	r := setupExpTest(t)
	dir, head := newApplyRepo(t, "alpha.ts", "base\n", "changed\n")
	writeApplyFile(t, dir, "new-both.txt", "untracked\n")

	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "落盘",
		A:      store.CompareSide{SessionID: "ag-a"},
		B:      store.CompareSide{SessionID: "ag-b"},
	})
	seedSideSession(t, "ag-a", dir, head)
	seedSideSession(t, "ag-b", dir, head)
	settleBoth(t, "ag-a", "ag-b")

	w := doAdopt(t, r, exp.ID, `{"side":"a","mode":"apply"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("same-dir apply status = %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Applied AdoptApplyResult `json:"applied"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	ap := body.Data.Applied
	if ap.RolledBack != 0 || ap.Deleted != 0 || ap.BackupID != "" {
		t.Fatalf("same-dir apply must be non-destructive: %+v", ap)
	}
	// 磁盘实况不变
	if got := readApplyFile(t, dir, "alpha.ts"); got != "changed\n" {
		t.Fatalf("same-dir content must stay: %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "new-both.txt")); err != nil {
		t.Fatalf("untracked must stay: %v", err)
	}
}

// ─────────────── 未结算 / 缺基线：拒绝执行 ───────────────

func TestAdoptApply_NotSettledRefused(t *testing.T) {
	r := setupExpTest(t)
	dirA, headA := newApplyRepo(t, "alpha.ts", "a base\n", "a changed\n")
	dirB, headB := newApplyRepo(t, "beta.ts", "b base\n", "b changed\n")

	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "落盘",
		A:      store.CompareSide{SessionID: "ag-a"},
		B:      store.CompareSide{SessionID: "ag-b"},
	})
	seedSideSession(t, "ag-a", dirA, headA)
	seedSideSession(t, "ag-b", dirB, headB)

	// 双侧会话「存活」且无回执 → 拒（真 PTY 不可得，探针注入存活态）
	orig := sessionGoneProbe
	sessionGoneProbe = func(string) bool { return false }
	defer func() { sessionGoneProbe = orig }()

	w := doAdopt(t, r, exp.ID, `{"side":"a","mode":"apply"}`)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "not settled") {
		t.Fatalf("unsettled apply should 409, got %d: %s", w.Code, w.Body.String())
	}
	if got := readApplyFile(t, dirB, "beta.ts"); got != "b changed\n" {
		t.Fatalf("workspace must stay untouched: %q", got)
	}
}

func TestAdoptApply_MissingBaselineRefused(t *testing.T) {
	r := setupExpTest(t)
	dirB, headB := newApplyRepo(t, "beta.ts", "b base\n", "b changed\n")

	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "落盘",
		A:      store.CompareSide{SessionID: "ag-a"},
		B:      store.CompareSide{SessionID: "ag-b"},
	})
	// A 侧无元数据（模拟无基线退化面）→ 全部产出会错归 B 独有，必须拒
	seedSideSession(t, "ag-a", t.TempDir(), "")
	seedSideSession(t, "ag-b", dirB, headB)
	settleBoth(t, "ag-a", "ag-b")

	w := doAdopt(t, r, exp.ID, `{"side":"a","mode":"apply"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("missing baseline should 409, got %d: %s", w.Code, w.Body.String())
	}
	if got := readApplyFile(t, dirB, "beta.ts"); got != "b changed\n" {
		t.Fatalf("workspace must stay untouched: %q", got)
	}
}

// ─────────────── expapply 仓储（CRUD + 级联清账 + 容量裁剪） ───────────────

func TestExpApplyRepo_CRUDAndPrune(t *testing.T) {
	setupExpTest(t)
	mk := func(expID string) store.ExpApplyRecord {
		return store.ExpApplyRecord{ExpID: expID, Side: "a", Patch: "patch-of-" + expID}
	}
	rec, err := store.Get().ExpApply.Create(mk("cmp-1"))
	if err != nil || rec.ID == "" || rec.CreatedAt.IsZero() {
		t.Fatalf("create: %v %+v", err, rec)
	}
	got, err := store.Get().ExpApply.Get(rec.ID)
	if err != nil || got.Patch != "patch-of-cmp-1" {
		t.Fatalf("get: %v %+v", err, got)
	}
	// Update 计数回写
	got.Kept = 2
	got.RolledBack = 1
	got.Notes = []string{"n1"}
	if err := store.Get().ExpApply.Update(got); err != nil {
		t.Fatalf("update: %v", err)
	}
	got2, _ := store.Get().ExpApply.Get(rec.ID)
	if got2.Kept != 2 || len(got2.Notes) != 1 {
		t.Fatalf("update not persisted: %+v", got2)
	}
	// 过滤 + 级联清账
	if _, err := store.Get().ExpApply.Create(mk("cmp-2")); err != nil {
		t.Fatal(err)
	}
	if n, err := store.Get().ExpApply.ListByExperiment("cmp-1"); err != nil || len(n) != 1 {
		t.Fatalf("list filter: %v %d", err, len(n))
	}
	if n, _ := store.Get().ExpApply.DeleteByExperiment("cmp-1"); n != 1 {
		t.Fatalf("cascade delete: %d", n)
	}
	if _, err := store.Get().ExpApply.Get(rec.ID); err != store.ErrExpApplyNotFound {
		t.Fatalf("deleted record should be gone: %v", err)
	}
	// 容量裁剪：超 ExpApplyKeepMax 后全量收敛
	for i := 0; i < store.ExpApplyKeepMax+5; i++ {
		if _, err := store.Get().ExpApply.Create(mk("cmp-p")); err != nil {
			t.Fatal(err)
		}
	}
	ids, err := store.Get().ExpApply.ListByExperiment("cmp-p")
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != store.ExpApplyKeepMax {
		t.Fatalf("prune kept %d, want %d", len(ids), store.ExpApplyKeepMax)
	}
}

// ─────────────── 夹具 ───────────────

func doAdopt(t *testing.T, r interface {
	ServeHTTP(http.ResponseWriter, *http.Request)
}, expID, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/compare-experiments/"+expID+"/adopt", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// settleBoth 双侧终结回执（观察者直调——与完成链同流，同步落位）
func settleBoth(t *testing.T, a, b string) {
	t.Helper()
	taskEventObserver(opschannel.Event{Type: opschannel.EventTaskProgress, Payload: map[string]any{
		"terminalId": a, "status": "done",
	}})
	taskEventObserver(opschannel.Event{Type: opschannel.EventTaskProgress, Payload: map[string]any{
		"terminalId": b, "status": "done",
	}})
}

// newApplyRepo 落盘测试仓库：基线提交 name=base（外加 goneFiles 同基线提交）后
// 工作区把 name 改为 changed、goneFiles 从工作区删除（D 状态回滚路径夹具），
// 返回目录与基线 head（core.autocrlf false 钉死——Windows 全局配置不渗入断言）
func newApplyRepo(t *testing.T, name, base, changed string, goneFiles ...string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		if out, err := gitCmd(dir, args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "t@t")
	run("config", "user.name", "t")
	run("config", "core.autocrlf", "false")
	writeApplyFile(t, dir, name, base)
	for _, g := range goneFiles {
		writeApplyFile(t, dir, g, "to be deleted\n")
	}
	run("add", ".")
	run("commit", "-m", "base", "--no-gpg-sign")
	writeApplyFile(t, dir, name, changed)
	for _, g := range goneFiles {
		if err := os.Remove(filepath.Join(dir, g)); err != nil {
			t.Fatal(err)
		}
	}
	return dir, gitHead(t, dir)
}

func writeApplyFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readApplyFile(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}
