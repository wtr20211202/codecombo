package files

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 本地文件历史 handler 测试（P-20261002-130）：快照钩子（写路径全覆盖 /
// 二进制跳过 / 首建不留档）与三端点（列表 / 单版内容 / 恢复闭环）。

// setupHistoryTest 路由形态同生产注册（router.go 文件组）：写路径 + 历史三端点
func setupHistoryTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	projPath := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID:   "proj-test",
		Name: "test",
		Path: projPath,
	}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	g := r.Group("/api/projects/:id")
	{
		g.PUT("/file", WriteFile)
		g.POST("/file/rename", RenameFile)
		g.GET("/file/history", FileHistoryList)
		g.GET("/file/history/content", FileHistoryContent)
		g.POST("/file/history/restore", FileHistoryRestore)
	}
	return r, projPath
}

// historyVersions 解列表响应（data: [{id,ts,size}]）
func historyVersions(t *testing.T, w *httptest.ResponseRecorder) []store.FileVersion {
	t.Helper()
	var resp struct {
		Data []store.FileVersion `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("list body: %v (%s)", err, w.Body.String())
	}
	return resp.Data
}

// TestHistory_WritePathSnapshots 写三次 → 2 个旧版本在档：首建（无旧内容）
// 不留档，两次覆盖各留一版；内容端点取回字节一致
func TestHistory_WritePathSnapshots(t *testing.T) {
	r, projPath := setupHistoryTest(t)

	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"a.txt","content":"v1"}`)
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"a.txt","content":"v2"}`)
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"a.txt","content":"v3"}`)

	w := doFileJSON(t, r, http.MethodGet, "/api/projects/proj-test/file/history?path=a.txt", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d", w.Code)
	}
	versions := historyVersions(t, w)
	if len(versions) != 2 {
		t.Fatalf("versions = %d, want 2（v1/v2 在档，v3 是当前盘上内容不留档）", len(versions))
	}

	// 内容端点：取最旧版 v1
	w = doFileJSON(t, r, http.MethodGet, "/api/projects/proj-test/file/history/content?path=a.txt&id="+versions[1].ID, "")
	if w.Code != http.StatusOK {
		t.Fatalf("content status = %d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data string `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Data != "v1" {
		t.Fatalf("oldest version = %q, want v1", resp.Data)
	}

	// 列表携带尺寸（台账补齐）
	if versions[1].Size != 2 {
		t.Fatalf("oldest size = %d, want 2", versions[1].Size)
	}
	_ = projPath
}

// TestHistory_RestoreClosedLoop 恢复闭环：恢复 v1 → 磁盘回滚且恢复前状态
// （v3）自动入档——回滚本身可再撤销
func TestHistory_RestoreClosedLoop(t *testing.T) {
	r, projPath := setupHistoryTest(t)
	for _, v := range []string{"v1", "v2", "v3"} {
		doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file",
			fmt.Sprintf(`{"path":"a.txt","content":%q}`, v))
	}

	versions := historyVersions(t, getHistory(t, r, "/api/projects/proj-test/file/history?path=a.txt"))
	if len(versions) != 2 {
		t.Fatalf("before restore versions = %d, want 2", len(versions))
	}
	oldest := versions[1].ID

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/history/restore",
		fmt.Sprintf(`{"path":"a.txt","id":%q}`, oldest))
	if w.Code != http.StatusOK {
		t.Fatalf("restore status = %d body=%s", w.Code, w.Body.String())
	}
	disk, err := os.ReadFile(filepath.Join(projPath, "a.txt"))
	if err != nil || string(disk) != "v1" {
		t.Fatalf("disk = %q (err=%v), want v1", disk, err)
	}

	// 恢复前状态（v3）入档：列表变 3 版，可再恢复回 v3 撤销本次回滚
	versions = historyVersions(t, getHistory(t, r, "/api/projects/proj-test/file/history?path=a.txt"))
	if len(versions) != 3 {
		t.Fatalf("after restore versions = %d, want 3（恢复前状态入档）", len(versions))
	}
	var latest struct {
		Data string `json:"data"`
	}
	rw := doFileJSON(t, r, http.MethodGet, "/api/projects/proj-test/file/history/content?path=a.txt&id="+versions[0].ID, "")
	_ = json.Unmarshal(rw.Body.Bytes(), &latest)
	if latest.Data != "v3" {
		t.Fatalf("latest snapshot = %q, want v3（恢复前状态）", latest.Data)
	}

	// 恢复到恢复前状态 = 撤销回滚
	doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/history/restore",
		fmt.Sprintf(`{"path":"a.txt","id":%q}`, versions[0].ID))
	disk, _ = os.ReadFile(filepath.Join(projPath, "a.txt"))
	if string(disk) != "v3" {
		t.Fatalf("undo disk = %q, want v3", disk)
	}
}

