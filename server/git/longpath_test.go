package git

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// TestLongPaths_DeepWorktree 决策门 M5.3 的回归测试：Windows 上超过 MAX_PATH(260)
// 的深嵌套工作区，git status/add/commit 经 -c core.longpaths=true 必须正常工作。
// 直接文件操作（MkdirAll/WriteFile）由 Go 运行时原生处理，无需 git 侧修复
// （判定依据见 server/api/files/longpath_test.go）。
// 非 Windows 无此概念，跳过。
func TestLongPaths_DeepWorktree(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("决策门仅针对 Windows MAX_PATH")
	}
	repo := t.TempDir()
	if _, err := execGit(repo, "init", "-q"); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := execGit(repo, "config", "user.email", "t@t"); err != nil {
		t.Fatalf("config email: %v", err)
	}
	if _, err := execGit(repo, "config", "user.name", "t"); err != nil {
		t.Fatalf("config name: %v", err)
	}

	// 构造总长 >260 的深层文件（60 层 × 4 字符 + temp 基础路径）
	deep := repo
	for i := 0; i < 60; i++ {
		deep = filepath.Join(deep, "d00")
	}
	if len(deep) <= 260 {
		t.Fatalf("测试前提不成立：路径长度 %d 未超过 260", len(deep))
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatalf("MkdirAll(>260): %v", err)
	}
	if err := os.WriteFile(filepath.Join(deep, "x.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile(>260): %v", err)
	}

	if _, err := execGit(repo, "add", "-A"); err != nil {
		t.Fatalf("add(>260): %v —— core.longpaths 未生效", err)
	}
	if _, err := execGit(repo, "commit", "-qm", "deep"); err != nil {
		t.Fatalf("commit(>260): %v", err)
	}
	out, err := execGit(repo, "status", "--porcelain")
	if err != nil || out != "" {
		t.Fatalf("status(>260) after commit: out=%q err=%v", out, err)
	}
}

// 缓存失效钩子必须穿透新引入的 -c 前缀：findSubcommand 跳过全局选项及其值后
// 仍能定位真实子命令（否则写操作后缓存不失效，徽章在 TTL 窗口内陈旧）
func TestMaybeInvalidateCaches_ThroughLongPathsPrefix(t *testing.T) {
	const path = "/fake/longpaths"
	repoInfoCache.Store(path, repoInfoEntry{branch: "main", at: time.Now()})
	aheadCache.Store(path, aheadEntry{branch: "main", at: time.Now()})

	maybeInvalidateCaches(path, []string{"-c", "core.longpaths=true", "commit", "-m", "x"}, nil)

	if _, ok := aheadCache.Load(path); ok {
		t.Error("-c 前缀后的 commit 必须仍触发 ahead 缓存失效")
	}
	if _, ok := repoInfoCache.Load(path); ok {
		t.Error("-c 前缀后的 commit 必须仍触发 repoInfo 缓存失效")
	}
}
