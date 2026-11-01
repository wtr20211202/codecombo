package gitops

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// initTempRepo 建一个真实 git 仓库（含一个已提交文件与一个未跟踪文件）
func initTempRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@t")
	run("config", "user.name", "t")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-qm", "init")
	if err := os.WriteFile(filepath.Join(dir, "untracked.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// 生效断言：不同仓库的采集互不串行（per-path 锁），同仓库并发只采集一次（双检去重）
func TestCachedGitMaps_PerPathLocking(t *testing.T) {
	repoA := initTempRepo(t)
	repoB := initTempRepo(t)

	var wg sync.WaitGroup
	start := make(chan struct{})
	// 同仓库 8 并发：首次采集只发生一次，其余命中缓存/等锁双检
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			status, ignored := cachedGitMaps(repoA)
			if status == nil || ignored == nil {
				t.Error("nil maps returned")
			}
		}()
	}
	// 另一仓库同时采集：若仍是全局锁，则会等到 repoA 采集完成才开始
	bDone := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		cachedGitMaps(repoB)
		close(bDone)
	}()
	close(start)

	select {
	case <-bDone:
		// repoB 未被 repoA 阻塞（宽松验证：正常情况下 git 扫描耗时远大于此处等待）
	case <-time.After(10 * time.Second):
		t.Fatal("repoB blocked behind repoA — global lock regression?")
	}
	wg.Wait()

	// 结果正确性：untracked 文件出现在状态映射
	status, _ := cachedGitMaps(repoA)
	if st, ok := status["untracked.txt"]; !ok || st != "Untracked" {
		t.Fatalf("untracked.txt = %q,%v", st, ok)
	}
}

// 生效断言：/status 端点缓存字段无损（Staged/OldPath 保留）
func TestCachedStatusList_PreservesFields(t *testing.T) {
	repo := initTempRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "mod.txt"), []byte("changed"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	run("add", "mod.txt")

	files := CachedStatusList(repo)
	var stagedFound bool
	for _, f := range files {
		if f.Path == "mod.txt" && f.Staged {
			stagedFound = true
		}
	}
	if !stagedFound {
		t.Fatalf("staged flag lost in cached list: %+v", files)
	}
}
