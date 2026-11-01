package files

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// 回收站（P-20261003-304）单元测试：删除入站 → 列表 → 恢复/彻底删闭环 +
// 跨盘回退分支（提案验证要求）+ 清账双上限。数据目录经 SC_DATA_DIR 隔离
// （setupFileOpsTest 已设），trashRootDir 跟随该 env。

// trashProjPath 便捷：当前测试 SC_DATA_DIR 下的项目回收站目录
func trashProjPath(t *testing.T, projectID string) string {
	t.Helper()
	return filepath.Join(trashRootDir(), projectID)
}

// mustListTrash 列表并断言恰有 n 条
func mustListTrash(t *testing.T, r *gin.Engine, n int) []trashEntry {
	t.Helper()
	w := doFileJSON(t, r, http.MethodGet, "/api/projects/proj-test/trash", "")
	if w.Code != http.StatusOK {
		t.Fatalf("trash list status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data []trashEntry `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("list unmarshal: %v", err)
	}
	if len(resp.Data) != n {
		t.Fatalf("trash entries = %d, want %d: %s", len(resp.Data), n, w.Body.String())
	}
	return resp.Data
}

// setupTrashRoutes 文件组路由 + trash 三端点（/file/delete 已由
// setupFileOpsTest 按生产形态注册，此处只补 trash 面，形态同 router.go）
func setupTrashRoutes(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupFileOpsTest(t)
	g := r.Group("/api/projects/:id")
	{
		g.GET("/trash", TrashList)
		g.POST("/trash/:entryId/restore", TrashRestore)
		g.DELETE("/trash/:entryId", TrashPurge)
	}
	return r, projPath
}

// TestMovePath_CrossDeviceFallback 跨盘回退分支（提案指定单测）：rename 失败
// （EXDEV 形态）→ copyTree + 删源，内容字节级保真、源消失
func TestMovePath_CrossDeviceFallback(t *testing.T) {
	base := t.TempDir()
	srcDir := filepath.Join(base, "src")
	dstDir := filepath.Join(base, "dst")
	if err := os.MkdirAll(filepath.Join(srcDir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "sub", "a.txt"), []byte("cross-device payload"), 0o640); err != nil {
		t.Fatal(err)
	}

	origRename := renameFn
	renameFn = func(string, string) error { return os.ErrPermission } // 模拟跨卷 rename 必败
	defer func() { renameFn = origRename }()

	if err := movePath(srcDir, dstDir); err != nil {
		t.Fatalf("movePath: %v", err)
	}
	if _, err := os.Lstat(srcDir); !os.IsNotExist(err) {
		t.Fatalf("源应已移除: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dstDir, "sub", "a.txt"))
	if err != nil || string(got) != "cross-device payload" {
		t.Fatalf("副本内容 = %q (err=%v), want payload", got, err)
	}
}

// TestDeleteFile_GoesToTrash 删除 → 项目内消失 + 回收站在列（manifest 元数据
// 与删除目标一致）；恢复 → 原路径回来内容一致 + 条目出列
func TestDeleteFile_GoesToTrash(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	rel := filepath.ToSlash(filepath.Join("docs", "probe.txt"))
	abs := filepath.Join(projPath, "docs", "probe.txt")
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte("trash-me-content"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"`+rel+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(abs); !os.IsNotExist(err) {
		t.Fatalf("项目内应已消失: %v", err)
	}

	entries := mustListTrash(t, r, 1)
	e := entries[0]
	if e.Path != rel || e.Name != "probe.txt" || e.IsDir || e.Size != int64(len("trash-me-content")) || e.Degraded {
		t.Fatalf("entry 元数据不符: %+v", e)
	}

	// 恢复：原路径回来、内容一致、条目出列
	w = doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+e.ID+"/restore", "")
	if w.Code != http.StatusOK {
		t.Fatalf("restore status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(abs)
	if err != nil || string(got) != "trash-me-content" {
		t.Fatalf("恢复后内容 = %q (err=%v)", got, err)
	}
	mustListTrash(t, r, 0)
}

// TestDeleteFile_DirToTrashAndRestore 目录整树入站 + 恢复（isDir 元数据与子内容保真）
func TestDeleteFile_DirToTrashAndRestore(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	abs := filepath.Join(projPath, "tree", "sub")
	if err := os.MkdirAll(abs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(abs, "n.md"), []byte("dir payload"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"tree"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body=%s", w.Code, w.Body.String())
	}
	entries := mustListTrash(t, r, 1)
	if !entries[0].IsDir {
		t.Fatalf("isDir 应为 true: %+v", entries[0])
	}

	w = doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+entries[0].ID+"/restore", "")
	if w.Code != http.StatusOK {
		t.Fatalf("restore status = %d, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(projPath, "tree", "sub", "n.md"))
	if err != nil || string(got) != "dir payload" {
		t.Fatalf("恢复后内容 = %q (err=%v)", got, err)
	}
}

// TestTrashRestore_TargetExists 恢复目标已存在 → 409（不静默覆盖）
func TestTrashRestore_TargetExists(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	abs := filepath.Join(projPath, "dup.txt")
	if err := os.WriteFile(abs, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"dup.txt"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	if err := os.WriteFile(abs, []byte("newer"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := mustListTrash(t, r, 1)
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+entries[0].ID+"/restore", "")
	if w.Code != http.StatusConflict {
		t.Fatalf("restore status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(abs)
	if err != nil || string(got) != "newer" {
		t.Fatalf("现有文件不得被覆盖: %q (err=%v)", got, err)
	}
}

// TestTrashRestore_ParentGoneRelocatesRoot 原父目录已消失（后续被删/改名）→
// 落到项目根并置 relocated=true（提案风险节既定处置）
func TestTrashRestore_ParentGoneRelocatesRoot(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	if err := os.MkdirAll(filepath.Join(projPath, "gone"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "gone", "orphan.txt"), []byte("orphan"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"gone/orphan.txt"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	// 父目录随后也被删：恢复时 gone/ 已不存在
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"gone"}`); w.Code != http.StatusOK {
		t.Fatalf("delete dir status = %d", w.Code)
	}
	entries := mustListTrash(t, r, 2)
	var orphan *trashEntry
	for i := range entries {
		if entries[i].Path == "gone/orphan.txt" {
			orphan = &entries[i]
		}
	}
	if orphan == nil {
		t.Fatalf("orphan 条目缺失: %+v", entries)
	}

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+orphan.ID+"/restore", "")
	if w.Code != http.StatusOK {
		t.Fatalf("restore status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		RestoredPath string `json:"restoredPath"`
		Relocated    bool   `json:"relocated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Relocated || resp.RestoredPath != "orphan.txt" {
		t.Fatalf("应落根 relocated=true: %+v", resp)
	}
	got, err := os.ReadFile(filepath.Join(projPath, "orphan.txt"))
	if err != nil || string(got) != "orphan" {
		t.Fatalf("根区内容 = %q (err=%v)", got, err)
	}
}

// TestTrashPurge 彻底删除 → 条目消失；再删同 id → 404
func TestTrashPurge(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	if err := os.WriteFile(filepath.Join(projPath, "p.txt"), []byte("p"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"p.txt"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	entries := mustListTrash(t, r, 1)
	w := doFileJSON(t, r, http.MethodDelete, "/api/projects/proj-test/trash/"+entries[0].ID, "")
	if w.Code != http.StatusOK {
		t.Fatalf("purge status = %d, body=%s", w.Code, w.Body.String())
	}
	mustListTrash(t, r, 0)
	if w := doFileJSON(t, r, http.MethodDelete, "/api/projects/proj-test/trash/"+entries[0].ID, ""); w.Code != http.StatusNotFound {
		t.Fatalf("再删 status = %d, want 404", w.Code)
	}
}

// TestTrashPurge_EntryIDTraversal entryId 路径段校验：分隔符/点段 → 400，
// 绝不触达回收站外路径
func TestTrashPurge_EntryIDTraversal(t *testing.T) {
	r, _ := setupTrashRoutes(t)
	for _, bad := range []string{"..", "a%2Fb", "a%5Cb", "sub%2F..%2Fescape"} {
		w := doFileJSON(t, r, http.MethodDelete, "/api/projects/proj-test/trash/"+bad, "")
		if w.Code == http.StatusOK {
			t.Fatalf("entryId %q 应被拒绝, body=%s", bad, w.Body.String())
		}
	}
}

// TestTrashList_DegradedEntry manifest 缺失（外部投放）→ 降级条目在列且标记
// degraded（path 空 → 前端禁恢复只留彻底删除），不炸列表端点
func TestTrashList_DegradedEntry(t *testing.T) {
	r, _ := setupTrashRoutes(t)
	if err := os.MkdirAll(filepath.Join(trashProjPath(t, "proj-test"), "junk-entry"), 0o700); err != nil {
		t.Fatal(err)
	}
	entries := mustListTrash(t, r, 1)
	if !entries[0].Degraded || entries[0].Path != "" {
		t.Fatalf("应为降级条目: %+v", entries[0])
	}
}

// TestTrashRestore_AsRename 重命名恢复（P-20261006-15）：as 只换叶子名保留
// 原父目录，占位文件不被触碰；父目录已消失时按新叶子名同语义落根
func TestTrashRestore_AsRename(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	rel := "docs/renamed.txt"
	abs := filepath.Join(projPath, "docs", "renamed.txt")
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte("as-marker"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"`+rel+`"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	// 原位置被新文件占住（409 前提），恢复为新叶子名
	if err := os.WriteFile(abs, []byte("occupy"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := mustListTrash(t, r, 1)
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+entries[0].ID+"/restore?as=renamed-2.txt", "")
	if w.Code != http.StatusOK {
		t.Fatalf("restore as status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		RestoredPath string `json:"restoredPath"`
		Relocated    bool   `json:"relocated"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.RestoredPath != "docs/renamed-2.txt" || resp.Relocated {
		t.Fatalf("应落原父目录新叶子名: %+v", resp)
	}
	got, err := os.ReadFile(filepath.Join(projPath, "docs", "renamed-2.txt"))
	if err != nil || string(got) != "as-marker" {
		t.Fatalf("新叶子名内容 = %q (err=%v)", got, err)
	}
	if occupy, err := os.ReadFile(abs); err != nil || string(occupy) != "occupy" {
		t.Fatalf("占位文件不得被触碰: %q (err=%v)", occupy, err)
	}
	mustListTrash(t, r, 0)

	// 父目录消失 + as → 落项目根、新叶子名
	if err := os.MkdirAll(filepath.Join(projPath, "gone"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "gone", "orphan.txt"), []byte("orphan"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"gone/orphan.txt"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"gone"}`); w.Code != http.StatusOK {
		t.Fatalf("delete dir status = %d", w.Code)
	}
	entries = mustListTrash(t, r, 2) // orphan.txt + 随后入站的空 gone 目录
	var orphan *trashEntry
	for i := range entries {
		if entries[i].Path == "gone/orphan.txt" {
			orphan = &entries[i]
		}
	}
	if orphan == nil {
		t.Fatalf("orphan 条目缺失: %+v", entries)
	}
	w = doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+orphan.ID+"/restore?as=orphan-2.txt", "")
	if w.Code != http.StatusOK {
		t.Fatalf("restore as (parent gone) status = %d, body=%s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.Relocated || resp.RestoredPath != "orphan-2.txt" {
		t.Fatalf("应落根 relocated=true: %+v", resp)
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "orphan-2.txt")); err != nil || string(got) != "orphan" {
		t.Fatalf("根区新叶子名内容 = %q (err=%v)", got, err)
	}
}

// TestTrashRestore_AsDirRename 目录条目 as 同语义：整树恢复为新目录名
func TestTrashRestore_AsDirRename(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	if err := os.MkdirAll(filepath.Join(projPath, "tree", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "tree", "sub", "n.md"), []byte("dir payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"tree/sub"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	entries := mustListTrash(t, r, 1)
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+entries[0].ID+"/restore?as=sub-restaged", "")
	if w.Code != http.StatusOK {
		t.Fatalf("restore dir as status = %d, body=%s", w.Code, w.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(projPath, "tree", "sub-restaged", "n.md"))
	if err != nil || string(got) != "dir payload" {
		t.Fatalf("新目录名内容 = %q (err=%v)", got, err)
	}
}

// TestTrashRestore_AsConflict409 as 命中已存在目标 → 409 原语义（服务端不做
// 步进建议——as 是精确名，agent 编程化语义可预期；步进是前端职责）
func TestTrashRestore_AsConflict409(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	abs := filepath.Join(projPath, "c.txt")
	if err := os.WriteFile(abs, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"c.txt"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	if err := os.WriteFile(abs, []byte("occupy"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "c-2.txt"), []byte("target"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries := mustListTrash(t, r, 1)
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+entries[0].ID+"/restore?as=c-2.txt", "")
	if w.Code != http.StatusConflict {
		t.Fatalf("restore as status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "c-2.txt")); err != nil || string(got) != "target" {
		t.Fatalf("as 目标不得被覆盖: %q (err=%v)", got, err)
	}
	mustListTrash(t, r, 1) // 条目仍在站，可换名重试
}

// TestTrashRestore_AsGuard 穿越与非法名拒绝（提案指定 e2e 对应单测面）：
// 分隔符/点段/Windows 保留名/段尾点 → 400 code files.name_invalid，零落盘
func TestTrashRestore_AsGuard(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	if err := os.WriteFile(filepath.Join(projPath, "g.txt"), []byte("g"), 0o644); err != nil {
		t.Fatal(err)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"g.txt"}`); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	entries := mustListTrash(t, r, 1)
	for _, bad := range []string{"..%2Fescape", "%2e%2e", "a%2Fb", "a%5Cb", "sub%2F..%2Fescape", ".", "..", "CON.txt", "trailing.", "trailing%20"} {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+entries[0].ID+"/restore?as="+bad, "")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("as %q status = %d, want 400, body=%s", bad, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "files.name_invalid") {
			t.Fatalf("as %q 应携 code files.name_invalid: %s", bad, w.Body.String())
		}
	}
	// 守卫全拒后条目原封不动（零落盘），可正常恢复
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/trash/"+entries[0].ID+"/restore", ""); w.Code != http.StatusOK {
		t.Fatalf("plain restore after guard = %d, body=%s", w.Code, w.Body.String())
	}
}

// TestPurgeExpiredTrash_Age 超期清账：deletedAtMs 早于保留窗口的条目被清，
// 新鲜条目保留
func TestPurgeExpiredTrash_Age(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(projPath, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"`+name+`"}`); w.Code != http.StatusOK {
			t.Fatalf("delete %s status = %d", name, w.Code)
		}
	}
	write("old.txt", "old")
	write("fresh.txt", "fresh")

	// 把 old 条目的 manifest 改成 8 天前
	entries := mustListTrash(t, r, 2)
	for _, e := range entries {
		if !strings.Contains(e.ID, "old.txt") {
			continue
		}
		mp := filepath.Join(trashProjPath(t, "proj-test"), e.ID, "manifest.json")
		data, err := os.ReadFile(mp)
		if err != nil {
			t.Fatal(err)
		}
		var m trashManifest
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatal(err)
		}
		m.DeletedAtMs = time.Now().Add(-8 * 24 * time.Hour).UnixMilli()
		patched, _ := json.Marshal(m)
		if err := os.WriteFile(mp, patched, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	PurgeExpiredTrash()
	remaining := mustListTrash(t, r, 1)
	if !strings.Contains(remaining[0].ID, "fresh.txt") {
		t.Fatalf("应只剩 fresh 条目: %+v", remaining)
	}
}

// TestPurgeExpiredTrash_TotalSizeCap 总量上限清账：灌小档位验证逐最旧——
// 500MB 档位不可实测，经 trashMaxTotalBytes 测试缝降档到 10 字节：
// 灌 3×5B 条目必逐最旧两条，仅本测试进程内生效
func TestPurgeExpiredTrash_TotalSizeCap(t *testing.T) {
	r, projPath := setupTrashRoutes(t)
	prev := trashMaxTotalBytes
	trashMaxTotalBytes = 10
	defer func() { trashMaxTotalBytes = prev }()

	for _, name := range []string{"a1.txt", "a2.txt", "a3.txt"} {
		if err := os.WriteFile(filepath.Join(projPath, name), []byte("12345"), 0o644); err != nil {
			t.Fatal(err)
		}
		if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/delete", `{"path":"`+name+`"}`); w.Code != http.StatusOK {
			t.Fatalf("delete %s status = %d", name, w.Code)
		}
	}
	PurgeExpiredTrash()
	// 逐最旧到回线内即止（>10B → 逐 a1 5B → 10B ≤ 档位停）：a1 出清，a2/a3 保留
	entries := mustListTrash(t, r, 2)
	if strings.Contains(entries[1].ID, "a1.txt") || !strings.Contains(entries[1].ID, "a2.txt") {
		t.Fatalf("应逐最旧的 a1、保留 a2/a3: %+v", entries)
	}
}
