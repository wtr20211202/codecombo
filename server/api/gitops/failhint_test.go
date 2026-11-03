package gitops

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/git"
)

// P-20261005-194 门禁：git 域失败响应的恢复 hint（{kind[, detail]}）端到端断言。
// hint 与 code 正交（码管注册文案、kind 管恢复动作），三载体各一例：
//   - respondGitError 统一出口（push 被拒 → non-fast-forward，真实 bare 远端构造）
//   - respondGitError 与 code 同体（遗留锁 → kind=lock + code=git.index_lock_stale）
//   - PullRemote 自有 409 通道（冲突写在 stdout，hint 判定须并入 output）

// TestPushRemote_NonFastForward_Hint push 被拒端到端：真实 bare 远端 + 队友先推，
// 本地落后再推 → 500 响应附 hint.kind=non-fast-forward（agent 自愈=pull-再-push）
func TestPushRemote_NonFastForward_Hint(t *testing.T) {
	useDevMode(t)

	f := newFixtureRepo(t)
	bare := filepath.Join(t.TempDir(), "origin.git")
	if out, err := exec.Command("git", "init", "--bare", "-b", "main", bare).CombinedOutput(); err != nil {
		t.Fatalf("init bare: %v (%s)", err, out)
	}
	f.run("remote", "add", "origin", bare)
	f.run("push", "-u", "origin", "main")
	// 队友从 bare 克隆、前进一格并推送；本地不动 → push 必被拒（fetch first）
	team := t.TempDir()
	if out, err := exec.Command("git", "clone", bare, team).CombinedOutput(); err != nil {
		t.Fatalf("clone: %v (%s)", err, out)
	}
	teamRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = team
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("teammate git %v: %v (%s)", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(team, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	teamRun("commit", "-am", "teammate advances")
	teamRun("push")

	r := setupGitopsTest(t, f)
	r.POST("/api/projects/:id/push", PushRemote)

	w := post(r, "/api/projects/p1/push", `{"remote":"origin","branch":"main"}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500, body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"kind":"`+git.FailNonFastForward+`"`) {
		t.Errorf("body must carry hint kind %s, got %s", git.FailNonFastForward, w.Body.String())
	}
	// 既有契约不回退：无 hint 的错误响应不带 hint 字段（增量兼容约定）
	w = post(r, "/api/projects/p1/push", `{"remote":"origin","branch":"main","force":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("force push should succeed, status=%d body=%s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "hint") {
		t.Errorf("success response must not carry hint, got %s", w.Body.String())
	}
}

// TestStageFiles_IndexLockStale_HintWithCode hint 与 code 同体：遗留锁写命令失败
// → kind=lock（Detail 提取锁路径）与 git.index_lock_stale 并存（正交字段双承载）
func TestStageFiles_IndexLockStale_HintWithCode(t *testing.T) {
	useDevMode(t)

	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)
	r.POST("/api/projects/:id/stage", StageFiles)

	f.write("a.txt", "changed\n")
	lockPath := seedStaleLock(t, f)

	w := post(r, "/api/projects/p1/stage", `{"files":["a.txt"]}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500, body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"kind":"`+git.FailLock+`"`) {
		t.Errorf("body must carry hint kind %s, got %s", git.FailLock, body)
	}
	if !strings.Contains(body, `"code":"git.index_lock_stale"`) {
		t.Errorf("hint must coexist with code, got %s", body)
	}
	// 锁路径三形态容忍：构造用 TempDir 原样（Windows runner 可能为 8.3 短名）、
	// 正斜杠形态、git 真实化后的长名形态（git 报错文本输出它自己解析的路径）
	expectReal := lockPath
	if real, err := filepath.EvalSymlinks(filepath.Dir(lockPath)); err == nil {
		expectReal = filepath.ToSlash(filepath.Join(real, filepath.Base(lockPath)))
	}
	if !strings.Contains(body, filepath.ToSlash(lockPath)) && !strings.Contains(body, lockPath) && !strings.Contains(body, expectReal) {
		t.Errorf("hint detail should carry lock path %s (real %s), got %s", lockPath, expectReal, body)
	}
}

// TestPullRemote_Conflict_Hint 冲突 pull 的 409 通道 hint：同文件分叉真实冲突
// → kind=conflict。pull 冲突的 CONFLICT 行写 stdout、exec 层失败即弃（stderr 只
// 有 fetch 进度，git 2.45 实测），文本特征判不中——此例守的是「仓库冲突态兜底」
// 分支（PullRemote 侧 GetConflictFiles 事实源）
func TestPullRemote_Conflict_Hint(t *testing.T) {
	useDevMode(t)

	f := newFixtureRepo(t)
	bare := filepath.Join(t.TempDir(), "origin.git")
	if out, err := exec.Command("git", "init", "--bare", "-b", "main", bare).CombinedOutput(); err != nil {
		t.Fatalf("init bare: %v (%s)", err, out)
	}
	f.run("remote", "add", "origin", bare)
	f.run("push", "-u", "origin", "main")
	f.run("config", "pull.rebase", "false") // 分叉拉取钉死 merge 策略（git ≥2.34 无配置时 diverged pull 直接 fatal，到不了冲突）
	// 队友改同一行并推送；本地也改同一行落提交 → pull 必停冲突
	team := t.TempDir()
	if out, err := exec.Command("git", "clone", bare, team).CombinedOutput(); err != nil {
		t.Fatalf("clone: %v (%s)", err, out)
	}
	teamRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = team
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("teammate git %v: %v (%s)", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(team, "a.txt"), []byte("teammate line\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	teamRun("commit", "-am", "teammate rewrites")
	teamRun("push")
	f.write("a.txt", "local line\n")
	f.run("commit", "-am", "local rewrites")

	r := setupGitopsTest(t, f)
	r.POST("/api/projects/:id/pull", PullRemote)

	w := post(r, "/api/projects/p1/pull", `{}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"kind":"`+git.FailConflict+`"`) {
		t.Errorf("body must carry hint kind %s, got %s", git.FailConflict, w.Body.String())
	}
}
