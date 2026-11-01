package files

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/store"
)

// 替换历史留档与一键还原单测（P-20261004-66）：真实 fixture 仓库走
// 「执行→留档→还原」全链——
//   - 执行留档：历史条目携 pattern/选项快照/文件数/处数/改写明细/内嵌补丁
//   - 一键还原（脏基线）：checkout+正向 apply 精确重建替换前工作区（含替换前
//     未提交改动），untracked 命中文件如实回告不在还原范围
//   - 一键还原（干净基线）：无补丁段，checkout 归零即完成
//   - 还原冲突：还原前暂存区被推进 → 409 稳定标记且现场未动
//   - paths 圈定：命中集收窄到显式清单；超限 400

func histList(t *testing.T, f *replaceFixture) []replaceHistEntry {
	t.Helper()
	return decodeData[[]replaceHistEntry](t, f.do(f.engine(), http.MethodGet, "/api/projects/"+f.id+"/replace/history", nil))
}

func TestReplaceHist_RecordOnExecute(t *testing.T) {
	f := newReplaceFixture(t)
	f.write("a.txt", "old value one\nold value two\n")
	f.write("b.txt", "old value three\n")
	f.commitAll("base")

	w := f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "old", Replacement: "new"})
	if w.Code != http.StatusOK {
		t.Fatalf("replace: %d %s", w.Code, w.Body.String())
	}
	list := histList(t, f)
	if len(list) != 1 {
		t.Fatalf("expected 1 history entry, got %d", len(list))
	}
	e := list[0]
	if e.Pattern != "old" || e.Replacement != "new" {
		t.Errorf("pattern/replacement not archived: %+v", e)
	}
	if e.Files != 2 || e.Hits != 3 {
		t.Errorf("files/hits = %d/%d, want 2/3", e.Files, e.Hits)
	}
	if len(e.Changed) != 2 {
		t.Errorf("changed detail missing: %+v", e.Changed)
	}
	// 本用例基线干净（未提交 diff 为空）→ 备份 Empty=true、无补丁字节，
	// 但有改写明细 → 仍 restorable（还原=checkout 归零语义）
	if !e.BackupEmpty || e.PatchBytes != 0 {
		t.Errorf("clean baseline should archive empty backup: %+v", e)
	}
	if !e.Restorable {
		t.Errorf("empty-backup entry with changes should be restorable")
	}
	// 无实际改写不进历史（pattern 无命中）
	f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "nonexistent-string-xyz", Replacement: "z"})
	if got := len(histList(t, f)); got != 1 {
		t.Errorf("no-op replace must not create history, got %d entries", got)
	}
}

func TestReplaceHist_RestoreDirtyBaseline(t *testing.T) {
	f := newReplaceFixture(t)
	// 脏基线：a.txt 带未提交行（备份补丁非空——还原须连它一起重建）
	pre := "keep LegacyApi(v1)\nlegacy helper\nuncommitted marker\n"
	f.write("svc.txt", pre)
	f.write("util.txt", "wrap LegacyApi here\n")
	f.commitAll("base")
	f.write("svc.txt", "keep LegacyApi(v1)\nlegacy helper\nuncommitted marker NEWER\n")

	w := f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "LegacyApi", Replacement: "ModernApi"})
	if w.Code != http.StatusOK {
		t.Fatalf("replace: %d %s", w.Code, w.Body.String())
	}
	if got := f.read("svc.txt"); !strings.Contains(got, "ModernApi") {
		t.Fatalf("replace did not apply: %q", got)
	}

	list := histList(t, f)
	if len(list) != 1 || !list[0].Restorable {
		t.Fatalf("history entry missing or not restorable: %+v", list)
	}
	w = f.do(f.engine(), http.MethodPost,
		"/api/projects/"+f.id+"/replace/history/"+list[0].ID+"/restore", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", w.Code, w.Body.String())
	}
	// 还原 = 替换前现场（含替换前的未提交改动 NEWER）
	if got := f.read("svc.txt"); got != "keep LegacyApi(v1)\nlegacy helper\nuncommitted marker NEWER\n" {
		t.Errorf("restore did not rebuild pre-replace worktree: %q", got)
	}
	if got := f.read("util.txt"); got != "wrap LegacyApi here\n" {
		t.Errorf("util.txt not restored: %q", got)
	}
}

func TestReplaceHist_RestoreUntrackedReported(t *testing.T) {
	f := newReplaceFixture(t)
	f.write("tracked.txt", "hit Alpha here\n")
	f.commitAll("base")
	// untracked 命中文件：无 index 基线，不入备份也不入还原
	f.write("newfile.txt", "hit Alpha too\n")

	f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "Alpha", Replacement: "Beta"})
	list := histList(t, f)
	if len(list) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(list))
	}
	w := f.do(f.engine(), http.MethodPost,
		"/api/projects/"+f.id+"/replace/history/"+list[0].ID+"/restore", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", w.Code, w.Body.String())
	}
	if got := f.read("tracked.txt"); got != "hit Alpha here\n" {
		t.Errorf("tracked file not restored: %q", got)
	}
	// untracked 文件保持替换后内容 + 响应如实回告 untracked=1
	if got := f.read("newfile.txt"); got != "hit Beta too\n" {
		t.Errorf("untracked file should stay replaced: %q", got)
	}
	if !strings.Contains(w.Body.String(), `"untracked":1`) {
		t.Errorf("response should report untracked count: %s", w.Body.String())
	}
}

