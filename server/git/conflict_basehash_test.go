package git

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// conflictBaseHashSeed 生成含一处双子段冲突的工作区文件并返回磁盘原始字节 hash
//（GetConflictContent 回传的基线口径同源：contentHash(raw)）
func conflictBaseHashSeed(t *testing.T, dir, file, body string) string {
	t.Helper()
	full := filepath.Join(dir, file)
	if err := os.WriteFile(full, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	cc, err := GetConflictContent(dir, file)
	if err != nil {
		t.Fatal(err)
	}
	return cc.Hash
}

// TestResolveConflictWithContent_BaseHashMismatch 冲突文件在解析载入后、写回前
// 被外部修改：失配拒绝（ConflictStaleError），磁盘保持外部改动原样、错误携
// 磁盘当前解码文本（currentContent 契约对齐 files.WriteFile 的 409 载荷）
func TestResolveConflictWithContent_BaseHashMismatch(t *testing.T) {
	dir := t.TempDir()
	body := "<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> other\n"
	baseHash := conflictBaseHashSeed(t, dir, "f.txt", body)

	// 用户逐块斟酌期间，agent 改了盘上同一冲突文件
	external := "<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> other\nagent tweak\n"
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(external), 0644); err != nil {
		t.Fatal(err)
	}

	err := ResolveConflictWithContent(dir, "f.txt", "resolved\n", "", baseHash)
	var stale *ConflictStaleError
	if !errors.As(err, &stale) {
		t.Fatalf("err = %v, want *ConflictStaleError", err)
	}
	if stale.Error() != ConflictStaleMarker {
		t.Fatalf("marker = %q, want %q", stale.Error(), ConflictStaleMarker)
	}
	// currentContent = 磁盘当前解码文本（含外部改动，agent tweak 在场）
	if !strings.Contains(stale.CurrentContent, "agent tweak") {
		t.Fatalf("currentContent = %q, want external edit visible", stale.CurrentContent)
	}
	// 磁盘未被写回污染：外部改动原样保留
	onDisk, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != external {
		t.Fatalf("disk = %q, want external edit preserved", onDisk)
	}
}

// TestResolveConflictWithContent_BaseHashMatch 基线一致（载入后无人动过）：
// 写回成功，盘上内容即解决稿
func TestResolveConflictWithContent_BaseHashMatch(t *testing.T) {
	dir := t.TempDir()
	baseHash := conflictBaseHashSeed(t, dir, "f.txt",
		"<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> other\n")

	if err := ResolveConflictWithContent(dir, "f.txt", "resolved\n", "", baseHash); err != nil {
		t.Fatalf("write-back with matching hash failed: %v", err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "resolved\n" {
		t.Fatalf("disk = %q, want resolved content", onDisk)
	}
}

// TestResolveConflictWithContent_EmptyBaseHashLegacy 空 baseHash = 旧调用方
// 兼容直写（不做任何比对——升级窗口期旧前端/脚本零破坏）
func TestResolveConflictWithContent_EmptyBaseHashLegacy(t *testing.T) {
	dir := t.TempDir()
	conflictBaseHashSeed(t, dir, "f.txt",
		"<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> other\n")

	if err := ResolveConflictWithContent(dir, "f.txt", "legacy direct write\n", "", ""); err != nil {
		t.Fatalf("legacy write failed: %v", err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "legacy direct write\n" {
		t.Fatalf("disk = %q, want legacy direct write", onDisk)
	}
}

// TestResolveConflictWithContent_BaseHashDeletedFile 基线之后文件被删除：
// 跳过检测直写重建——覆盖写回是用户显式意图，无数据可丢（WriteFile 同口径）
func TestResolveConflictWithContent_BaseHashDeletedFile(t *testing.T) {
	dir := t.TempDir()
	baseHash := conflictBaseHashSeed(t, dir, "f.txt",
		"<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> other\n")
	if err := os.Remove(filepath.Join(dir, "f.txt")); err != nil {
		t.Fatal(err)
	}
	if err := ResolveConflictWithContent(dir, "f.txt", "recreated\n", "", baseHash); err != nil {
		t.Fatalf("write-back after delete failed: %v", err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "recreated\n" {
		t.Fatalf("disk = %q, want recreated content", onDisk)
	}
}
