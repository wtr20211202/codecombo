package app

// P-20261122-6 PID 文件第五行构建版本的写侧契约：格式位次固定（pid/port/
// [loopback]/scheme/version），空版本回落旧四行形态（向后兼容——旧版本 CLI 与
// 旧实例读取面都按 SplitN 截断容忍多余行）。读侧在 server/update（readPIDVersion）
// 与更新子进程的版本证据门成对，两侧格式必须同步改

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"codecombo/server/config"
)

// TestWritePIDFileSchemeVersionLine 版本行位次与空版本回落
func TestWritePIDFileSchemeVersionLine(t *testing.T) {
	t.Setenv("SC_DATA_DIR", "")
	t.Setenv("CC_DATA_DIR", t.TempDir())
	// 数据目录经 config.DataDir() 归一（Windows 短名展开），断言也读同一路径
	pidPath := filepath.Join(config.DataDir(), "codecombo.pid")

	writePIDFileScheme(9999, 10000, "https", "0.0.2-new")
	lines := strings.Split(strings.TrimSpace(string(mustReadPIDFile(t, pidPath))), "\n")
	want := []string{strconv.Itoa(os.Getpid()), "9999", "10000", "https", "0.0.2-new"}
	if strings.Join(lines, "|") != strings.Join(want, "|") {
		t.Fatalf("pid file lines = %v, want %v", lines, want)
	}

	// 版本缺席（旧形态/空值）→ 第四行 scheme 收尾，不写空行占位
	writePIDFileScheme(9999, 0, "http", "")
	lines = strings.Split(strings.TrimSpace(string(mustReadPIDFile(t, pidPath))), "\n")
	want = []string{strconv.Itoa(os.Getpid()), "9999", "http"}
	if strings.Join(lines, "|") != strings.Join(want, "|") {
		t.Fatalf("no-version pid file lines = %v, want %v", lines, want)
	}
}

func mustReadPIDFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read pid file %s: %v", path, err)
	}
	return data
}

// ── P-20261122-2 条件删除测试（两侧同名新建文件并集：本侧 test 与 P-6 版本行测试零符号冲突）──

func writePIDFile(t *testing.T, dir string, pid int) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "codecombo.pid"), []byte(strconv.Itoa(pid)+"\n9999\n"), 0o644); err != nil {
		t.Fatalf("write pid file: %v", err)
	}
}

func pidFileExists(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "codecombo.pid"))
	return err == nil
}

func TestRemovePIDFileConditional(t *testing.T) {
	t.Run("own pid removed", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("CC_DATA_DIR", dir)
		writePIDFile(t, dir, os.Getpid())
		removePIDFile()
		if pidFileExists(dir) {
			t.Fatal("own pid file must be removed")
		}
	})

	t.Run("foreign (restarted instance) pid preserved", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("CC_DATA_DIR", dir)
		// 新实例已重写的 PID（远超 pid_max 的不存在值，只比对不探测）
		writePIDFile(t, dir, 2147483000)
		removePIDFile()
		if !pidFileExists(dir) {
			t.Fatal("foreign pid file (restarted instance) must be preserved")
		}
	})

	t.Run("missing file no-op", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("CC_DATA_DIR", dir)
		removePIDFile() // 不得 panic，静默返回
		if pidFileExists(dir) {
			t.Fatal("unexpected pid file after no-op removal")
		}
	})

	t.Run("garbage content removed", func(t *testing.T) {
		// 解析不出 PID（半写崩溃残留）按本进程文件对待——旧行为删除，
		// 条件守卫不因坏行而保留垃圾
		dir := t.TempDir()
		t.Setenv("CC_DATA_DIR", dir)
		if err := os.WriteFile(filepath.Join(dir, "codecombo.pid"), []byte("not-a-pid\n"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		removePIDFile()
		if pidFileExists(dir) {
			t.Fatal("garbage pid file must be removed")
		}
	})
}
