package files

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// batch copy 形态（P-20261023-2）行为锚定：同名「-副本N」步进自动改名（绝不
// 覆盖既有条目）、目录递归整树复制、目标目录嵌套在源条目子树内拒绝（防自吞）、
// 嵌套条目随父 skipped、审计与单条面同粒度。路由形态同生产注册（router.go 的
// /files/batch，setupBatchTest 同 batch_test.go）。

// TestBatch_Copy_Files_OK 多文件一次调用全成：源保留（复制语义）、目标落地
func TestBatch_Copy_Files_OK(t *testing.T) {
	r, projPath := setupBatchTest(t)
	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(projPath, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(projPath, "dest"), 0755); err != nil {
		t.Fatal(err)
	}

	resp, code := doBatch(t, r, `{"action":"copy","entries":["a.txt","b.txt"],"destDir":"dest"}`)
	if code != http.StatusOK || resp == nil {
		t.Fatalf("status = %d", code)
	}
	if resp.OK != 2 || resp.Failed != 0 {
		t.Fatalf("counters = ok:%d failed:%d, want 2/0", resp.OK, resp.Failed)
	}
	for _, name := range []string{"a.txt", "b.txt"} {
		got, err := os.ReadFile(filepath.Join(projPath, "dest", name))
		if err != nil || string(got) != name {
			t.Fatalf("dest/%s = %q (err=%v)", name, got, err)
		}
		// 复制语义：源必须保留（与 move 的根本区别）
		if _, err := os.Stat(filepath.Join(projPath, name)); err != nil {
			t.Fatalf("源 %s 被移动而非复制: %v", name, err)
		}
	}
}

// TestBatch_Copy_SameName_SteppedRename 同名默认「-副本」步进改名，绝不覆盖：
// 首次复制 → <stem>-副本<ext>，再次复制 → <stem>-副本2<ext>，内容各归各
func TestBatch_Copy_SameName_SteppedRename(t *testing.T) {
	r, projPath := setupBatchTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "doc.md"), []byte("v0"), 0644); err != nil {
		t.Fatal(err)
	}

	// 第一次复制到同目录：doc-副本.md
	resp, code := doBatch(t, r, `{"action":"copy","entries":["doc.md"],"destDir":""}`)
	if code != http.StatusOK || resp.OK != 1 {
		t.Fatalf("first copy: status=%d resp=%+v", code, resp)
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "doc-副本.md")); err != nil || string(got) != "v0" {
		t.Fatalf("doc-副本.md = %q (err=%v)", got, err)
	}
	// 源与既有目标原样（复制不覆盖）
	if got, _ := os.ReadFile(filepath.Join(projPath, "doc.md")); string(got) != "v0" {
		t.Fatalf("doc.md 被改动: %q", got)
	}

	// 第二次复制：doc-副本2.md（步进，不覆盖第一份副本）
	if _, code := doBatch(t, r, `{"action":"copy","entries":["doc.md"],"destDir":""}`); code != http.StatusOK {
		t.Fatalf("second copy status = %d", code)
	}
	if got, err := os.ReadFile(filepath.Join(projPath, "doc-副本2.md")); err != nil || string(got) != "v0" {
		t.Fatalf("doc-副本2.md = %q (err=%v)", got, err)
	}
	// 第一份副本未被覆盖（内容各归各）
	if got, _ := os.ReadFile(filepath.Join(projPath, "doc-副本.md")); string(got) != "v0" {
		t.Fatalf("doc-副本.md 被第二次复制覆盖")
	}
}

