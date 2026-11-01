package git

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestRgSearchArgsTranslation rg 参数翻译表：与 git grep 语义逐项对齐
func TestRgSearchArgsTranslation(t *testing.T) {
	cases := []struct {
		name string
		opts SearchOptions
		want []string
	}{
		{
			name: "literal default",
			opts: SearchOptions{CaseSensitive: true},
			want: []string{"--vimgrep", "--no-messages", "--color", "never", "--path-separator", "/", "--hidden", "--glob", "!.git/**", "-F", "-e", "q"},
		},
		{
			name: "ignore case + word",
			opts: SearchOptions{CaseSensitive: false, WholeWord: true},
			want: []string{"--vimgrep", "--no-messages", "--color", "never", "--path-separator", "/", "--hidden", "--glob", "!.git/**", "-i", "-w", "-F", "-e", "q"},
		},
		{
			name: "regex + glob",
			opts: SearchOptions{CaseSensitive: true, UseRegex: true, FilePattern: "*.go"},
			want: []string{"--vimgrep", "--no-messages", "--color", "never", "--path-separator", "/", "--hidden", "--glob", "!.git/**", "-e", "q", "-g", "*.go"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rgSearchArgs("q", tc.opts)
			if strings.Join(got, "\x1f") != strings.Join(tc.want, "\x1f") {
				t.Fatalf("rgSearchArgs = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestSearchBackendRgSelected rg 可用且正常输出时选 rg 后端
func TestSearchBackendRgSelected(t *testing.T) {
	restoreRg(t, true, func(string, string, SearchOptions, int) ([]SearchMatch, error) {
		return []SearchMatch{
			{Path: "a/b.go", Line: 3, Column: 7, Content: "hello world", Match: "world"},
		}, nil
	})

	matches, err, backend := searchBackend("/repo", "world", SearchOptions{}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if backend != "rg" {
		t.Fatalf("backend = %q, want rg", backend)
	}
	if len(matches) != 1 || matches[0].Path != "a/b.go" {
		t.Fatalf("matches = %+v", matches)
	}
}

// TestSearchBackendFallbackOnRgError rg 执行失败时自动回退 git grep
func TestSearchBackendFallbackOnRgError(t *testing.T) {
	restoreRg(t, true, func(string, string, SearchOptions, int) ([]SearchMatch, error) {
		return nil, errors.New("exit status 2")
	})

	_, _, backend := searchBackend("/repo", "q", SearchOptions{}, 100)
	if backend != "git-grep" {
		t.Fatalf("backend = %q, want git-grep (fallback)", backend)
	}
}

// TestSearchBackendGitGrepWhenRgMissing PATH 无 rg 时直接走 git grep
func TestSearchBackendGitGrepWhenRgMissing(t *testing.T) {
	restoreRg(t, false, nil)

	_, _, backend := searchBackend("/repo", "q", SearchOptions{}, 100)
	if backend != "git-grep" {
		t.Fatalf("backend = %q, want git-grep", backend)
	}
}

// TestSearchWithRgReal 真机装有 rg 时做一次真实端到端搜索（没有则跳过）：
// 验证 vimgrep 输出经同一解析器得到 path/line/content，且路径为正斜杠
func TestSearchWithRgReal(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed")
	}
	repo := initRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "rg_sample.txt"),
		[]byte("alpha beta gamma\nsecond line beta\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(repo, "add", "."); err != nil {
		t.Fatal(err)
	}

	matches, err := SearchContent(repo, "beta", SearchOptions{CaseSensitive: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) < 2 {
		t.Fatalf("matches = %+v, want >= 2", matches)
	}
	for _, m := range matches {
		if m.Path != "rg_sample.txt" {
			t.Fatalf("path = %q, want rg_sample.txt（正斜杠归一）", m.Path)
		}
	}
}

// restoreRg 注入 rg 探测/执行桩并复位探测缓存，测试结束恢复
func restoreRg(t *testing.T, usable bool, searchFn func(string, string, SearchOptions, int) ([]SearchMatch, error)) {
	t.Helper()
	oldResolve, oldFn, oldOnce := rgResolveFn, rgSearchFn, rgOnce
	rgResolveFn = func(string) (string, bool) {
		return "rg-stub", usable
	}
	if searchFn != nil {
		rgSearchFn = searchFn
	}
	rgOnce = new(sync.Once) // 复位探测缓存，让本次注入生效
	t.Cleanup(func() {
		rgResolveFn, rgSearchFn, rgOnce = oldResolve, oldFn, oldOnce
	})
}
