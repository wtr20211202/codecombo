package compareexp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/opschannel"
	terminalapi "codecombo/server/api/terminal"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

func setupExpTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/compare-experiments", CreateExperiment)
	r.GET("/api/compare-experiments", ListExperiments)
	r.GET("/api/compare-experiments/:id", GetExperiment)
	r.POST("/api/compare-experiments/:id/adopt", AdoptExperiment)
	r.DELETE("/api/compare-experiments/:id", DeleteExperiment)
	r.GET("/api/compare-experiments/:id/filediff", GetExperimentFileDiff)
	r.GET("/api/compare-experiments/:id/applies", ListExpApplies)
	r.GET("/api/compare-experiments/:id/applies/:aid/patch", GetExpApplyPatch)
	return r
}

// seedSideSession 落一条会话元数据（startHead/Dir 驱动对比归属），返回会话 ID
func seedSideSession(t *testing.T, id, dir, startHead string) {
	t.Helper()
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: id, Dir: dir, Runtime: "claude", StartHead: startHead,
	}); err != nil {
		t.Fatal(err)
	}
}

func af(status, path string) terminalapi.ActivityFile {
	return terminalapi.ActivityFile{Status: status, Path: path}
}

// ─────────────── 归属三分类（纯函数，任务书要求的归属分类单测） ───────────────

func TestClassifyCompareFiles_ThreeStates(t *testing.T) {
	rows := ClassifyCompareFiles(
		[]terminalapi.ActivityFile{af("M", "a-only.ts"), af("M", "both.ts"), af("?", "new-a.ts")},
		[]terminalapi.ActivityFile{af("M", "b-only.ts"), af("A", "both.ts")},
	)
	if len(rows) != 4 {
		t.Fatalf("rows = %d, want 4: %+v", len(rows), rows)
	}
	byPath := map[string]CompareFileRow{}
	for _, r := range rows {
		byPath[r.Path] = r
	}
	aOnly := byPath["a-only.ts"]
	if !aOnly.InA || aOnly.InB || aOnly.StatusA != "M" || aOnly.StatusB != "" {
		t.Fatalf("a-only misclassified: %+v", aOnly)
	}
	bOnly := byPath["b-only.ts"]
	if bOnly.InA || !bOnly.InB || bOnly.StatusB != "M" {
		t.Fatalf("b-only misclassified: %+v", bOnly)
	}
	both := byPath["both.ts"]
	if !both.InA || !both.InB || both.StatusA != "M" || both.StatusB != "A" {
		t.Fatalf("both misclassified (per-side status preserved): %+v", both)
	}
	newA := byPath["new-a.ts"]
	if !newA.InA || newA.InB || newA.StatusA != "?" {
		t.Fatalf("untracked-only misclassified: %+v", newA)
	}
	// 字典序稳定输出
	for i := 1; i < len(rows); i++ {
		if rows[i-1].Path >= rows[i].Path {
			t.Fatalf("rows not sorted: %v", rows)
		}
	}
}

func TestClassifyCompareFiles_EmptySides(t *testing.T) {
	// 双侧空 = 零行（无产出不渲染空行）
	if rows := ClassifyCompareFiles(nil, nil); len(rows) != 0 {
		t.Fatalf("nil sides should be empty, got %v", rows)
	}
	// 单侧空：另一侧全落「仅」（无基线/非 git 目录的退化参与语义）
	rows := ClassifyCompareFiles(nil, []terminalapi.ActivityFile{af("M", "x.go")})
	if len(rows) != 1 || rows[0].InA || !rows[0].InB {
		t.Fatalf("empty A should put everything on B only: %+v", rows)
	}
}

// ─────────────── 创建校验（纯函数） ───────────────