// TestBatch_Copy_Dir_Recursive 目录条目递归整树：子目录结构与内容保真，源保留
func TestBatch_Copy_Dir_Recursive(t *testing.T) {
	r, projPath := setupBatchTest(t)
	if err := os.MkdirAll(filepath.Join(projPath, "src", "inner"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "src", "top.txt"), []byte("top"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "src", "inner", "deep.txt"), []byte("deep"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projPath, "dest"), 0755); err != nil {
		t.Fatal(err)
	}

	resp, code := doBatch(t, r, `{"action":"copy","entries":["src"],"destDir":"dest"}`)
	if code != http.StatusOK || resp.OK != 1 {
		t.Fatalf("status = %d resp=%+v", code, resp)
	}
	for _, p := range []string{filepath.Join("dest", "src", "top.txt"), filepath.Join("dest", "src", "inner", "deep.txt")} {
		if _, err := os.Stat(filepath.Join(projPath, p)); err != nil {
			t.Fatalf("递归复制缺 %s: %v", p, err)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(projPath, "dest", "src", "inner", "deep.txt")); string(got) != "deep" {
		t.Fatalf("deep.txt 内容 = %q", got)
	}
	// 源树保留
	if _, err := os.Stat(filepath.Join(projPath, "src", "inner", "deep.txt")); err != nil {
		t.Fatalf("源子树被移动: %v", err)
	}
}

// TestBatch_Copy_DestInsideSource_Skipped 目标目录在源条目子树内（含相等）：
// 复制会把源子树写进它自己（无终止），逐条 skipped 零落盘
func TestBatch_Copy_DestInsideSource_Skipped(t *testing.T) {
	r, projPath := setupBatchTest(t)
	if err := os.MkdirAll(filepath.Join(projPath, "tree", "sub"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "tree", "f.txt"), []byte("f"), 0644); err != nil {
		t.Fatal(err)
	}

	// dest = tree/sub（在源 tree 子树内）→ skipped；同批健康条目照常
	resp, code := doBatch(t, r, `{"action":"copy","entries":["tree"],"destDir":"tree/sub"}`)
	if code != http.StatusOK || resp == nil {
		t.Fatalf("status = %d", code)
	}
	if res := resultByPath(resp, "tree"); res == nil || res.Status != batchStatusSkipped {
		t.Fatalf("result[tree] = %+v, want skipped", res)
	}
	// dest = tree（相等）→ skipped
	resp, code = doBatch(t, r, `{"action":"copy","entries":["tree"],"destDir":"tree"}`)
	if code != http.StatusOK {
		t.Fatalf("self copy status = %d", code)
	}
	if res := resultByPath(resp, "tree"); res == nil || res.Status != batchStatusSkipped {
		t.Fatalf("self copy result = %+v, want skipped", res)
	}
	// 子树内零新增（无自吞产物）
	entries, err := os.ReadDir(filepath.Join(projPath, "tree", "sub"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("tree/sub 应保持为空，实有 %d 项", len(entries))
	}
}

// TestBatch_Copy_NestedEntries_Covered 嵌套条目随父 skipped（dedupBatchNested
// 既有规则对 copy 同样生效）
func TestBatch_Copy_NestedEntries_Covered(t *testing.T) {
	r, projPath := setupBatchTest(t)
	if err := os.MkdirAll(filepath.Join(projPath, "parent"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "parent", "kid.txt"), []byte("kid"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projPath, "dest"), 0755); err != nil {
		t.Fatal(err)
	}

	resp, code := doBatch(t, r, `{"action":"copy","entries":["parent","parent/kid.txt"],"destDir":"dest"}`)
	if code != http.StatusOK || resp.OK != 1 || resp.Skipped != 1 {
		t.Fatalf("counters = ok:%d skipped:%d (status %d)", resp.OK, resp.Skipped, code)
	}
	if res := resultByPath(resp, "parent/kid.txt"); res == nil || res.Status != batchStatusSkipped {
		t.Fatalf("result[parent/kid.txt] = %+v, want skipped", res)
	}
	if _, err := os.Stat(filepath.Join(projPath, "dest", "parent", "kid.txt")); err != nil {
		t.Fatalf("父目录整树复制应含 kid.txt: %v", err)
	}
}

// TestBatch_Copy_InvalidAction 与既有三形态并列后的 action 白名单措辞
func TestBatch_Copy_InvalidAction(t *testing.T) {
	r, _ := setupBatchTest(t)
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/files/batch", `{"action":"chmod","entries":["a"]}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}
