package git

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// seedLock 在 repo 的 .git 下放置 index.lock 并把 mtime 拨到 ageMs 前，
// 返回锁文件路径（真实 git 写锁也是这个路径）
func seedLock(t *testing.T, repo string, ageMs int) string {
	t.Helper()
	lockPath := filepath.Join(repo, ".git", "index.lock")
	if err := os.WriteFile(lockPath, []byte(""), 0o644); err != nil {
		t.Fatalf("write lock: %v", err)
	}
	old := time.Now().Add(-time.Duration(ageMs) * time.Millisecond)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	return lockPath
}

// TestResolveGitDir .git 目录解析：常规目录与 worktree 形态（.git 为文件）
// （复用 merge.go 的既有解析器，此处只锁死 index.lock 链依赖的两种形态）
func TestResolveGitDir(t *testing.T) {
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if got, ok := resolveGitDir(repo); !ok || got != filepath.Join(repo, ".git") {
		t.Fatalf("dir form: got %q ok=%v", got, ok)
	}

	// worktree 形态：.git 是文件，gitdir 指向真实 git 目录（绝对路径）
	wt := t.TempDir()
	gitDir := filepath.Join(t.TempDir(), "worktrees", "x")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+gitDir+"\n"), 0o644); err != nil {
		t.Fatalf("write .git file: %v", err)
	}
	if got, ok := resolveGitDir(wt); !ok || got != gitDir {
		t.Fatalf("worktree form: got %q ok=%v", got, ok)
	}

	// 非 git 形态（.git 缺失 / .git 文件内容不是 gitdir 指针）不可解析
	if _, ok := resolveGitDir(t.TempDir()); ok {
		t.Fatal("missing .git should not resolve")
	}
	plain := t.TempDir()
	if err := os.WriteFile(filepath.Join(plain, ".git"), []byte("not a pointer\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, ok := resolveGitDir(plain); ok {
		t.Fatal("non-pointer .git file should not resolve")
	}
}

// TestDetectIndexLock 锁状态检测：无锁 nil / 新锁不 stale / 旧锁 stale 带锁龄
func TestDetectIndexLock(t *testing.T) {
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if info := DetectIndexLock(repo); info != nil {
		t.Fatalf("no lock: expect nil, got %+v", info)
	}

	// 新锁（正在写入的锁 mtime 必新）：不判遗留
	fresh := seedLock(t, repo, 0)
	info := DetectIndexLock(repo)
	if info == nil || info.Stale || info.Path != fresh {
		t.Fatalf("fresh lock: got %+v, want stale=false path=%s", info, fresh)
	}

	// 旧锁（远超 5 分钟阈值）：判遗留且锁龄可信
	seedLock(t, repo, 10*60*1000)
	info = DetectIndexLock(repo)
	if info == nil || !info.Stale || info.AgeSec < 590 {
		t.Fatalf("stale lock: got %+v, want stale=true ageSec>=590", info)
	}

	// worktree 形态同样可达锁文件：锁在 gitdir 指向的真实目录里
	wt := t.TempDir()
	gitDir := filepath.Join(t.TempDir(), "wt")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+gitDir+"\n"), 0o644); err != nil {
		t.Fatalf("write .git file: %v", err)
	}
	lockPath := filepath.Join(gitDir, "index.lock")
	if err := os.WriteFile(lockPath, []byte(""), 0o644); err != nil {
		t.Fatalf("write lock: %v", err)
	}
	old := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	if info := DetectIndexLock(wt); info == nil || !info.Stale || info.Path != lockPath {
		t.Fatalf("worktree lock: got %+v, want stale=true path=%s", info, lockPath)
	}
}