func TestValidateLaunchInput(t *testing.T) {
	cases := []struct {
		name                        string
		prompt, dir, rtA, rtB, want string
	}{
		{"ok", "写个快排", "", "claude", "codex", ""},
		{"empty prompt", "", "", "claude", "codex", "prompt is required"},
		{"prompt too long", strings.Repeat("x", 501), "", "claude", "codex", "prompt too long (max 500 bytes)"},
		{"same runtime allowed (两版挑好)", "p", "", "claude", "claude", ""},
		{"both auto allowed", "p", "", "auto", "auto", ""},
		{"unknown runtime", "p", "", "claude", "mystery-rt", "unknown runtime"},
		{"shell ok", "p", "", "shell", "claude", ""},
		{"dir missing", "p", filepath.Join(t.TempDir(), "nope"), "claude", "codex", "dir does not exist"},
	}
	for _, tc := range cases {
		if got := validateLaunchInput(tc.prompt, tc.dir, tc.rtA, tc.rtB); got != tc.want {
			t.Fatalf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
	if got := validateLaunchInput("p", t.TempDir(), "claude", "codex"); got != "" {
		t.Fatalf("existing dir should pass, got %q", got)
	}
}

// ─────────────── 完成监听（观察者 → 状态迁移，任务书要求的状态迁移单测） ───────────────

func TestTaskEventObserver_TransitionsExperiment(t *testing.T) {
	setupExpTest(t)
	exp, err := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "竞写",
		A:      store.CompareSide{SessionID: "agent-1", Runtime: "claude", Launched: true},
		B:      store.CompareSide{SessionID: "agent-2", Runtime: "codex", Launched: true},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 非终结事件：忽略
	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"terminalId": "agent-1", "status": "running",
	}})
	got, _ := store.Get().CompareExp.Get(exp.ID)
	if got.Status != store.CompareExpRunning || got.A.Result != "" {
		t.Fatalf("running report must be ignored: %+v", got.A)
	}

	// A 完成（携带底层智能体会话 id）：仍 running
	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"terminalId": "agent-1", "status": "done", "sessionId": "claude-abc",
	}})
	got, _ = store.Get().CompareExp.Get(exp.ID)
	if got.Status != store.CompareExpRunning || got.A.Result != "done" || got.A.AgentSessionID != "claude-abc" {
		t.Fatalf("after A done: status=%q A=%+v", got.Status, got.A)
	}

	// 无 terminalId 的终结上报：无从归属，静默
	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"status": "failed",
	}})

	// B 完成：翻 ready
	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"terminalId": "agent-2", "status": "failed",
	}})
	got, _ = store.Get().CompareExp.Get(exp.ID)
	if got.Status != store.CompareExpReady || got.B.Result != "failed" {
		t.Fatalf("after B failed: status=%q B=%+v", got.Status, got.B)
	}

	// 非 task.progress 事件与本实验无关的会话：零影响
	taskEventObserver(opschannel.Event{Type: "notify", Payload: map[string]any{"terminalId": "agent-1", "status": "done"}})
	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"terminalId": "agent-1", "status": "failed",
	}})
	got, _ = store.Get().CompareExp.Get(exp.ID)
	if got.A.Result != "done" {
		t.Fatalf("late report must not overwrite finalized A: %+v", got.A)
	}
}

// 状态迁移广播（P-20261004-33）：回执真实落位即广播 experiment.changed，
// 载荷 {id,status,resultA,resultB}（单侧落位 running 也发——前端「A 已完成
// 等 B」即时可见）；重复回执/迟到 no-op 不广播
func TestTaskEventObserver_BroadcastsExperimentChanged(t *testing.T) {
	setupExpTest(t)
	exp, err := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "竞写",
		A:      store.CompareSide{SessionID: "agent-1"},
		B:      store.CompareSide{SessionID: "agent-2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type != opschannel.EventExperimentChanged {
			return
		}
		b, _ := json.Marshal(ev.Payload)
		p := map[string]any{}
		_ = json.Unmarshal(b, &p)
		got = append(got, p)
	})
	defer unsub()

	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"terminalId": "agent-1", "status": "done",
	}})
	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"terminalId": "agent-2", "status": "failed",
	}})
	// 重复回执（已终结结果不覆写）：零广播
	taskEventObserver(opschannel.Event{Type: "task.progress", Payload: map[string]any{
		"terminalId": "agent-1", "status": "failed",
	}})
	if len(got) != 2 {
		t.Fatalf("broadcast count = %d, want 2: %+v", len(got), got)
	}
	first, second := got[0], got[1]
	if first["id"] != exp.ID || first["status"] != store.CompareExpRunning || first["resultA"] != "done" || first["resultB"] != "" {
		t.Fatalf("first broadcast mismatch: %+v", first)
	}
	if second["id"] != exp.ID || second["status"] != store.CompareExpReady || second["resultA"] != "done" || second["resultB"] != "failed" {
		t.Fatalf("second broadcast mismatch: %+v", second)
	}
}

// ─────────────── 详情/采用/diff 的 HTTP 面 ───────────────

