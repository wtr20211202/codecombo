package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── ListFlatFiles（Quick Open 扁平文件索引）handler 测试 ──
// 覆盖隐藏文件/隐藏目录纳入索引与目录跳过清单收窄（P-20261002-127）：
// skipDirNames 清单（依赖产物/构建产物/.git）仍整体排除，
// .git 指针文件（worktree/子模块布局下是文件）同样不进索引。

// fetchFlatFiles 注册指向 dir 的 fixture 项目并请求 /file-list，返回扁平条目
func fetchFlatFiles(t *testing.T, dir string) []flatFileItem {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: dir}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/api/projects/:id/file-list", ListFlatFiles)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/projects/p1/file-list", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("file-list status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Data []flatFileItem `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.Data
}

// writeTree 按 rel→content 写文件（目录自动创建），content 为 nil 时只建目录
func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func pathsOf(items []flatFileItem) map[string]bool {
	set := make(map[string]bool, len(items))
	for _, it := range items {
		set[it.Path] = true
	}
	return set
}

func TestListFlatFiles_HiddenFilesIndexed(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		".gitignore":                "node_modules\n",
		".golangci.yml":             "linters:\n",
		".github/workflows/ci.yml":  "on: push\n",
		".vscode/settings.json":     "{}",
		"src/.env":                  "K=V\n",
		"src/main.go":               "package main\n",
		"node_modules/pkg/index.js": "module.exports = 1",
		"dist/bundle.js":            "console.log(1)",
		"build/out.bin":             "\x00\x01",
		".cache/tmp/artifact":       "x",
		"vendor/lib/lib.go":         "package lib\n",
	})

	got := pathsOf(fetchFlatFiles(t, dir))

	// 隐藏文件（含嵌套于隐藏目录/普通目录下）均进索引
	for _, want := range []string{
		".gitignore", ".golangci.yml",
		".github/workflows/ci.yml", ".vscode/settings.json", "src/.env",
	} {
		if !got[want] {
			t.Errorf("hidden file %q missing from flat list", want)
		}
	}
	// 普通文件不受影响
	if !got["src/main.go"] {
		t.Errorf("normal file src/main.go missing from flat list")
	}
	// 跳过清单（skipDirNames）仍整体排除，收窄不放宽清单本身
	for _, absent := range []string{
		"node_modules/pkg/index.js", "dist/bundle.js", "build/out.bin",
		".cache/tmp/artifact", "vendor/lib/lib.go",
	} {
		if got[absent] {
			t.Errorf("skipped-dir file %q should not be indexed", absent)
		}
	}
}

func TestListFlatFiles_GitDirAndPointerFileExcluded(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		".gitignore": "dist\n",
		"main.go":    "package main\n",
	})
	// .git 目录（常规布局）——已在 skipDirNames，走目录分支被跳过
	if err := os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := pathsOf(fetchFlatFiles(t, dir))
	if got[".git/HEAD"] {
		t.Errorf(".git dir content should not be indexed")
	}
	if !got[".gitignore"] || !got["main.go"] {
		t.Fatalf("expected .gitignore and main.go indexed, got %v", got)
	}

	// .git 指针文件（worktree/子模块布局：.git 是文件而非目录）——同样不进索引
	wt := t.TempDir()
	writeTree(t, wt, map[string]string{
		".git":       "gitdir: /somewhere/else/.git/worktrees/x\n",
		".gitignore": "dist\n",
	})
	gotWt := pathsOf(fetchFlatFiles(t, wt))
	if gotWt[".git"] {
		t.Errorf(".git pointer file should not be indexed")
	}
	if !gotWt[".gitignore"] {
		t.Errorf("hidden file .gitignore missing in worktree layout")
	}
}

func TestListFlatFiles_MaxCapStopsWalk(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{"a.go": "package a\n", ".hidden.txt": "h\n"}
	for i := 0; i < 20; i++ {
		files[filepath.Join("many", string(rune('a'+i))+".txt")] = "x"
	}
	writeTree(t, dir, files)

	// max 生效：条目数不超过 max；截断后 StopAll 语义由调用方（前端）提示
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "p1", Name: "t", Path: dir}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/api/projects/:id/file-list", ListFlatFiles)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/projects/p1/file-list?max=5", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("file-list status = %d", w.Code)
	}
	var resp struct {
		Data []flatFileItem `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Data) > 5 {
		t.Errorf("expected at most 5 items with max=5, got %d", len(resp.Data))
	}
}

// gitignore 语义（Quick Open 索引不入 .gitignore 内文件）：未跟踪残留物
// （导出器/e2e 在仓内跑出的 release/、.sc-tmp/ 等）不再进索引——同名歧义与
// 噪声目录（「移动到…」清单被冲爆 RENDER_CAP）都由此断根。真实 git 仓库夹具
// （fresh init 零提交即可，ls-files -o -i 不依赖 HEAD）；tracked 探针与
// 未跟踪未忽略探针均须在列——语义是「不入 ignore 内文件」，不是「仅 tracked」
func TestListFlatFiles_GitIgnoredExcluded(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		".gitignore":                   "leftover/\nrelease/\n*.tmp\n",
		".golangci.yml":                "linters:\n",
		"src/main.go":                  "package main\n",
		"leftover/.golangci.yml":       "linters:\n", // 整目录 ignore：不进索引
		"release/public/.golangci.yml": "linters:\n",
		"noise.tmp":                    "x",               // 文件级 ignore：不进索引
		"fresh-untracked.go":           "package fresh\n", // 未跟踪未忽略：仍进索引
	})
	for _, args := range [][]string{
		{"init", "-q", "."},
		{"config", "core.autocrlf", "false"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git 不可用或 init 失败（%v: %s）", err, out)
		}
	}

	got := pathsOf(fetchFlatFiles(t, dir))

	for _, absent := range []string{
		"leftover/.golangci.yml", "release/public/.golangci.yml", "noise.tmp",
	} {
		if got[absent] {
			t.Errorf("gitignored %q should not be indexed", absent)
		}
	}
	for _, want := range []string{".gitignore", ".golangci.yml", "src/main.go", "fresh-untracked.go"} {
		if !got[want] {
			t.Errorf("non-ignored %q missing from flat list", want)
		}
	}
}