func TestReplaceHist_RestoreConflictLeavesUntouched(t *testing.T) {
	f := newReplaceFixture(t)
	pre := "call Alpha(v1)\n"
	f.write("a.txt", pre)
	f.commitAll("base")
	// 脏基线制造非空备份补丁
	f.write("a.txt", "call Alpha(v1)\nextra line\n")
	f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "Alpha", Replacement: "Beta"})
	list := histList(t, f)
	if len(list) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(list))
	}
	// 替换后推进暂存区：checkout 归零后补丁对【新】暂存区基面失配 → apply 段
	// 409 稳定标记（工作区已归暂存区态；本例暂存区=替换后内容，字节不变）
	f.git("add", "-A")

	w := f.do(f.engine(), http.MethodPost,
		"/api/projects/"+f.id+"/replace/history/"+list[0].ID+"/restore", nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 conflict, got %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), errRestoreConflictStable) {
		t.Errorf("stable marker missing: %s", w.Body.String())
	}
	// 工作区与暂存区一致（checkout 已生效，apply 段拒绝）
	if got := f.read("a.txt"); got != "call Beta(v1)\nextra line\n" {
		t.Errorf("workspace should be at staged state: %q", got)
	}
}

func TestReplaceHist_PathsSubset(t *testing.T) {
	f := newReplaceFixture(t)
	f.write("a.txt", "tok one\n")
	f.write("b.txt", "tok two\n")
	f.commitAll("base")

	w := f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "tok", Replacement: "TOK", Paths: []string{"a.txt"}})
	if w.Code != http.StatusOK {
		t.Fatalf("replace: %d %s", w.Code, w.Body.String())
	}
	if got := f.read("a.txt"); got != "TOK one\n" {
		t.Errorf("selected file not replaced: %q", got)
	}
	if got := f.read("b.txt"); got != "tok two\n" {
		t.Errorf("unselected file must stay untouched: %q", got)
	}
	// 留档只记圈定范围内的改动
	list := histList(t, f)
	if len(list) != 1 || list[0].Files != 1 || list[0].Hits != 1 {
		t.Fatalf("history should reflect subset: %+v", list)
	}
	// 越出上限的 paths 清单 400
	paths := make([]string, 0, replacePathsMax+1)
	for i := 0; i <= replacePathsMax; i++ {
		paths = append(paths, fmt.Sprintf("f%d.txt", i))
	}
	w = f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "tok", Replacement: "x", Paths: paths})
	if w.Code != http.StatusBadRequest {
		t.Errorf("paths over cap should 400, got %d", w.Code)
	}
}

func TestReplaceHist_PurgeHook(t *testing.T) {
	// 留档 API 面（files 包）与 store 的衔接：TTL 清账函数经 store 聚合体可达
	f := newReplaceFixture(t)
	f.write("a.txt", "v 1\n")
	f.commitAll("base")
	f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "v", Replacement: "V"})
	if got := len(histList(t, f)); got != 1 {
		t.Fatalf("expected 1 entry, got %d", got)
	}
	// 过 TTL 全清（store 侧单测已覆盖语义，此处锚定 files 模块的调用口径）
	if n := store.Get().ReplaceHist.PurgeExpired(
		store.Get().ReplaceHist.List(f.id, 0)[0].Time.Add(store.ReplaceHistRetention)); n != 1 {
		t.Fatalf("purge should remove 1, got %d", n)
	}
	if got := len(histList(t, f)); got != 0 {
		t.Errorf("history should be empty after purge, got %d", got)
	}
}

func TestReplaceHist_EmbeddedPatchDecodes(t *testing.T) {
	// 内嵌补丁可解码且就是备份 patch 的原文（脏基线 → 非空）
	f := newReplaceFixture(t)
	f.write("a.txt", "line one\n")
	f.commitAll("base")
	f.write("a.txt", "line one\nlocal edit\n")
	f.do(f.engine(), http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "one", Replacement: "ONE"})
	// 清单不泄露补丁字节，还原取数走内嵌 base64 → artifacts 文件同内容
	dir := replaceBackupsProjectDir(f.id)
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("artifacts backup missing: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	recs := store.Get().ReplaceHist.List(f.id, 0)
	if len(recs) != 1 || recs[0].PatchB64 == "" {
		t.Fatalf("embedded patch missing: %+v", recs)
	}
	decoded, err := base64.StdEncoding.DecodeString(recs[0].PatchB64)
	if err != nil || string(decoded) != string(raw) {
		t.Errorf("embedded patch differs from artifacts copy: %v", err)
	}
}
