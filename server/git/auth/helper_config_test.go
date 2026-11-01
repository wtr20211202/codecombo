package auth

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// TestGetCachedHelperConfigCreatesFile 验证首次调用会创建配置文件
// 文件权限 0600（POSIX）；内容包含 [credential] 段和 credential-helper 命令
//
// Windows 上文件系统不应用 POSIX 权限位（os.WriteFile(0600) stat 回报 0666），
// 因此权限断言仅在非 Windows 平台执行
func TestGetCachedHelperConfigCreatesFile(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	resetHelperConfigCache()

	path, cleanup, err := GetCachedHelperConfig()
	if err != nil {
		t.Fatalf("GetCachedHelperConfig: %v", err)
	}
	defer cleanup()

	if path == "" {
		t.Fatal("path is empty")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if runtime.GOOS != "windows" {
		if perm := info.Mode().Perm(); perm != 0600 {
			t.Errorf("perm = %o, want 0600", perm)
		}
	}

	// 验证内容包含 helper 配置
	data, _ := os.ReadFile(path)
	content := string(data)
	if !strings.Contains(content, "[credential]") {
		t.Errorf("missing [credential] section: %q", content)
	}
	if !strings.Contains(content, "credential-helper") {
		t.Errorf("missing helper command: %q", content)
	}
}

// TestGetCachedHelperConfigConcurrentSafe 验证 20 个 goroutine 并发调用返回同一路径
// 即 sync.Once 保证配置只写一次，所有后续调用直接复用缓存路径
func TestGetCachedHelperConfigConcurrentSafe(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	resetHelperConfigCache()

	var wg sync.WaitGroup
	paths := make([]string, 20)
	errs := make([]error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			p, _, err := GetCachedHelperConfig()
			if err != nil {
				errs[i] = err
				return
			}
			paths[i] = p
		}(i)
	}
	wg.Wait()

	// 所有调用应返回同一 path
	first := paths[0]
	if first == "" {
		t.Fatalf("first path is empty (err: %v)", errs[0])
	}
	for i, p := range paths {
		if errs[i] != nil {
			t.Errorf("goroutine %d error: %v", i, errs[i])
			continue
		}
		if p != first {
			t.Errorf("goroutine %d returned different path: %q vs %q", i, p, first)
		}
	}
}

// TestGetCachedHelperConfigContainsAbsoluteExePath 验证配置文件内 helper 行包含
// os.Executable() 解析出的绝对路径（git 通过该路径回调 simple-coding credential-helper）
func TestGetCachedHelperConfigContainsAbsoluteExePath(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	resetHelperConfigCache()

	path, cleanup, _ := GetCachedHelperConfig()
	defer cleanup()

	data, _ := os.ReadFile(path)
	exe, _ := os.Executable()
	abs, _ := filepath.Abs(exe)
	// Windows 下 abs 含反斜杠，但 git config 把 \ 当转义字符，写入时会被 ToSlash 转成正斜杠
	// 这里对期望值也做一次 ToSlash，跨平台断言一致
	expected := filepath.ToSlash(abs)
	if !strings.Contains(string(data), expected) {
		t.Errorf("config does not contain absolute exe path %q: %s", expected, data)
	}
}

// resetHelperConfigCache 重置进程级缓存（仅测试用）
// 测试间状态隔离：每个测试用例独立验证 sync.Once 行为
func resetHelperConfigCache() {
	cachedCfgPath = ""
	cfgOnce = sync.Once{}
}