// TestUpgradeIndexLockError 错误升级双闸：仅写命令 + 错误含 index.lock + 锁陈旧
func TestUpgradeIndexLockError(t *testing.T) {
	orig := errors.New("orig")
	lockErr := "fatal: Unable to create 'repo/.git/index.lock': File exists"

	t.Run("读命令不升级", func(t *testing.T) {
		if got := upgradeIndexLockError("/nonexistent-repo", []string{"status"}, lockErr, orig); got != orig {
			t.Fatalf("read command must not upgrade, got %v", got)
		}
	})
	t.Run("错误不含 index.lock 不升级", func(t *testing.T) {
		if got := upgradeIndexLockError("/nonexistent-repo", []string{"commit", "-m", "x"}, "fatal: nothing to commit", orig); got != orig {
			t.Fatalf("non-lock error must not upgrade, got %v", got)
		}
	})
	t.Run("锁不存在不升级", func(t *testing.T) {
		if got := upgradeIndexLockError("/nonexistent-repo", []string{"commit", "-m", "x"}, lockErr, orig); got != orig {
			t.Fatalf("absent lock must not upgrade, got %v", got)
		}
	})
	t.Run("写命令+陈旧锁追加稳定标记", func(t *testing.T) {
		repo := t.TempDir()
		if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		seedLock(t, repo, 10*60*1000)
		got := upgradeIndexLockError(repo, []string{"add", "--", "a.txt"}, lockErr, orig)
		if got == orig || !strings.Contains(got.Error(), IndexLockStaleMarker) {
			t.Fatalf("stale lock must append marker, got %v", got)
		}
		if !strings.Contains(got.Error(), "orig") {
			t.Fatalf("原文必须保留, got %v", got)
		}
	})
	t.Run("写命令+新锁不升级", func(t *testing.T) {
		repo := t.TempDir()
		if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		seedLock(t, repo, 0)
		if got := upgradeIndexLockError(repo, []string{"commit", "-m", "x"}, lockErr, orig); got != orig {
			t.Fatalf("fresh lock must not upgrade, got %v", got)
		}
	})
	t.Run("nil 错误原样返回", func(t *testing.T) {
		if got := upgradeIndexLockError("/nonexistent-repo", []string{"commit"}, lockErr, nil); got != nil {
			t.Fatalf("nil error must stay nil, got %v", got)
		}
	})
}

// TestCleanStaleIndexLock 清理的误删保护与幂等：新锁拒绝 / 旧锁删除 / 无锁幂等
func TestCleanStaleIndexLock(t *testing.T) {
	t.Run("新锁拒绝且文件保留", func(t *testing.T) {
		repo := t.TempDir()
		if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		lockPath := seedLock(t, repo, 0)
		removed, ageSec, err := CleanStaleIndexLock(repo)
		if err == nil || removed {
			t.Fatalf("fresh lock must be refused, got removed=%v err=%v", removed, err)
		}
		if ageSec < 0 {
			t.Fatalf("ageSec should be reported, got %d", ageSec)
		}
		if _, statErr := os.Stat(lockPath); statErr != nil {
			t.Fatalf("fresh lock must survive: %v", statErr)
		}
	})
	t.Run("陈旧锁删除", func(t *testing.T) {
		repo := t.TempDir()
		if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		lockPath := seedLock(t, repo, 10*60*1000)
		removed, ageSec, err := CleanStaleIndexLock(repo)
		if err != nil || !removed {
			t.Fatalf("stale lock must be removed, got removed=%v err=%v", removed, err)
		}
		if ageSec < 590 {
			t.Fatalf("ageSec should reflect lock age, got %d", ageSec)
		}
		if _, statErr := os.Stat(lockPath); !os.IsNotExist(statErr) {
			t.Fatalf("lock file must be gone, stat err=%v", statErr)
		}
	})
	t.Run("无锁幂等成功", func(t *testing.T) {
		removed, ageSec, err := CleanStaleIndexLock(t.TempDir())
		if err != nil || removed || ageSec != 0 {
			t.Fatalf("absent lock should be idempotent success, got removed=%v age=%d err=%v", removed, ageSec, err)
		}
	})
}

// TestIndexLockClosedLoop 真实仓库闭环：真 git add 撞遗留锁 → 错误带稳定标记
// → 清理 → 写恢复
func TestIndexLockClosedLoop(t *testing.T) {
	repo := t.TempDir()
	if _, err := execGit(repo, "init", "-q"); err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := execGit(repo, "config", "user.email", "t@t"); err != nil {
		t.Fatalf("config: %v", err)
	}
	if _, err := execGit(repo, "config", "user.name", "t"); err != nil {
		t.Fatalf("config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := execGit(repo, "add", "."); err != nil {
		t.Fatalf("add: %v", err)
	}
	if _, err := execGit(repo, "commit", "-q", "-m", "base"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// 撞锁素材：改动已跟踪文件后遗留一把陈旧锁
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	seedLock(t, repo, 10*60*1000)

	// 写命令失败且错误带稳定标记（前端修复条的识别依据）
	err := Stage(repo, []string{"a.txt"})
	if err == nil {
		t.Fatal("stale lock must fail git add")
	}
	if !strings.Contains(err.Error(), "index.lock") || !strings.Contains(err.Error(), IndexLockStaleMarker) {
		t.Fatalf("error should carry lock text + marker, got %v", err)
	}

	// 一键清理 → 写恢复
	removed, _, err := CleanStaleIndexLock(repo)
	if err != nil || !removed {
		t.Fatalf("cleanup: removed=%v err=%v", removed, err)
	}
	if err := Stage(repo, []string{"a.txt"}); err != nil {
		t.Fatalf("write should recover after cleanup: %v", err)
	}
}
