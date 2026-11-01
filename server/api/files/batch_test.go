package files

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 文件批量操作端点（P-20261006-39）行为锚定：三形态（move/delete/rename）
// 逐条结构化结果、失败不中断批次、护栏（单批 ≤200）、路径校验复用单条面
// （P-132 名校验 / P-117 目标防护 / 边界拒绝）。路由形态同生产注册
// （router.go 的 /files/batch）。

func setupBatchTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupFileOpsTest(t)
	g := r.Group("/api/projects/:id")
	g.POST("/files/batch", BatchFiles)
	g.GET("/trash", TrashList)
	return r, projPath
}

type batchResult struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Error  string `json:"error"`
}

type batchResponse struct {
	Action  string        `json:"action"`
	OK      int           `json:"ok"`
	Skipped int           `json:"skipped"`
	Failed  int           `json:"failed"`
	Results []batchResult `json:"results"`
}

func doBatch(t *testing.T, r *gin.Engine, body string) (*batchResponse, int) {
	t.Helper()
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/files/batch", body)
	if w.Code != http.StatusOK {
		return nil, w.Code
	}
	var resp batchResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response unmarshal: %v (body=%s)", err, w.Body.String())
	}
	return &resp, w.Code
}

func resultByPath(resp *batchResponse, path string) *batchResult {
	for i := range resp.Results {
		if resp.Results[i].Path == path {
			return &resp.Results[i]
		}
	}
	return nil
}

// TestBatch_Move_OK 三文件一次调用全成：磁盘落位、逐条 ok、审计同粒度
func TestBatch_Move_OK(t *testing.T) {
	r, projPath := setupBatchTest(t)
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(projPath, name)), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(projPath, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(projPath, "dest"), 0755); err != nil {
		t.Fatal(err)
	}

	resp, code := doBatch(t, r,`{"action":"move","entries":["a.txt","b.txt","c.txt"],"destDir":"dest"}`)
	if code != http.StatusOK || resp == nil {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 3 || resp.Failed != 0 || len(resp.Results) != 3 {
		t.Fatalf("counters = ok:%d failed:%d results:%d, want 3/0/3", resp.OK, resp.Failed, len(resp.Results))
	}
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if got, err := os.ReadFile(filepath.Join(projPath, "dest", name)); err != nil || string(got) != name {
			t.Fatalf("dest/%s = %q (err=%v)", name, got, err)
		}
		if _, err := os.Stat(filepath.Join(projPath, name)); !os.IsNotExist(err) {
			t.Fatalf("旧路径 %s 未消失", name)
		}
		if res := resultByPath(resp, name); res == nil || res.Status != batchStatusOK {
			t.Fatalf("result[%s] = %+v, want ok", name, res)
		}
	}
}

// TestBatch_Move_TargetExists 目标已存在（P-117）→ 逐条 error「file already exists」
// 与单条端点同串，批次不中断（其余条目照常落地）
func TestBatch_Move_TargetExists(t *testing.T) {
	r, projPath := setupBatchTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "dup.txt"), []byte("dup"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "solo.txt"), []byte("solo"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projPath, "dest"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "dest", "dup.txt"), []byte("existing"), 0644); err != nil {
		t.Fatal(err)
	}

	resp, code := doBatch(t, r,`{"action":"move","entries":["dup.txt","solo.txt"],"destDir":"dest"}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200（部分成败也是 200）", code)
	}
	if resp.OK != 1 || resp.Failed != 1 {
		t.Fatalf("counters = ok:%d failed:%d, want 1/1", resp.OK, resp.Failed)
	}
	if res := resultByPath(resp, "dup.txt"); res == nil || res.Status != batchStatusError || res.Error != fileAlreadyExistsMsg {
		t.Fatalf("dup result = %+v, want error %q", res, fileAlreadyExistsMsg)
	}
	// 既有目标未被静默覆盖；其余条目照常落地
	if got, _ := os.ReadFile(filepath.Join(projPath, "dest", "dup.txt")); string(got) != "existing" {
		t.Fatalf("dest/dup.txt 被覆盖: %q", got)
	}
	if _, err := os.Stat(filepath.Join(projPath, "dest", "solo.txt")); err != nil {
		t.Fatalf("solo 未随批落地: %v", err)
	}
}

// TestBatch_Move_NestedAndInsideSelf 嵌套条目随父去重（skipped）、移入自身子树
// 语义 no-op（skipped）——P-160 前端逐条跳过语义服务端化
func TestBatch_Move_NestedAndInsideSelf(t *testing.T) {
	r, projPath := setupBatchTest(t)
	for _, d := range []string{"parent", "parent/child", "dest"} {
		if err := os.MkdirAll(filepath.Join(projPath, d), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(projPath, "parent", "f.txt"), []byte("f"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "parent", "child", "g.txt"), []byte("g"), 0644); err != nil {
		t.Fatal(err)
	}

	// parent/child 与 parent/child/g.txt 嵌套重复；dest 移入 dest/parent 自身子树不适用
	// ——dest 在 entries 里 = 把 dest 移入 dest = insideSelf
	resp, code := doBatch(t, r,
		`{"action":"move","entries":["parent","parent/child","parent/child/g.txt","dest"],"destDir":"dest"}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 1 || resp.Skipped != 3 || resp.Failed != 0 {
		t.Fatalf("counters = ok:%d skipped:%d failed:%d, want 1/3/0", resp.OK, resp.Skipped, resp.Failed)
	}
	// 父目录整体挪入（child 与 g.txt 随行）；child/g.txt 条目被父覆盖 skipped
	if _, err := os.Stat(filepath.Join(projPath, "dest", "parent", "child", "g.txt")); err != nil {
		t.Fatalf("父目录未整体挪入: %v", err)
	}
	if res := resultByPath(resp, "parent/child"); res == nil || res.Status != batchStatusSkipped {
		t.Fatalf("child result = %+v, want skipped", res)
	}
	if res := resultByPath(resp, "dest"); res == nil || res.Status != batchStatusSkipped || res.Error != errBatchInsideSelf.Error() {
		t.Fatalf("dest result = %+v, want skipped inside-self", res)
	}
}

