package project

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestListDirEntriesIncludesSymlinkedDirs 目录浏览必须识别符号链接目录
// （此前 ReadDir 的 IsDir 对 symlink 返回 false，链接目录在添加项目选择器中不可见）
func TestListDirEntriesIncludesSymlinkedDirs(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unavailable on this platform/user: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 悬空链接（目标不存在）：不纳入
	_ = os.Symlink(filepath.Join(dir, "missing"), filepath.Join(dir, "dangling"))

	entries, err := listDirEntries(dir)
	if err != nil {
		t.Fatal(err)
	}
	byName := make(map[string]DirEntry, len(entries))
	for _, e := range entries {
		byName[e.Name] = e
	}
	got, ok := byName["link"]
	if !ok {
		t.Fatalf("symlinked dir missing from listing: %+v", entries)
	}
	if !got.Link {
		t.Fatalf("symlinked dir entry should carry Link=true: %+v", got)
	}
	if _, ok := byName["real"]; !ok {
		t.Fatalf("real dir missing: %+v", entries)
	}
	if _, ok := byName["file.txt"]; ok {
		t.Fatalf("regular file must be excluded: %+v", entries)
	}
	if _, ok := byName["dangling"]; ok {
		t.Fatalf("dangling symlink must be excluded: %+v", entries)
	}
}

// TestParentEntryAtDriveRoot 盘根/文件系统根的父目录条目指向自身：
// 前端据此禁用「上一级」按钮（顶层视图无更上级）。
// 注意根的自指比较用 filepath.Clean 归一——Windows 下 Clean("/")=="\\"。
// 盘符断言是 Windows 契约：filepath.Dir("C:\\") 在 Linux 把整串当一个
// segment 返回 "."，而产品在 Linux 的浏览流不产生盘符路径——非 Windows
// 只跑 POSIX 路径断言（WSL/Linux 实测踩中）
func TestParentEntryAtDriveRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		e := parentEntry(`C:\`)
		if e.Name != ".." || filepath.Clean(e.Path) != filepath.Clean(`C:\`) {
			t.Fatalf("drive root parent should be self: %+v", e)
		}
	}
	e := parentEntry("/")
	if filepath.Clean(e.Path) != filepath.Clean("/") {
		t.Fatalf("fs root parent should be self: %+v", e)
	}
	e = parentEntry(`/home/user`)
	if filepath.Clean(e.Path) != filepath.Clean(`/home`) {
		t.Fatalf("nested parent wrong: %+v", e)
	}
}
