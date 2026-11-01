package git

import (
	"os"
	"os/exec"
	"strings"
	"path/filepath"
	"testing"
)

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}

// runGit 在目录执行 git 命令（失败即 fatal）
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// setupUpstreamRepo 建本地仓库 + bare 远端 + 推送建立 upstream
func setupUpstreamRepo(t *testing.T) (string, string) {
	t.Helper()
	base := t.TempDir()
	remote := filepath.Join(base, "origin.git")
	work := filepath.Join(base, "work")
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(cmd.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if out, err := exec.Command("git", "init", "--bare", "-b", "main", remote).CombinedOutput(); err != nil {
		t.Fatalf("init bare: %v: %s", err, out)
	}
	run("", "init", "-b", "main", work)
	run(work, "config", "user.email", "t@t")
	run(work, "config", "user.name", "t")
	if err := writeFile(work+"/a.txt", "one\n"); err != nil {
		t.Fatal(err)
	}
	run(work, "add", "-A")
	run(work, "commit", "-m", "c1")
	run(work, "remote", "add", "origin", remote)
	run(work, "push", "-u", "origin", "main")
	return work, remote
}

func TestGetRepoHeadTracking(t *testing.T) {
	work, remote := setupUpstreamRepo(t)
	_ = remote

	// 与 upstream 同步：0/0
	branch, ahead, behind, err := GetRepoHeadTracking(work)
	if err != nil || branch != "main" || ahead != 0 || behind != 0 {
		t.Fatalf("sync state: branch=%q ahead=%d behind=%d err=%v", branch, ahead, behind, err)
	}

	// 本地多一个提交 → ahead 1
	runGit(t, work, "commit", "--allow-empty", "-m", "c2")
	_, ahead, behind, err = GetRepoHeadTracking(work)
	if err != nil || ahead != 1 || behind != 0 {
		t.Fatalf("ahead state: ahead=%d behind=%d err=%v", ahead, behind, err)
	}

	// upstream 多一个提交：clone bare 远端 → 提交并推送 → 工作仓库 fetch →
	// 回退本地一个提交 → behind 1
	cloneDir := work + "-clone"
	if out, err := exec.Command("git", "clone", "--quiet", remotePathOf(work), cloneDir).CombinedOutput(); err != nil {
		t.Fatalf("clone: %v: %s", err, out)
	}
	runGit(t, cloneDir, "config", "user.email", "t@t")
	runGit(t, cloneDir, "config", "user.name", "t")
	runGit(t, cloneDir, "commit", "--allow-empty", "-m", "c3")
	runGit(t, cloneDir, "push", "origin", "HEAD:main")
	runGit(t, work, "fetch", "origin")
	runGit(t, work, "reset", "--hard", "HEAD~1")
	_, ahead, behind, err = GetRepoHeadTracking(work)
	if err != nil || ahead != 0 || behind != 1 {
		t.Fatalf("behind state: ahead=%d behind=%d err=%v", ahead, behind, err)
	}
}

// remotePathOf 由工作仓库反查 origin URL（bare 远端路径）
func remotePathOf(work string) string {
	out, err := exec.Command("git", "-C", work, "remote", "get-url", "origin").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func TestGetHeadTrackingCached(t *testing.T) {
	work, _ := setupUpstreamRepo(t)
	branch, ahead, behind := GetHeadTrackingCached(work)
	if branch != "main" || ahead != 0 || behind != 0 {
		t.Fatalf("cached first: %q %d %d", branch, ahead, behind)
	}
	// TTL 窗口内二次调用走缓存（结果一致即可，无法直接断言零进程）
	branch2, ahead2, behind2 := GetHeadTrackingCached(work)
	if branch2 != branch || ahead2 != ahead || behind2 != behind {
		t.Fatalf("cached second differs: %q %d %d", branch2, ahead2, behind2)
	}
}
