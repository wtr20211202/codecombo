package git

import (
	"net/url"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// fileURL 把本地目录转成 file:// URL（跨平台：Windows 盘符路径补前导 / 成
// file:///D:/...，unix 绝对路径天然以 / 开头）——分支预取 e2e/单测的本地远端形态
func fileURL(t *testing.T, dir string) string {
	t.Helper()
	p := filepath.ToSlash(dir)
	if p != "" && p[0] != '/' {
		p = "/" + p
	}
	u := url.URL{Scheme: "file", Path: p}
	return u.String()
}

// TestParseRemoteHeads ls-remote --heads 输出解析：取 refs/heads/* 分支名，
// 保持 ref 字典序；非 heads ref / 无 tab 行 / 空行 / 重复行跳过
func TestParseRemoteHeads(t *testing.T) {
	const (
		shaA = "1111111111111111111111111111111111111111"
		shaB = "2222222222222222222222222222222222222222"
		shaC = "3333333333333333333333333333333333333333"
	)
	output := strings.Join([]string{
		shaB + "\trefs/heads/feat/x",
		shaA + "\trefs/heads/main",
		shaC + "\trefs/tags/v1.0",    // 非 heads ref：跳过（防御，--heads 下不出现）
		shaC + "^{}\trefs/tags/v1.0", // Peeled 行：同上
		"",                           // 空行：跳过
		"no-tab-line",                // 无法解析：跳过
		shaA + "\trefs/heads/main",   // 重复 ref：去重
		"\trefs/heads/no-sha",        // sha 缺失：跳过
		shaB + "\trefs/heads/",       // 空分支名：跳过
	}, "\n")

	got := parseRemoteHeads(output)
	want := []string{"feat/x", "main"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseRemoteHeads = %v, want %v", got, want)
	}
	if got := parseRemoteHeads(""); got != nil {
		t.Fatalf("empty output should return nil, got %v", got)
	}
}

// TestListRemoteBranchesFromURL_LocalRepo 真实链路：本地仓库当远端（file://，
// 零网络零凭据），断言分支名列表完整且按 ref 字典序
func TestListRemoteBranchesFromURL_LocalRepo(t *testing.T) {
	if runtime.GOOS == "windows" && testing.Short() {
		t.Skip("short 模式跳过真实 git 调用")
	}
	dir := initRepo(t)
	for _, b := range []string{"feat/x", "feat/a"} {
		if _, err := execGit(dir, "branch", b); err != nil {
			t.Fatalf("git branch %s: %v", b, err)
		}
	}

	branches, err := ListRemoteBranchesFromURL(fileURL(t, dir), "")
	if err != nil {
		t.Fatalf("ListRemoteBranchesFromURL: %v", err)
	}
	want := []string{"feat/a", "feat/x", "main"}
	if !reflect.DeepEqual(branches, want) {
		t.Fatalf("branches = %v, want %v", branches, want)
	}
}

// TestListRemoteBranchesFromURL_NotARepo 失败路径：不存在的仓库 → error 携带
// 脱敏后的 git stderr（handler 按内容分类为「仓库不存在」），不含凭据注入痕迹
func TestListRemoteBranchesFromURL_NotARepo(t *testing.T) {
	if runtime.GOOS == "windows" && testing.Short() {
		t.Skip("short 模式跳过真实 git 调用")
	}
	_, err := ListRemoteBranchesFromURL(fileURL(t, filepath.Join(t.TempDir(), "no-such-repo")), "")
	if err == nil {
		t.Fatal("expected error for nonexistent repo")
	}
	// 错误携带 stderr detail（git 原文，前缀 git ls-remote），分类由 handler 负责
	if !strings.Contains(err.Error(), "git ls-remote") {
		t.Fatalf("err = %v, want 'git ls-remote' prefix with stderr detail", err)
	}
}