// TestHistory_BinarySkipped 二进制不留档（.bin 扩展名即判 binary，
// filepolicy.binaryByExt 同口径）
func TestHistory_BinarySkipped(t *testing.T) {
	r, projPath := setupHistoryTest(t)
	bin := filepath.Join(projPath, "logo.bin")
	if err := os.WriteFile(bin, []byte{0x00, 0x01, 0x02}, 0644); err != nil {
		t.Fatal(err)
	}
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"logo.bin","content":"replaced"}`)

	if versions := historyVersions(t, getHistory(t, r, "/api/projects/proj-test/file/history?path=logo.bin")); len(versions) != 0 {
		t.Fatalf("binary versions = %d, want 0（二进制跳过）", len(versions))
	}
}

// TestHistory_PathNormalization 快照与查询共用归一尺子：写入用 "a.txt"、
// 查询用 "./a.txt"（或反之）落同一键
func TestHistory_PathNormalization(t *testing.T) {
	r, _ := setupHistoryTest(t)
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"a.txt","content":"v1"}`)
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"./a.txt","content":"v2"}`)

	versions := historyVersions(t, getHistory(t, r, "/api/projects/proj-test/file/history?path=a.txt"))
	if len(versions) != 1 {
		t.Fatalf("versions = %d, want 1（归一后同键，v1 恰留一档）", len(versions))
	}
	versions = historyVersions(t, getHistory(t, r, "/api/projects/proj-test/file/history?path=./a.txt"))
	if len(versions) != 1 {
		t.Fatalf("query ./a.txt versions = %d, want 1", len(versions))
	}
}

// TestHistory_RenameSnapshotsOldPath 重命名快照挂在旧路径名下：恢复可写回
// 旧路径原位找回（重命名反悔入口）。同内容去重使 409 被拒的改名不留噪声
func TestHistory_RenameSnapshotsOldPath(t *testing.T) {
	r, projPath := setupHistoryTest(t)
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"a.txt","content":"v1"}`)
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"a.txt","content":"v2"}`)
	doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/rename",
		`{"oldPath":"a.txt","newPath":"b.txt"}`)

	if _, err := os.Stat(filepath.Join(projPath, "b.txt")); err != nil {
		t.Fatalf("rename failed: %v", err)
	}
	// 旧路径快照在档：v1（首次覆盖留档）+ v2（重命名挪走前留档）
	versions := historyVersions(t, getHistory(t, r, "/api/projects/proj-test/file/history?path=a.txt"))
	if len(versions) != 2 {
		t.Fatalf("a.txt versions = %d, want 2", len(versions))
	}

	// 恢复旧路径最新版 → a.txt 原位找回重命名前内容
	doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/history/restore",
		fmt.Sprintf(`{"path":"a.txt","id":%q}`, versions[0].ID))
	disk, err := os.ReadFile(filepath.Join(projPath, "a.txt"))
	if err != nil || string(disk) != "v2" {
		t.Fatalf("restored a.txt = %q (err=%v), want v2", disk, err)
	}
}

// TestHistory_RestoreGuards 恢复端点防御：未知版本 404、越界路径 403、
// 缺参 400
func TestHistory_RestoreGuards(t *testing.T) {
	r, _ := setupHistoryTest(t)
	doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", `{"path":"a.txt","content":"v1"}`)

	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/history/restore",
		`{"path":"a.txt","id":"0000000000000000"}`); w.Code != http.StatusNotFound {
		t.Fatalf("unknown id status = %d, want 404", w.Code)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/history/restore",
		`{"path":"../escape.txt","id":"0000000000000000"}`); w.Code != http.StatusForbidden {
		t.Fatalf("traversal status = %d, want 403", w.Code)
	}
	if w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/file/history/restore",
		`{"path":"","id":""}`); w.Code != http.StatusBadRequest {
		t.Fatalf("missing args status = %d, want 400", w.Code)
	}
	// 列表对无历史路径返回空集而非报错（删除后文件仍可查档）
	if versions := historyVersions(t, getHistory(t, r, "/api/projects/proj-test/file/history?path=ghost.txt")); len(versions) != 0 {
		t.Fatalf("ghost versions = %d, want 0", len(versions))
	}
}

// getHistory 小工具：GET 快捷
func getHistory(t *testing.T, r *gin.Engine, target string) *httptest.ResponseRecorder {
	t.Helper()
	return doFileJSON(t, r, http.MethodGet, target, "")
}
