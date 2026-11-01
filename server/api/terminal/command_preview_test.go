package terminal

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

// 高危命令影响面预览端点单测（P-20261005-191）：模式命中 → 动态计数注入
//（fs walk / glob 展开 / git status）→ 静态降级三面。动态计数用真实临时目录
//（os.Root 无关——本端点按终端 cwd 计数，路径不经项目根锚定）

func callPreview(t *testing.T, body string) (int, map[string]any) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/terminals/command-preview", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	PreviewCommand(c)
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应非 JSON: %v (%s)", err, w.Body.String())
	}
	return w.Code, out
}

// previewData 取响应 data 段
func previewData(t *testing.T, body string) map[string]any {
	t.Helper()
	code, out := callPreview(t, body)
	if code != http.StatusOK {
		t.Fatalf("期望 200, got %d: %v", code, out)
	}
	d, _ := out["data"].(map[string]any)
	if d == nil {
		t.Fatalf("缺 data 段: %v", out)
	}
	return d
}

func firstMatch(t *testing.T, data map[string]any) map[string]any {
	t.Helper()
	matches, _ := data["matches"].([]any)
	if len(matches) == 0 {
		t.Fatalf("期望至少一条命中: %v", data)
	}
	m, _ := matches[0].(map[string]any)
	return m
}

func writePreviewFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPreviewCommandNoMatch(t *testing.T) {
	d := previewData(t, `{"command":"echo hello"}`)
	if d["level"] != "" || d["kind"] != "" {
		t.Fatalf("未命中应为空判定: %v", d)
	}
	if ms, _ := d["matches"].([]any); len(ms) != 0 {
		t.Fatalf("未命中不应有 matches: %v", d)
	}
}

func TestPreviewCommandPathsDynamic(t *testing.T) {
	dir := t.TempDir()
	writePreviewFile(t, dir, "keep.txt", "x")
	writePreviewFile(t, dir, "a.log", "aaaa")
	writePreviewFile(t, dir, "b.log", "bb")

	// rm 递归目录：fs walk 统计 + 相对路径摘要
	sub := filepath.Join(dir, "build")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	writePreviewFile(t, sub, "one.txt", "12345")
	writePreviewFile(t, sub, "two.txt", "1234567890")

	body, _ := json.Marshal(map[string]string{"command": "rm -rf build", "cwd": dir})
	d := previewData(t, string(body))
	if d["level"] != "danger" || d["kind"] != "rm" {
		t.Fatalf("rm 应为 danger/rm: %v", d)
	}
	m := firstMatch(t, d)
	dyn, _ := m["dynamic"].(map[string]any)
	if dyn == nil {
		t.Fatal("有 cwd 应注入动态计数")
	}
	if dyn["files"].(float64) != 2 {
		t.Fatalf("期望 2 个文件, got %v", dyn["files"])
	}
	if dyn["sizeHuman"] == "" {
		t.Fatalf("缺 sizeHuman: %v", dyn)
	}
	paths, _ := dyn["paths"].([]any)
	if len(paths) != 3 || paths[0] != "build" {
		t.Fatalf("路径摘要期望 build 开头 3 条（目录+2 文件）, got %v", paths)
	}

	// glob 展开：dist/*.log 只数命中的 2 个
	body, _ = json.Marshal(map[string]string{"command": "rm -f *.log", "cwd": dir})
	d = previewData(t, string(body))
	dyn = firstMatch(t, d)["dynamic"].(map[string]any)
	if dyn["files"].(float64) != 2 {
		t.Fatalf("glob 期望 2 个文件, got %v", dyn)
	}

	// 目标不存在：计数为 0（前端降级灰提示的依据面；files 零值 omitempty 缺席）
	body, _ = json.Marshal(map[string]string{"command": "rm -rf no-such-dir", "cwd": dir})
	d = previewData(t, string(body))
	dyn = firstMatch(t, d)["dynamic"].(map[string]any)
	if n, _ := dyn["files"].(float64); n != 0 || dyn["truncated"] == true {
		t.Fatalf("不存在的目标应为零计数: %v", dyn)
	}
}

