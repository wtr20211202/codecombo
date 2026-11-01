package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/model"
)

// searchRepoFixture 构造三个提交的线性仓库：
//
//	F1 "fix: alpha widget"  → a.txt
//	F2 "feat: beta engine"  → dir/b.txt
//	F3 "chore: cleanup"     → a.txt
func searchRepoFixture(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")

	write := func(name, content string) {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(repo, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	write("a.txt", "one\n")
	must("add", ".")
	must("commit", "-q", "-m", "fix: alpha widget")
	write("dir/b.txt", "two\n")
	must("add", ".")
	must("commit", "-q", "-m", "feat: beta engine")
	write("a.txt", "three\n")
	must("add", ".")
	must("commit", "-q", "-m", "chore: cleanup")
	return repo
}

// SearchLog 内容搜索：字面子串（正则元字符按字面）、大小写不敏感
func TestSearchLogContent(t *testing.T) {
	repo := searchRepoFixture(t)

	got, err := SearchLog(repo, "ALPHA", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.Contains(got[0].Message, "alpha widget") {
		t.Fatalf("case-insensitive content search got %v", commitsHashes(got))
	}

	// 正则元字符按字面：fix: 不应被解析为重复正则
	got, err = SearchLog(repo, "fix:", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("literal meta search got %v", commitsHashes(got))
	}
}

// SearchLog id 模糊：hash 片段（子串、大小写不敏感）命中；与内容命中合并去重
func TestSearchLogByHash(t *testing.T) {
	repo := searchRepoFixture(t)
	all, err := SearchLog(repo, "e", 0) // 任意内容，只为拿全部 hash
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 {
		t.Fatalf("fixture should have 3 commits, got %d", len(all))
	}
	target := all[1].Hash
	frag := strings.ToUpper(target[2:9]) // hash 中段子串（7 位），大写

	got, err := SearchLog(repo, frag, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Hash != target {
		t.Fatalf("hash fragment search want %s got %v", target, commitsHashes(got))
	}
}

// isHexQuery 纯十六进制 7-40 位才走 hash 扫描（<7 会误伤 beef/dead/2024 等
// 纯 hex 字符常见词）
func TestIsHexQuery(t *testing.T) {
	cases := map[string]bool{
		"beef":                  false, // 常见英文词不该触发全量扫描
		"abcdef":                false, // 6 位过短
		"abcdef1":               true,
		strings.Repeat("a", 40): true,
		strings.Repeat("a", 41): false, // 超长
		"fix(web)":              false, // 非 hex
		"1234567":               true,
		"ABCDEF0":               true, // 大写 hex 合法
	}
	for q, want := range cases {
		if got := isHexQuery(q); got != want {
			t.Fatalf("isHexQuery(%q) = %v, want %v", q, got, want)
		}
	}
}

// GetDirectoryLog：必须能解析出提交（存量 bug 回归——曾因竖线 format 与
// parseLog 的 NUL/US 切分不匹配恒返回空）
func TestGetDirectoryLog(t *testing.T) {
	repo := searchRepoFixture(t)

	root, err := GetDirectoryLog(repo, ".", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(root) != 3 {
		t.Fatalf("root dir history want 3 commits got %d", len(root))
	}
	sub, err := GetDirectoryLog(repo, "dir", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sub) != 1 || !strings.Contains(sub[0].Message, "beta engine") {
		t.Fatalf("subdir history want only beta engine, got %v", commitsHashes(sub))
	}
}

func commitsHashes(commits []model.Commit) []string {
	out := make([]string, len(commits))
	for i, c := range commits {
		out[i] = c.Hash
	}
	return out
}

// emptyRepoFixture git init 后零提交的未出生分支仓库（无任何 ref/提交）
func emptyRepoFixture(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q", "-b", "main")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")
	return repo
}

// IsNoCommitsError：空仓裸 log / 显式分支（ambiguous argument + rev-parse 确认）
// 均判空仓；非空仓传错 ref 不误判、nil 不误判
func TestIsNoCommitsError(t *testing.T) {
	empty := emptyRepoFixture(t)

	_, err := GetLog(empty, "", 10, 0, "", "", "")
	if err == nil || !IsNoCommitsError(empty, err) {
		t.Fatalf("bare log in empty repo should be no-commits error, err=%v", err)
	}
	_, err = GetLog(empty, "main", 10, 0, "", "", "")
	if err == nil || !IsNoCommitsError(empty, err) {
		t.Fatalf("branch-arg log in empty repo should be no-commits error, err=%v", err)
	}
	_, err = GetFileLog(empty, "a.txt", 10)
	if err == nil || !IsNoCommitsError(empty, err) {
		t.Fatalf("file log in empty repo should be no-commits error, err=%v", err)
	}
	_, err = GetDirectoryLog(empty, ".", 10, 0)
	if err == nil || !IsNoCommitsError(empty, err) {
		t.Fatalf("dir log in empty repo should be no-commits error, err=%v", err)
	}

	repo := searchRepoFixture(t)
	_, err = GetLog(repo, "no-such-branch", 10, 0, "", "", "")
	if err == nil {
		t.Fatal("bad ref in non-empty repo should error")
	}
	if IsNoCommitsError(repo, err) {
		t.Fatalf("bad ref in non-empty repo must not be classified as no-commits: %v", err)
	}
	if IsNoCommitsError(repo, nil) {
		t.Fatal("nil error must not be classified as no-commits")
	}
}
