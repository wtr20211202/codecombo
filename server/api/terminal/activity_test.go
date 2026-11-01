package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupMetaTest 构造 store 装配 + gin 路由
func setupMetaTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.GET("/api/terminals/:id/activity", GetTerminalActivity)
	r.POST("/api/terminals/:id/review-mark", MarkReviewBaseline)
	return r
}

// initGitRepo 建一个带两次提交的最小仓库，返回目录与首次提交 hash
func initGitRepo(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(cmd.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run("init", "-b", "main")
	run("config", "user.email", "t@t")
	run("config", "user.name", "t")
	run("commit", "--allow-empty", "-m", "first")
	out := run("rev-parse", "HEAD")
	head := out[:len(out)-1]
	return dir, head
}

func TestAgentSessionMeta_Roundtrip(t *testing.T) {
	setupMetaTest(t)
	meta := store.AgentSessionMeta{ID: "agent-1", Dir: "/tmp/x", Runtime: "claude", StartHead: "abc123"}
	if err := store.Get().AgentSession.Save(meta); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get().AgentSession.Get("agent-1")
	if err != nil || got.StartHead != "abc123" || got.Runtime != "claude" {
		t.Fatalf("roundtrip failed: %v %+v", err, got)
	}
	// 删除
	if err := store.Get().AgentSession.Delete("agent-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get().AgentSession.Get("agent-1"); err == nil {
		t.Fatal("deleted meta should not be found")
	}
}

func TestGetTerminalActivity_NoMeta404(t *testing.T) {
	r := setupMetaTest(t)
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/agent-none/activity", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestGetTerminalActivity_EmptyStartHead(t *testing.T) {
	r := setupMetaTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-shell", Dir: "/tmp", Runtime: "shell"}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/agent-shell/activity", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Data struct {
			StartHead string `json:"startHead"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data.StartHead != "" {
		t.Fatalf("startHead should be empty, got %q", resp.Data.StartHead)
	}
}

// writeFile 写测试文件
func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}

// runGit 在仓库目录执行 git 命令
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func TestGetTerminalActivity_DiffSummary(t *testing.T) {
	dir, head := initGitRepo(t)
	// 会话创建后：修改 tracked 文件 + 新增文件
	if err := writeFile(filepath.Join(dir, "a.txt"), "line1\nline2\n"); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "-m", "agent commit")
	if err := writeFile(filepath.Join(dir, "b.txt"), "new\nfile\ncontent\n"); err != nil {
		t.Fatal(err)
	}

	r := setupMetaTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-git", Dir: dir, Runtime: "claude", StartHead: head}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/agent-git/activity", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data struct {
			StartHead string `json:"startHead"`
			Files     []struct {
				Status string `json:"status"`
				Path   string `json:"path"`
			} `json:"files"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data.StartHead != head {
		t.Fatalf("startHead = %q, want %q", resp.Data.StartHead, head)
	}
	// 产出应包含：a.txt（会话期间首次提交，状态 A）+ b.txt（未跟踪，状态 ?）
	paths := map[string]string{}
	for _, f := range resp.Data.Files {
		paths[f.Path] = f.Status
	}
	if paths["a.txt"] != "A" || paths["b.txt"] != "?" {
		t.Fatalf("files = %v, want a.txt A + b.txt ?", paths)
	}
}

// TestGetTerminalActivity_NoBaselineStatusFallback 无基线退化：StartHead 为空
// 时展示当前工作区改动（baseline=false），含未跟踪文件
func TestGetTerminalActivity_NoBaselineStatusFallback(t *testing.T) {
	dir, _ := initGitRepo(t)
	runGit(t, dir, "clean", "-fdx") // 确保干净起点
	if err := writeFile(filepath.Join(dir, "dirty.txt"), "agent was here\n"); err != nil {
		t.Fatal(err)
	}

	r := setupMetaTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-nb", Dir: dir, Runtime: "claude"}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/agent-nb/activity", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data struct {
			Baseline bool `json:"baseline"`
			Files    []struct {
				Status string `json:"status"`
				Path   string `json:"path"`
			} `json:"files"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data.Baseline {
		t.Fatal("baseline should be false for empty startHead")
	}
	found := false
	for _, f := range resp.Data.Files {
		if f.Path == "dirty.txt" && f.Status == "?" {
			found = true
		}
	}
	if !found {
		t.Fatalf("dirty.txt not in working-tree fallback: %+v", resp.Data.Files)
	}
}

// reviewMarkResp review-mark 响应 data 段（marks 数组，时间经 JSON RFC3339Nano 往返）
type reviewMarkResp struct {
	Data struct {
		Marks []struct {
			Ts   time.Time `json:"ts"`
			Head string    `json:"head"`
		} `json:"marks"`
	} `json:"data"`
}

// TestReviewMark_BaselineSwitch 审阅基线切换（P-20261003-217）核心语义：
// 标记基线后，activity?since=<标记> 的 diff 范围只含标记之后的产出；
// 不带 since 仍为整段 startHead..工作区。基点按时间戳 rev-list --before
// 解析（响应 base 字段可对账），标记的 Head 只作参考快照
func TestReviewMark_BaselineSwitch(t *testing.T) {
	dir, head := initGitRepo(t)

	r := setupMetaTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-rm", Dir: dir, Runtime: "shell", StartHead: head}); err != nil {
		t.Fatal(err)
	}

	// 第一轮产出：a.txt 提交入库（落在标记前）
	if err := writeFile(filepath.Join(dir, "a.txt"), "round one\n"); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "-m", "round one")
	// 标记前已存在的未跟踪文件（mtime 早于标记；全程保持 untracked——
	// round two 只 add b.txt，不收编它）
	if err := writeFile(filepath.Join(dir, "d-premark.txt"), "created before mark\n"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond) // 跨秒：git 提交时间戳秒精度，同秒内边界按秒归标记前

	// 标记审阅基线
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/terminals/agent-rm/review-mark", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("review-mark status = %d, body=%s", w.Code, w.Body.String())
	}
	var mk reviewMarkResp
	if err := json.Unmarshal(w.Body.Bytes(), &mk); err != nil {
		t.Fatal(err)
	}
	if len(mk.Data.Marks) != 1 {
		t.Fatalf("marks = %d, want 1", len(mk.Data.Marks))
	}
	if mk.Data.Marks[0].Head == "" {
		t.Fatal("mark head should record current HEAD")
	}

	// 第二轮产出：b.txt 提交 + c.txt 未跟踪（都落在标记后）。
	// 先跨秒再提交——与标记同秒的提交按秒粒度归入标记前（reviewMarkBase
	// 边界注记），测试产出必须落在标记后的完整秒
	time.Sleep(1200 * time.Millisecond)
	if err := writeFile(filepath.Join(dir, "b.txt"), "round two\n"); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "b.txt")
	runGit(t, dir, "commit", "-m", "round two")
	if err := writeFile(filepath.Join(dir, "c.txt"), "untracked after mark\n"); err != nil {
		t.Fatal(err)
	}

	getActivity := func(url string) map[string]string {
		t.Helper()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, url, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body=%s", url, w.Code, w.Body.String())
		}
		var resp struct {
			Data struct {
				Base      string `json:"base"`
				StartHead string `json:"startHead"`
				Files     []struct {
					Status string `json:"status"`
					Path   string `json:"path"`
				} `json:"files"`
				Marks []struct {
					Ts time.Time `json:"ts"`
				} `json:"marks"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		paths := map[string]string{}
		for _, f := range resp.Data.Files {
			paths[f.Path] = f.Status
		}
		t.Logf("url=%s base=%s marks=%d files=%v", url, resp.Data.Base, len(resp.Data.Marks), paths)
		return paths
	}

	// 无 since：整段产出（a 提交态 A + b 提交态 A + c/d 未跟踪 ?）
	all := getActivity("/api/terminals/agent-rm/activity")
	if all["a.txt"] != "A" || all["b.txt"] != "A" || all["c.txt"] != "?" || all["d-premark.txt"] != "?" {
		t.Fatalf("full view files = %v, want a=A b=A c=? d=?", all)
	}

	// since=标记：只含标记后的产出（b、c），a（标记前提交）与 d-premark
	//（标记前未跟踪，mtime 过滤）不在
	since := mk.Data.Marks[0].Ts.Format(time.RFC3339Nano)
	marked := getActivity("/api/terminals/agent-rm/activity?since=" + url.QueryEscape(since))
	if _, ok := marked["a.txt"]; ok {
		t.Fatalf("marked view should exclude pre-mark a.txt, got %v", marked)
	}
	if _, ok := marked["d-premark.txt"]; ok {
		t.Fatalf("marked view should exclude pre-mark untracked d-premark.txt, got %v", marked)
	}
	if marked["b.txt"] != "A" || marked["c.txt"] != "?" {
		t.Fatalf("marked view files = %v, want b=A c=?", marked)
	}

	// activity 响应带 marks 供前端切换器渲染
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/api/terminals/agent-rm/activity", nil))
	var act struct {
		Data struct {
			Marks []struct {
				Ts time.Time `json:"ts"`
			} `json:"marks"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &act); err != nil {
		t.Fatal(err)
	}
	if len(act.Data.Marks) != 1 {
		t.Fatalf("activity marks = %d, want 1", len(act.Data.Marks))
	}

	// 非法 since → 400（前端恒传 marks 原文 ts，此分支为 API 直调防线）
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, httptest.NewRequest(http.MethodGet, "/api/terminals/agent-rm/activity?since=not-a-time", nil))
	if w3.Code != http.StatusBadRequest {
		t.Fatalf("invalid since status = %d, want 400", w3.Code)
	}
}

// TestReviewMark_FifoBound 标记上限 FIFO：超 maxSessionReviewMarks 后逐旧裁剪
func TestReviewMark_FifoBound(t *testing.T) {
	r := setupMetaTest(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-fifo", Dir: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxSessionReviewMarks+3; i++ {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/terminals/agent-fifo/review-mark", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("review-mark #%d status = %d", i, w.Code)
		}
	}
	meta, err := store.Get().AgentSession.Get("agent-fifo")
	if err != nil || meta == nil {
		t.Fatal(err)
	}
	if len(meta.Marks) != maxSessionReviewMarks {
		t.Fatalf("marks = %d, want capped at %d", len(meta.Marks), maxSessionReviewMarks)
	}
}

// TestReviewMark_NoMeta404 元数据缺失（会话不存在/已关闭）→ 404
func TestReviewMark_NoMeta404(t *testing.T) {
	r := setupMetaTest(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/terminals/agent-none/review-mark", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}
