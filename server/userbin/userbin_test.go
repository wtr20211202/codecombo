package userbin

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// seedFakeHome 剥离 PATH（守护进程盲区模拟）并把 HOME/USERPROFILE 指向临时
// 目录；返回写文件 helper（自动建父目录 + Unix 执行位）
func seedFakeHome(t *testing.T) func(rel, content string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("PATH", t.TempDir()) // 无任何可用 CLI 的空目录
	if runtime.GOOS == "windows" {
		t.Setenv("AppData", filepath.Join(home, "AppData", "Roaming"))
	}
	t.Cleanup(ResetCacheForTest)
	ResetCacheForTest()
	return func(rel, content string) {
		p := filepath.Join(home, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0o644)
		if runtime.GOOS != "windows" {
			mode = 0o755
		}
		if err := os.WriteFile(p, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
}

// Resolve：PATH 剥离后用户级候选命中（~/.local/bin——npm 用户 prefix/pipx）
func TestResolveUserLocalBin(t *testing.T) {
	write := seedFakeHome(t)
	write(".local/bin/claude", "#!/bin/sh\necho claude\n")

	p, ok := Resolve("claude")
	if !ok {
		t.Fatal("user-level claude not resolved")
	}
	if !filepath.IsAbs(p) || filepath.Base(p) != "claude" {
		t.Fatalf("resolved path = %q", p)
	}
}

// Resolve：nvm 多版本取 semver 最新（字典序 v9 < v18 会误导）
func TestResolveNvmNewest(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("nvm unix layout")
	}
	write := seedFakeHome(t)
	write(".nvm/versions/node/v9.11.2/bin/codex", "#!/bin/sh\nold\n")
	write(".nvm/versions/node/v22.14.0/bin/codex", "#!/bin/sh\nnew\n")

	p, ok := Resolve("codex")
	if !ok {
		t.Fatal("nvm codex not resolved")
	}
	if !strings.Contains(filepath.ToSlash(p), "v22.14.0") {
		t.Fatalf("want newest nvm version, got %q", p)
	}
}

// Resolve：Windows npm global 默认位置（%APPDATA%\npm\<name>.cmd）
func TestResolveWindowsNpmGlobal(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows npm layout")
	}
	write := seedFakeHome(t)
	write("AppData/Roaming/npm/claude.cmd", "@echo off\r\necho claude\r\n")

	p, ok := Resolve("claude")
	if !ok {
		t.Fatal("npm global claude.cmd not resolved")
	}
	if filepath.Ext(p) != ".cmd" {
		t.Fatalf("resolved path = %q", p)
	}
}

// 缓存：命中后删除文件短期内仍返回成功（成功 5min TTL）；
// 复位缓存后重新探测
func TestResolveCache(t *testing.T) {
	write := seedFakeHome(t)
	write(".local/bin/mytool", "#!/bin/sh\nx\n")
	if _, ok := Resolve("mytool"); !ok {
		t.Fatal("first resolve should hit")
	}
	if err := os.Remove(filepath.Join(homeDir(), ".local/bin/mytool")); err != nil {
		t.Fatal(err)
	}
	if _, ok := Resolve("mytool"); !ok {
		t.Fatal("cached result should survive file removal within TTL")
	}
	ResetCacheForTest()
	if _, ok := Resolve("mytool"); ok {
		t.Fatal("after cache reset the removal should be observed")
	}
}

// 未安装：全候选未命中返回 false（bash -lic 兜底在无 bash 的 PATH 环境
// 下同样未命中）
func TestResolveMissing(t *testing.T) {
	seedFakeHome(t)
	if _, ok := Resolve("definitely-not-installed-cli"); ok {
		t.Fatal("missing tool should not resolve")
	}
}

func homeDir() string {
	h, _ := os.UserHomeDir()
	return h
}