func TestPreviewCommandGitDynamic(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
	run("init", "-q")
	writePreviewFile(t, dir, "tracked.txt", "base")
	run("add", ".")
	run("commit", "-q", "-m", "init")
	// tracked 改动 1 + untracked 2
	writePreviewFile(t, dir, "tracked.txt", "modified")
	writePreviewFile(t, dir, "new1.txt", "n")
	writePreviewFile(t, dir, "new2.txt", "n")

	// git clean -fd → untracked 2
	body, _ := json.Marshal(map[string]string{"command": "git clean -fd", "cwd": dir})
	d := previewData(t, string(body))
	if d["kind"] != "git" {
		t.Fatalf("期望 git kind: %v", d)
	}
	dyn := firstMatch(t, d)["dynamic"].(map[string]any)
	if dyn["untracked"].(float64) != 2 {
		t.Fatalf("期望 untracked=2, got %v", dyn)
	}

	// git reset --hard → tracked 脏 1（untracked 不在回滚面）
	body, _ = json.Marshal(map[string]string{"command": "git reset --hard", "cwd": dir})
	d = previewData(t, string(body))
	dyn = firstMatch(t, d)["dynamic"].(map[string]any)
	if dyn["dirty"].(float64) != 1 {
		t.Fatalf("期望 dirty=1, got %v", dyn)
	}
}

func TestPreviewCommandOverwriteRedirect(t *testing.T) {
	dir := t.TempDir()
	writePreviewFile(t, dir, "config.txt", "old-content")

	// 目标已存在：Exists + 现内容字节
	body, _ := json.Marshal(map[string]string{"command": "echo x > config.txt", "cwd": dir})
	d := previewData(t, string(body))
	if d["level"] != "warning" {
		t.Fatalf("覆盖重定向应为 warning: %v", d)
	}
	dyn := firstMatch(t, d)["dynamic"].(map[string]any)
	if dyn["exists"] != true || dyn["bytes"].(float64) != float64(len("old-content")) {
		t.Fatalf("覆盖目标计数不符: %v", dyn)
	}

	// 目标不存在：Exists=false（无害新建，前端降级面；bool 零值 omitempty
	// 缺席即 false）
	body, _ = json.Marshal(map[string]string{"command": "echo x > fresh.txt", "cwd": dir})
	d = previewData(t, string(body))
	dyn = firstMatch(t, d)["dynamic"].(map[string]any)
	if dyn["exists"] == true {
		t.Fatalf("新目标 exists 应为 false/缺席: %v", dyn)
	}
}

func TestPreviewCommandStaticFallback(t *testing.T) {
	// 无 cwd / cwd 不存在：命中保留、动态计数缺席（静态降级）
	for _, body := range []string{
		`{"command":"git clean -fd"}`,
		`{"command":"git clean -fd","cwd":"Z:/no/such/dir"}`,
	} {
		d := previewData(t, body)
		if d["level"] != "danger" {
			t.Fatalf("静态降级仍应有档位: %v", d)
		}
		m := firstMatch(t, d)
		if m["dynamic"] != nil {
			t.Fatalf("无 cwd 不应有动态计数: %v", m)
		}
		if m["segment"] != "git clean -fd" {
			t.Fatalf("segment 展示面缺失: %v", m)
		}
	}
}

func TestPreviewCommandLevelRanking(t *testing.T) {
	// 复合命中：danger 压过 warning，kind/detail 取最高档首见
	d := previewData(t, `{"command":"echo x > a.txt && rm -rf b"}`)
	if d["level"] != "danger" || d["kind"] != "rm" {
		t.Fatalf("最高档判定不符: %v", d)
	}
	if ms, _ := d["matches"].([]any); len(ms) != 2 {
		t.Fatalf("复合命令应 2 条命中: %v", d)
	}
}