func TestGetExperimentDetail_Classification(t *testing.T) {
	r := setupExpTest(t)
	dir := newGitRepo(t)
	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "竞写",
		A:      store.CompareSide{SessionID: "agent-1"},
		B:      store.CompareSide{SessionID: "agent-2"},
	})
	seedSideSession(t, "agent-1", dir, gitHead(t, dir))
	seedSideSession(t, "agent-2", dir, gitHead(t, dir))

	req := httptest.NewRequest(http.MethodGet, "/api/compare-experiments/"+exp.ID, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			Experiment map[string]any   `json:"experiment"`
			Alive      map[string]bool  `json:"alive"`
			Files      []CompareFileRow `json:"files"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	// 同目录双侧基线一致：全部行落「双方」（tracked 修改 + untracked 新增各一行）
	if len(body.Data.Files) != 2 {
		t.Fatalf("expected 2 both-classified rows, got %+v", body.Data.Files)
	}
	for _, row := range body.Data.Files {
		if !row.InA || !row.InB {
			t.Fatalf("shared-dir rows must be both-classified: %+v", row)
		}
	}
}

func TestAdoptAndDelete(t *testing.T) {
	r := setupExpTest(t)
	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "竞写",
		A:      store.CompareSide{SessionID: "agent-1"},
		B:      store.CompareSide{SessionID: "agent-2"},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/compare-experiments/"+exp.ID+"/adopt", strings.NewReader(`{"side":"b"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("adopt status = %d: %s", w.Code, w.Body.String())
	}
	got, _ := store.Get().CompareExp.Get(exp.ID)
	if got.Adopted != store.CompareAdoptB {
		t.Fatalf("adopted = %q, want b", got.Adopted)
	}

	// 非法侧别 400
	req = httptest.NewRequest(http.MethodPost, "/api/compare-experiments/"+exp.ID+"/adopt", strings.NewReader(`{"side":"z"}`))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid adopt should 400, got %d", w.Code)
	}

	// 坏 ID 400、未知 ID 404、删除后 404
	for _, c := range []struct {
		path, method string
		code         int
	}{
		{"/api/compare-experiments/cmp-bad", http.MethodGet, http.StatusBadRequest},
		{"/api/compare-experiments/cmp-404", http.MethodGet, http.StatusNotFound},
	} {
		req := httptest.NewRequest(c.method, c.path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != c.code {
			t.Fatalf("%s %s: status = %d, want %d", c.method, c.path, w.Code, c.code)
		}
	}
	req = httptest.NewRequest(http.MethodDelete, "/api/compare-experiments/"+exp.ID, nil)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w.Code)
	}
	if _, err := store.Get().CompareExp.Get(exp.ID); err == nil {
		t.Fatal("deleted experiment should be gone")
	}
}

func TestGetExperimentFileDiff_BaselineVsSide(t *testing.T) {
	r := setupExpTest(t)
	dir := newGitRepo(t)
	head := gitHead(t, dir)
	exp, _ := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: "竞写",
		A:      store.CompareSide{SessionID: "agent-1"},
		B:      store.CompareSide{SessionID: "agent-2"},
	})
	seedSideSession(t, "agent-1", dir, head)
	seedSideSession(t, "agent-2", dir, head)

	// 已跟踪文件：基线 vs 工作区 unified diff
	w := doGet(r, "/api/compare-experiments/"+exp.ID+"/filediff?side=a&file=tracked.ts")
	if w.Code != http.StatusOK {
		t.Fatalf("tracked diff status = %d: %s", w.Code, w.Body.String())
	}
	if body := w.Body.String(); !strings.Contains(body, "-old line") || !strings.Contains(body, "+new line") {
		t.Fatalf("tracked diff missing hunks: %s", body)
	}

	// 未跟踪新文件：合成 new-file diff
	w = doGet(r, "/api/compare-experiments/"+exp.ID+"/filediff?side=b&status=%3F&file=created-b.txt")
	if w.Code != http.StatusOK {
		t.Fatalf("untracked diff status = %d: %s", w.Code, w.Body.String())
	}
	if body := w.Body.String(); !strings.Contains(body, "+++ b/created-b.txt") || !strings.Contains(body, "+hello from b") {
		t.Fatalf("untracked diff malformed: %s", body)
	}

	// 路径穿越拒绝 / 未知侧拒绝 / 无 baseline 冲突
	if w = doGet(r, "/api/compare-experiments/"+exp.ID+"/filediff?side=a&file=../secret"); w.Code != http.StatusBadRequest {
		t.Fatalf("traversal should 400, got %d", w.Code)
	}
	if w = doGet(r, "/api/compare-experiments/"+exp.ID+"/filediff?side=z&file=tracked.ts"); w.Code != http.StatusBadRequest {
		t.Fatalf("bad side should 400, got %d", w.Code)
	}
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-2", Dir: dir, StartHead: ""}); err != nil {
		t.Fatal(err)
	}
	if w = doGet(r, "/api/compare-experiments/"+exp.ID+"/filediff?side=b&file=tracked.ts"); w.Code != http.StatusConflict {
		t.Fatalf("no baseline should 409, got %d", w.Code)
	}
}

// ─────────────── 夹具 ───────────────

func doGet(r *gin.Engine, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func gitCmd(dir string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	return cmd
}

func gitHead(t *testing.T, dir string) string {
	t.Helper()
	cmd := gitCmd(dir, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// newGitRepo 最小 git 仓库：一次基线提交 + 工作区一改一增（对比面夹具）
func newGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := gitCmd(dir, args...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "t@t")
	run("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "tracked.ts"), []byte("old line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "base", "--no-gpg-sign")
	// 工作区改动：tracked.ts 修改（diff 命中）+ created-b.txt 未跟踪（合成命中）
	if err := os.WriteFile(filepath.Join(dir, "tracked.ts"), []byte("new line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "created-b.txt"), []byte("hello from b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}
