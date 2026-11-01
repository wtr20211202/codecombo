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

// 在系统资源管理器中显示（P-20261003-323）单元测试：
//  1. revealCmd 三平台命令拼装（纯函数，goos 注入——同一测试进程全量断言，
//     不真执行；提案「三平台命令分支单测」指定项）
//  2. revealRun SC_REVEAL_STUB_DIR 桩：argv 原样落桩文件、零真实 exec
//  3. handler 语义：200（ok+opener）/ 400 越界 / 404 不存在 / 501 headless
//     （revealExec 测试缝注入 errRevealNoDisplay，平台无关地验证映射）

// setupRevealTest 文件组测试环境 + reveal 路由（形态同 router.go）+ exec 桩
func setupRevealTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r, projPath := setupFileOpsTest(t)
	t.Setenv("CC_REVEAL_STUB_DIR", t.TempDir())
	g := r.Group("/api/projects/:id")
	g.POST("/reveal", RevealFile)
	return r, projPath
}

func TestRevealCmd_ThreePlatforms(t *testing.T) {
	// 目标路径用平台原生分隔符（SafeJoinProject 产出形态）：断言拼装原样透传
	target := filepath.Join("root", "sub", "a.txt")

	name, args, err := revealCmd("windows", target, false)
	if err != nil || name != "explorer" || len(args) != 1 || args[0] != "/select,"+target {
		t.Fatalf("windows: name=%q args=%v err=%v", name, args, err)
	}

	name, args, err = revealCmd("darwin", target, false)
	if err != nil || name != "open" || len(args) != 2 || args[0] != "-R" || args[1] != target {
		t.Fatalf("darwin: name=%q args=%v err=%v", name, args, err)
	}

	// Linux 无选中支持：文件退化打开所在目录，目录取自身
	name, args, err = revealCmd("linux", target, false)
	if err != nil || name != "xdg-open" || len(args) != 1 || args[0] != filepath.Dir(target) {
		t.Fatalf("linux file: name=%q args=%v err=%v", name, args, err)
	}
	name, args, err = revealCmd("linux", target, true)
	if err != nil || name != "xdg-open" || len(args) != 1 || args[0] != target {
		t.Fatalf("linux dir: name=%q args=%v err=%v", name, args, err)
	}

	if _, _, err := revealCmd("plan9", target, false); err == nil {
		t.Fatal("unsupported platform should error")
	}
}

// TestRevealRun_StubWritesArgv 桩模式：不真执行，拼装结果 argv 原样落 JSON
func TestRevealRun_StubWritesArgv(t *testing.T) {
	stubDir := t.TempDir()
	t.Setenv("CC_REVEAL_STUB_DIR", stubDir)

	target := filepath.Join("root", "doc.txt")
	opener, err := revealRun("windows", target, false)
	if err != nil || opener != "explorer" {
		t.Fatalf("revealRun: opener=%q err=%v", opener, err)
	}

	entries, err := os.ReadDir(stubDir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("stub dir entries=%d err=%v, want exactly 1", len(entries), err)
	}
	raw, err := os.ReadFile(filepath.Join(stubDir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var stub struct {
		Goos string   `json:"goos"`
		Name string   `json:"name"`
		Args []string `json:"args"`
	}
	if err := json.Unmarshal(raw, &stub); err != nil {
		t.Fatalf("stub unmarshal: %v (%s)", err, raw)
	}
	if stub.Goos != "windows" || stub.Name != "explorer" || len(stub.Args) != 1 || stub.Args[0] != "/select,"+target {
		t.Fatalf("stub payload = %+v", stub)
	}
}

func TestRevealHandler(t *testing.T) {
	r, projPath := setupRevealTest(t)
	if err := os.MkdirAll(filepath.Join(projPath, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "docs", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Run("文件 200 ok+opener", func(t *testing.T) {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/reveal", `{"path":"docs/a.txt"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
		}
		var resp struct {
			OK     bool   `json:"ok"`
			Opener string `json:"opener"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if !resp.OK || resp.Opener == "" {
			t.Fatalf("resp = %+v, want ok=true with opener", resp)
		}
	})

	t.Run("目录 200", func(t *testing.T) {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/reveal", `{"path":"docs"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("空 path = 项目根 200", func(t *testing.T) {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/reveal", `{}`)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("反斜杠路径归一后 200", func(t *testing.T) {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/reveal", `{"path":"docs\\a.txt"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("越界路径 400", func(t *testing.T) {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/reveal", `{"path":"../../escape.txt"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400, body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("不存在 404", func(t *testing.T) {
		w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/reveal", `{"path":"docs/ghost.txt"}`)
		if w.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404, body=%s", w.Code, w.Body.String())
		}
	})
}

// TestRevealHandler_Headless501 headless（无显示环境）→ 501 明确语义：
// revealExec 测试缝注入 errRevealNoDisplay（平台无关地验证 handler 映射；
// 真探测逻辑在 reveal_unix.go，wsl 门禁的 Linux 运行时覆盖）
func TestRevealHandler_Headless501(t *testing.T) {
	r, projPath := setupRevealTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	orig := revealExec
	revealExec = func(string, []string) error { return errRevealNoDisplay }
	t.Cleanup(func() { revealExec = orig })
	// 清桩：stub 直通分支会短路 revealExec，注入缝必须走真实 exec 路径
	t.Setenv("CC_REVEAL_STUB_DIR", "")

	w := doFileJSON(t, r, http.MethodPost, "/api/projects/proj-test/reveal", `{"path":"a.txt"}`)
	if w.Code != 501 {
		t.Fatalf("status = %d, want 501, body=%s", w.Code, w.Body.String())
	}
	if want := "no display environment"; !strings.Contains(w.Body.String(), want) {
		t.Fatalf("body = %s, want stable marker %q", w.Body.String(), want)
	}
}
