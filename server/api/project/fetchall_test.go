package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 一键全部拉取（P-20261002-41）测试：核心池注入假 itemFn 验证并发上限与
// 失败隔离；默认动作单测降级标记；真实 fixture 仓库走完整请求链验证 fetch
// 确实更新 tracking ref（非纸面成功）──

// makeBareWithRemote 建一个以 bare 为 origin 的最小仓库（clone 而来，已设 upstream）。
// 返回工作区路径与 bare 路径；向 bare 追加提交即可模拟「队友推了新代码」
func makeBareWithRemote(t *testing.T) (work, bare string) {
	t.Helper()
	bare = filepath.Join(t.TempDir(), "origin.git")
	runGitAll(t, "--bare", "init", "-b", "main", bare)
	work = t.TempDir()
	runGitAll(t, "clone", bare, work)
	runGitAll(t, "-C", work, "config", "user.email", "t@t")
	runGitAll(t, "-C", work, "config", "user.name", "t")
	writeFileT(t, filepath.Join(work, "a.txt"), "one\n")
	runGitAll(t, "-C", work, "add", "-A")
	runGitAll(t, "-C", work, "commit", "-m", "c1")
	runGitAll(t, "-C", work, "push", "-u", "origin", "main")
	return work, bare
}

func runGitAll(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func writeFileT(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestFetchAllProjects_ConcurrencyPool 真并发验证：8 个项目、池上限 4——
// 前 4 个 itemFn 同时在途（第 4 个到齐后放行闸门），峰值并发必须等于 4；
// 若实现退化为串行，首个 itemFn 等闸门超时后峰值停在 1，断言失败
func TestFetchAllProjects_ConcurrencyPool(t *testing.T) {
	const total, limit = 8, 4
	projects := make([]config.ProjectConfig, total)
	for i := range projects {
		projects[i] = config.ProjectConfig{ID: string(rune('a' + i)), Name: "p", Path: t.TempDir()}
	}

	var live, peak int32
	gate := make(chan struct{})
	var gateOnce sync.Once
	itemFn := func(p config.ProjectConfig) FetchAllItem {
		cur := atomic.AddInt32(&live, 1)
		for {
			old := atomic.LoadInt32(&peak)
			if cur <= old || atomic.CompareAndSwapInt32(&peak, old, cur) {
				break
			}
		}
		if cur >= limit {
			gateOnce.Do(func() { close(gate) }) // 第 4 个在途到齐 → 放行
		}
		select {
		case <-gate:
		case <-time.After(3 * time.Second): // 串行退化时的兜底，不挂死测试
		}
		atomic.AddInt32(&live, -1)
		return FetchAllItem{ProjectID: p.ID, Name: p.Name, OK: true}
	}

	results := fetchAllProjects(projects, limit, itemFn)
	if got := atomic.LoadInt32(&peak); got != limit {
		t.Fatalf("peak concurrency = %d, want %d（池未真正并发到上限）", got, limit)
	}
	for i, r := range results {
		if !r.OK || r.Error != "" {
			t.Fatalf("results[%d] = %+v, want ok", i, r)
		}
	}
}

// TestFetchAllProjects_FailureIsolation 中间项目拉取失败：只标记该项，
// 前后项目照常成功；结果顺序与输入一致
func TestFetchAllProjects_FailureIsolation(t *testing.T) {
	projects := []config.ProjectConfig{
		{ID: "a", Name: "alpha", Path: t.TempDir()},
		{ID: "b", Name: "beta", Path: t.TempDir()},
		{ID: "c", Name: "gamma", Path: t.TempDir()},
	}
	itemFn := func(p config.ProjectConfig) FetchAllItem {
		it := FetchAllItem{ProjectID: p.ID, Name: p.Name}
		if p.ID == "b" {
			it.Error = "could not read from remote repository"
		} else {
			it.OK = true
		}
		return it
	}

	results := fetchAllProjects(projects, 4, itemFn)
	if len(results) != 3 {
		t.Fatalf("results = %d, want 3", len(results))
	}
	if results[0].ProjectID != "a" || !results[0].OK || results[0].Error != "" {
		t.Fatalf("results[0] = %+v, want ok", results[0])
	}
	if results[1].ProjectID != "b" || results[1].OK || results[1].Error == "" {
		t.Fatalf("results[1] = %+v, want failed with error marker", results[1])
	}
	if results[2].ProjectID != "c" || !results[2].OK || results[2].Error != "" {
		t.Fatalf("results[2] = %+v, want ok (degraded by b's failure?)", results[2])
	}
}

// TestFetchAllItem_DegradedMarkers 默认动作的降级标记：路径失效（已删/不存在）
// 与非 git 纯目录均为逐项 error 标记、OK=false，且不 panic
func TestFetchAllItem_DegradedMarkers(t *testing.T) {
	gone := t.TempDir()
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}

	if it := fetchAllItem(config.ProjectConfig{ID: "g", Name: "gone", Path: gone}); it.OK || it.Error != "path missing" {
		t.Fatalf("gone = %+v, want path missing", it)
	}
	if it := fetchAllItem(config.ProjectConfig{ID: "p", Name: "plain", Path: t.TempDir()}); it.OK || it.Error != "not a git repo" {
		t.Fatalf("plain = %+v, want not a git repo", it)
	}
	if it := fetchAllItem(config.ProjectConfig{ID: "x", Name: "x", Path: filepath.Join(t.TempDir(), "no-such-dir")}); it.Error != "path missing" {
		t.Fatalf("missing dir = %+v, want path missing", it)
	}
}

// TestFetchAllItem_FetchError 真仓库 fetch 报错路径：origin 指向被删的 bare，
// 错误串逐项返回（OK=false + 已脱敏错误）
func TestFetchAllItem_FetchError(t *testing.T) {
	work, bare := makeBareWithRemote(t)
	if err := os.RemoveAll(bare); err != nil {
		t.Fatal(err)
	}
	it := fetchAllItem(config.ProjectConfig{ID: "dead", Name: "dead-remote", Path: work})
	if it.OK || it.Error == "" {
		t.Fatalf("dead remote = %+v, want failed with error", it)
	}
}

// TestFetchAllProjects_Handler 真实 fixture 仓库走完整请求链：
// 两 git 仓库（bare origin 已有新提交）+ 路径失效 + 非 git 目录，一次批量后
// 全部逐项返回且 tracking ref 确实前进（fetch 真实发生，非纸面成功）
func TestFetchAllProjects_Handler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	workA, bareA := makeBareWithRemote(t)
	workB, bareB := makeBareWithRemote(t)
	gone := t.TempDir()
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	plain := t.TempDir()

	// 模拟队友推送：bare 各前进一步（工作区未拉取，tracking ref 仍指旧提交）
	for _, bare := range []string{bareA, bareB} {
		seed := t.TempDir()
		runGitAll(t, "clone", bare, seed)
		runGitAll(t, "-C", seed, "config", "user.email", "t@t")
		runGitAll(t, "-C", seed, "config", "user.name", "t")
		writeFileT(t, filepath.Join(seed, "new.txt"), "teammate\n")
		runGitAll(t, "-C", seed, "add", "-A")
		runGitAll(t, "-C", seed, "commit", "-m", "teammate commit")
		runGitAll(t, "-C", seed, "push")
	}
	oldA := gitRef(t, workA, "refs/remotes/origin/main")
	oldB := gitRef(t, workB, "refs/remotes/origin/main")

	for id, path := range map[string]string{
		"pa": workA, "pb": workB, "pg": gone, "pp": plain,
	} {
		if err := store.Get().Project.Create(config.ProjectConfig{ID: id, Name: "proj-" + id, Path: path}); err != nil {
			t.Fatal(err)
		}
	}

	r := gin.New()
	r.POST("/api/fetch-all", FetchAllProjects)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/fetch-all", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Data []FetchAllItem `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Data) != 4 {
		t.Fatalf("items = %d, want 4 (body=%s)", len(body.Data), w.Body.String())
	}
	byID := map[string]FetchAllItem{}
	for _, it := range body.Data {
		byID[it.ProjectID] = it
	}
	if it := byID["pa"]; !it.OK || it.Error != "" {
		t.Fatalf("pa = %+v, want ok", it)
	}
	if it := byID["pb"]; !it.OK || it.Error != "" {
		t.Fatalf("pb = %+v, want ok", it)
	}
	if it := byID["pg"]; it.OK || it.Error != "path missing" {
		t.Fatalf("pg = %+v, want path missing", it)
	}
	if it := byID["pp"]; it.OK || it.Error != "not a git repo" {
		t.Fatalf("pp = %+v, want not a git repo", it)
	}
	// fetch 真实生效：tracking ref 前进到 bare 的新提交
	if newA := gitRef(t, workA, "refs/remotes/origin/main"); newA == oldA {
		t.Fatalf("pa tracking ref unchanged after fetch-all (%s)", oldA)
	}
	if newB := gitRef(t, workB, "refs/remotes/origin/main"); newB == oldB {
		t.Fatalf("pb tracking ref unchanged after fetch-all (%s)", oldB)
	}
}

// gitRef 读仓库指定 ref 指向的 commit（不存在时 Fatal）
func gitRef(t *testing.T, repo, ref string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "rev-parse", ref)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-parse %s in %s: %v", ref, repo, err)
	}
	return strings.TrimSpace(string(out))
}