// TestBatch_Move_DestDirInvalid destDir 越界 → 整请求 400（形态错误零执行）
func TestBatch_Move_DestDirInvalid(t *testing.T) {
	r, projPath := setupBatchTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("a"), 0644); err != nil {
		t.Fatal(err)
	}
	resp, code := doBatch(t, r,`{"action":"move","entries":["a.txt"],"destDir":"../outside"}`)
	if code != http.StatusForbidden || resp != nil {
		t.Fatalf("status = %d, want 403", code)
	}
	if _, err := os.Stat(filepath.Join(projPath, "a.txt")); err != nil {
		t.Fatalf("零执行被破坏: %v", err)
	}
}

// TestBatch_Delete_OK 逐条入回收站：项目内消失、results 全 ok；不存在的条目
// 幂等 ok（与单条 DeleteFile 对不存在路径的原语义对齐）
func TestBatch_Delete_OK(t *testing.T) {
	r, projPath := setupBatchTest(t)
	for _, name := range []string{"x.txt", "y.txt"} {
		if err := os.WriteFile(filepath.Join(projPath, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}

	resp, code := doBatch(t, r,`{"action":"delete","entries":["x.txt","y.txt","ghost.txt"]}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 3 || resp.Failed != 0 {
		t.Fatalf("counters = ok:%d failed:%d, want 3/0（ghost 幂等）", resp.OK, resp.Failed)
	}
	for _, name := range []string{"x.txt", "y.txt"} {
		if _, err := os.Stat(filepath.Join(projPath, name)); !os.IsNotExist(err) {
			t.Fatalf("%s 未删除", name)
		}
	}
	// 回收站可查（P-304 删除即入站，7 天内可恢复）
	w := doFileJSON(t, r, http.MethodGet, "/api/projects/proj-test/trash", "")
	if w.Code != http.StatusOK {
		t.Fatalf("trash list status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "x.txt") {
		t.Fatalf("回收站缺 x.txt: %s", w.Body.String())
	}
}

// TestBatch_Delete_RootRejected 项目根删除 → 逐条 error（单条面 403 同语义）
func TestBatch_Delete_RootRejected(t *testing.T) {
	r, _ := setupBatchTest(t)
	resp, code := doBatch(t, r,`{"action":"delete","entries":[".","sub"]}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if res := resultByPath(resp, "."); res == nil || res.Status != batchStatusError || res.Error != "cannot delete project root" {
		t.Fatalf("root result = %+v", res)
	}
}

// TestBatch_Delete_PathOutside 路径越界 → 逐条 error，批次不中断
func TestBatch_Delete_PathOutside(t *testing.T) {
	r, projPath := setupBatchTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "ok.txt"), []byte("ok"), 0644); err != nil {
		t.Fatal(err)
	}
	resp, code := doBatch(t, r,`{"action":"delete","entries":["../escape.txt","ok.txt"]}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 1 || resp.Failed != 1 {
		t.Fatalf("counters = ok:%d failed:%d, want 1/1", resp.OK, resp.Failed)
	}
	if res := resultByPath(resp, "../escape.txt"); res == nil || res.Status != batchStatusError || res.Error != "path traversal not allowed" {
		t.Fatalf("escape result = %+v", res)
	}
}

// TestBatch_Rename_OK 逐对改名全成：父目录先于子项时子项旧路径自动改写
// （前缀映射 resolve，P-283 前端执行链的服务端化）
func TestBatch_Rename_OK(t *testing.T) {
	r, projPath := setupBatchTest(t)
	for _, d := range []string{"src/inner"} {
		if err := os.MkdirAll(filepath.Join(projPath, d), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(projPath, "src", "a.txt"), []byte("a"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "src", "inner", "b.txt"), []byte("b"), 0644); err != nil {
		t.Fatal(err)
	}

	// src → dst（目录），src/inner → src/in2（子目录，路径经前缀映射改写为 dst/in2），
	// dst/in2/b.txt（孙文件，两跳前缀收敛）
	body := `{"action":"rename","renames":[` +
		`{"oldPath":"src","newPath":"dst"},` +
		`{"oldPath":"src/inner","newPath":"src/in2"},` +
		`{"oldPath":"src/inner/b.txt","newPath":"src/inner/b2.txt"}]}`
	resp, code := doBatch(t, r,body)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 3 || resp.Failed != 0 {
		t.Fatalf("counters = ok:%d failed:%d, want 3/0, results=%+v", resp.OK, resp.Failed, resp.Results)
	}
	if _, err := os.Stat(filepath.Join(projPath, "dst", "a.txt")); err != nil {
		t.Fatalf("dst/a.txt 缺失: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projPath, "dst", "in2", "b2.txt")); err != nil {
		t.Fatalf("dst/in2/b2.txt 缺失（前缀改写未收敛）: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projPath, "src")); !os.IsNotExist(err) {
		t.Fatalf("旧目录 src 未消失")
	}
}

// TestBatch_Rename_TargetExistsAndInvalidName 目标已存在（P-117 同串）与
// 跨平台非法名（P-132）→ 逐对 error，批次不中断
func TestBatch_Rename_TargetExistsAndInvalidName(t *testing.T) {
	r, projPath := setupBatchTest(t)
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(projPath, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	// b.txt → a.txt（目标已存在）；c.txt → con.txt（Windows 保留设备名）
	body := `{"action":"rename","renames":[` +
		`{"oldPath":"b.txt","newPath":"a.txt"},` +
		`{"oldPath":"c.txt","newPath":"con.txt"}]}`
	resp, code := doBatch(t, r,body)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 0 || resp.Failed != 2 {
		t.Fatalf("counters = ok:%d failed:%d, want 0/2", resp.OK, resp.Failed)
	}
	if res := resultByPath(resp, "b.txt"); res == nil || res.Error != fileAlreadyExistsMsg {
		t.Fatalf("b result = %+v, want %q", res, fileAlreadyExistsMsg)
	}
	if res := resultByPath(resp, "c.txt"); res == nil || !strings.HasPrefix(res.Error, "invalid file name: ") {
		t.Fatalf("c result = %+v, want invalid file name prefix", res)
	}
	// 零落地：两个源文件原位保留
	for _, name := range []string{"b.txt", "c.txt"} {
		if _, err := os.Stat(filepath.Join(projPath, name)); err != nil {
			t.Fatalf("%s 未保留: %v", name, err)
		}
	}
}

// TestBatch_Rename_InBatchCollision 批内撞名：两对改到同一新路径，先到先得、
// 后到者 error（目标已被前对占住 →「file already exists」）
func TestBatch_Rename_InBatchCollision(t *testing.T) {
	r, projPath := setupBatchTest(t)
	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(projPath, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	resp, code := doBatch(t, r,
		`{"action":"rename","renames":[{"oldPath":"a.txt","newPath":"z.txt"},{"oldPath":"b.txt","newPath":"z.txt"}]}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 1 || resp.Failed != 1 {
		t.Fatalf("counters = ok:%d failed:%d, want 1/1", resp.OK, resp.Failed)
	}
	if res := resultByPath(resp, "b.txt"); res == nil || res.Error != fileAlreadyExistsMsg {
		t.Fatalf("b result = %+v", res)
	}
	if got, _ := os.ReadFile(filepath.Join(projPath, "z.txt")); string(got) != "a.txt" {
		t.Fatalf("z.txt = %q, want 先到者内容 a.txt", got)
	}
}

// TestBatch_Guardrails 爆量护栏：>200 条目 400；空条目 400；未知 action 400；
// 请求体非法 JSON 400
func TestBatch_Guardrails(t *testing.T) {
	r, _ := setupBatchTest(t)

	entries := make([]string, 0, batchEntriesMax+1)
	for i := 0; i <= batchEntriesMax; i++ {
		entries = append(entries, "f"+strconv.Itoa(i)+".txt")
	}
	raw, err := json.Marshal(map[string]any{"action": "delete", "entries": entries})
	if err != nil {
		t.Fatal(err)
	}
	if _, code := doBatch(t, r, string(raw)); code != http.StatusBadRequest {
		t.Fatalf("超护栏 status = %d, want 400", code)
	}

	if _, code := doBatch(t, r,`{"action":"delete","entries":[]}`); code != http.StatusBadRequest {
		t.Fatalf("空条目 status = %d, want 400", code)
	}
	if _, code := doBatch(t, r,`{"action":"chmod","entries":["a.txt"]}`); code != http.StatusBadRequest {
		t.Fatalf("未知 action status = %d, want 400", code)
	}
	if _, code := doBatch(t, r,`{not-json`); code != http.StatusBadRequest {
		t.Fatalf("非法 JSON status = %d, want 400", code)
	}
	// rename 形态条目数按 renames 计
	if _, code := doBatch(t, r,`{"action":"rename","renames":[]}`); code != http.StatusBadRequest {
		t.Fatalf("空 renames status = %d, want 400", code)
	}
}
