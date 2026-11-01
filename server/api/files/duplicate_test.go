package files

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 创建副本端点（P-20261004-135）行为锚定：命名自增（-copyN 首个不冲突）、文件
// 字节级复制、目录递归整树、越界/不存在走既有拒绝口径、护栏（条目上限）。
// 路由形态同生产注册（router.go 的 /files/duplicate）。

func setupDuplicateTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupFileOpsTest(t)
	g := r.Group("/api/projects/:id")
	g.POST("/files/duplicate", DuplicateFile)
	return r, projPath
}

type dupResponse struct {
	Message string `json:"message"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
}

func doDuplicate(t *testing.T, r *gin.Engine, body string) (*dupResponse, int) {
	t.Helper()
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/files/duplicate", body)
	if w.Code != http.StatusCreated {
		return nil, w.Code
	}
	var resp dupResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response unmarshal: %v (body=%s)", err, w.Body.String())
	}
	return &resp, w.Code
}

// TestDuplicate_File_OK 单文件副本：内容/权限随源、响应 path 指向新文件、源原位保留
func TestDuplicate_File_OK(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	if err := os.MkdirAll(filepath.Join(projPath, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "src", "config.ts"), []byte("export const a = 1"), 0644); err != nil {
		t.Fatal(err)
	}

	resp, code := doDuplicate(t, r, `{"path":"src/config.ts"}`)
	if code != http.StatusCreated || resp == nil {
		t.Fatalf("status = %d, want 201", code)
	}
	if resp.Path != "src/config-copy1.ts" || resp.IsDir {
		t.Fatalf("resp = %+v, want path src/config-copy1.ts isDir=false", resp)
	}
	got, err := os.ReadFile(filepath.Join(projPath, "src", "config-copy1.ts"))
	if err != nil || string(got) != "export const a = 1" {
		t.Fatalf("copy content = %q (err=%v)", got, err)
	}
	if _, err := os.Stat(filepath.Join(projPath, "src", "config.ts")); err != nil {
		t.Fatalf("源文件未保留: %v", err)
	}
}

// TestDuplicate_NameAutoIncrement 命名自增：-copy1 被占取 -copy2，以此类推
//（首个不冲突语义，任务书「会话副本命名同义」的文件系统形态）
func TestDuplicate_NameAutoIncrement(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "a-copy1.txt"), []byte("c1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "a-copy2.txt"), []byte("c2"), 0644); err != nil {
		t.Fatal(err)
	}

	for i, want := range []string{"a-copy3.txt", "a-copy4.txt"} {
		resp, code := doDuplicate(t, r, `{"path":"a.txt"}`)
		if code != http.StatusCreated || resp == nil {
			t.Fatalf("dup#%d status = %d, want 201", i, code)
		}
		if resp.Path != want {
			t.Fatalf("dup#%d path = %q, want %q", i, resp.Path, want)
		}
	}
	// 既有副本内容未被静默覆盖
	if got, _ := os.ReadFile(filepath.Join(projPath, "a-copy1.txt")); string(got) != "c1" {
		t.Fatalf("a-copy1.txt 被覆盖: %q", got)
	}
}

// TestDuplicate_HiddenFileNoExt 点开头隐藏文件整体作主干：.env → .env-copy1
//（而非「-copy1.env」——Ext 与名字全等时主干不拆）
func TestDuplicate_HiddenFileNoExt(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	if err := os.WriteFile(filepath.Join(projPath, ".env"), []byte("K=V"), 0644); err != nil {
		t.Fatal(err)
	}
	resp, code := doDuplicate(t, r, `{"path":".env"}`)
	if code != http.StatusCreated || resp == nil {
		t.Fatalf("status = %d, want 201", code)
	}
	if resp.Path != ".env-copy1" {
		t.Fatalf("path = %q, want .env-copy1", resp.Path)
	}
	if got, err := os.ReadFile(filepath.Join(projPath, ".env-copy1")); err != nil || string(got) != "K=V" {
		t.Fatalf(".env-copy1 = %q (err=%v)", got, err)
	}
}

// TestDuplicate_Dir_Recursive 目录副本：整树递归（含子目录/多字节内容），
// 源树原位保留、新树独立（改副本不动源）
func TestDuplicate_Dir_Recursive(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	src := filepath.Join(projPath, "pkg")
	for _, d := range []string{"pkg", "pkg/inner"} {
		if err := os.MkdirAll(filepath.Join(projPath, d), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(src, "main.go"), []byte("package pkg"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "inner", "util.go"), []byte("package inner"), 0644); err != nil {
		t.Fatal(err)
	}

	resp, code := doDuplicate(t, r, `{"path":"pkg"}`)
	if code != http.StatusCreated || resp == nil {
		t.Fatalf("status = %d, want 201", code)
	}
	if !resp.IsDir || resp.Path != "pkg-copy1" {
		t.Fatalf("resp = %+v, want isDir=true path pkg-copy1", resp)
	}
	for _, p := range []string{"pkg-copy1/main.go", "pkg-copy1/inner/util.go"} {
		if _, err := os.Stat(filepath.Join(projPath, filepath.FromSlash(p))); err != nil {
			t.Fatalf("%s 缺失: %v", p, err)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(projPath, "pkg-copy1", "inner", "util.go")); string(got) != "package inner" {
		t.Fatalf("深层文件内容 = %q", got)
	}
	// 新树独立：改副本不动源
	if err := os.WriteFile(filepath.Join(projPath, "pkg-copy1", "main.go"), []byte("changed"), 0644); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(src, "main.go")); string(got) != "package pkg" {
		t.Fatalf("副本写入波及源树: %q", got)
	}
}

// TestDuplicate_BinaryContent 二进制内容字节级复制：不走预览策略（ReadFile 的
// binary 415 不适用于复制——副本与源逐字节一致）
func TestDuplicate_BinaryContent(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	blob := []byte{0x00, 0x01, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47}
	if err := os.WriteFile(filepath.Join(projPath, "logo.png"), blob, 0644); err != nil {
		t.Fatal(err)
	}
	resp, code := doDuplicate(t, r, `{"path":"logo.png"}`)
	if code != http.StatusCreated || resp == nil {
		t.Fatalf("status = %d, want 201", code)
	}
	got, err := os.ReadFile(filepath.Join(projPath, "logo-copy1.png"))
	if err != nil || string(got) != string(blob) {
		t.Fatalf("binary copy mismatch (err=%v)", err)
	}
}

// TestDuplicate_Rejections 越界/不存在/项目根/缺 path 走既有拒绝口径：
// 403 越界（SafeJoinProject）、404 不存在、403 根、400 缺 path——零落盘
func TestDuplicate_Rejections(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "ok.txt"), []byte("ok"), 0644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		body   string
		status int
		needle string
	}{
		{`{"path":"../escape.txt"}`, http.StatusForbidden, "path traversal"},
		{`{"path":"ghost.txt"}`, http.StatusNotFound, "not found"},
		{`{"path":"."}`, http.StatusForbidden, "cannot duplicate project root"},
		{`{"path":""}`, http.StatusBadRequest, "path is required"},
	}
	for _, tc := range cases {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/files/duplicate", tc.body)
		if w.Code != tc.status {
			t.Fatalf("body=%s status = %d, want %d (resp=%s)", tc.body, w.Code, tc.status, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), tc.needle) {
			t.Fatalf("body=%s resp = %s, want contains %q", tc.body, w.Body.String(), tc.needle)
		}
	}
	// 零落盘：源目录只有最初的 ok.txt
	entries, err := os.ReadDir(projPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "ok.txt" {
		t.Fatalf("拒绝分支留下落盘物: %v", entries)
	}
}

// TestDuplicate_DirTooLarge 目录条目超护栏（dupMaxEntries）→ 400 且零落盘。
// 护栏运行时值注入小档位（trashMaxTotalBytes 同款测试缝），免造 2 万文件
func TestDuplicate_DirTooLarge(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	oldCap := dupMaxEntries
	dupMaxEntries = 3
	t.Cleanup(func() { dupMaxEntries = oldCap })

	src := filepath.Join(projPath, "big")
	if err := os.MkdirAll(src, 0755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i <= 3; i++ {
		if err := os.WriteFile(filepath.Join(src, "f"+string(rune('a'+i))+".txt"), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/files/duplicate", `{"path":"big"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (resp=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "directory too large") {
		t.Fatalf("resp = %s, want directory too large", w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(projPath, "big-copy1")); !os.IsNotExist(err) {
		t.Fatalf("超限分支留下副本: %v", err)
	}
}

// TestDuplicate_SensitiveTargetGate 副本目标命中敏感写入窄表（.git/hooks 内文件
// 的副本落同目录）→ 428 审批（agent 语义；handler 层零副作用——本测试环境无
// agent 令牌上下文，闸放行 UI 形态，仅锚定「目标预检在先、正常路径不误伤」）。
// 完整 428 链路归 agentguard 域测试，此处锚定敏感目录内副本名派生不越闸
func TestDuplicate_SensitiveTargetGate(t *testing.T) {
	r, projPath := setupDuplicateTest(t)
	hooks := filepath.Join(projPath, ".git", "hooks")
	if err := os.MkdirAll(hooks, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hooks, "pre-commit"), []byte("#!/bin/sh"), 0755); err != nil {
		t.Fatal(err)
	}
	// UI/解锁令牌形态（无 agent 上下文）：闸放行，副本按同目录命名落地
	resp, code := doDuplicate(t, r, `{"path":".git/hooks/pre-commit"}`)
	if code != http.StatusCreated || resp == nil {
		t.Fatalf("status = %d, want 201 (resp=%v)", code, resp)
	}
	if resp.Path != ".git/hooks/pre-commit-copy1" {
		t.Fatalf("path = %q, want .git/hooks/pre-commit-copy1", resp.Path)
	}
}
