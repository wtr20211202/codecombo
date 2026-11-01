package files

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestDeepPath_OsLevel 验证 Go 运行时在 Windows 上对超过 MAX_PATH(260) 的
// 深层路径的原生行为：os.MkdirAll/WriteFile/ReadFile/ReadDir 是否可用。
// 这是「是否需要显式 \\?\ 前缀修复」的判定依据（决策门见
// docs/design/continuation-roadmap.md M5.3）。
// 非 Windows 上该测试只验证等价深层路径功能，无决策意义。
func TestDeepPath_OsLevel(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("决策门仅针对 Windows MAX_PATH")
	}
	base := t.TempDir()
	p := base
	for i := 0; i < 60; i++ {
		p = filepath.Join(p, "d00")
	}
	if len(p) <= 260 {
		t.Fatalf("测试前提不成立：构造的路径长度 %d 未超过 260", len(p))
	}

	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatalf("MkdirAll(>260): %v —— Go 未原生处理超长路径，需要显式修复", err)
	}
	f := filepath.Join(p, "x.txt")
	if err := os.WriteFile(f, []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile(>260): %v", err)
	}
	data, err := os.ReadFile(f)
	if err != nil || string(data) != "hello" {
		t.Fatalf("ReadFile(>260): %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(f))
	if err != nil || len(entries) != 1 {
		t.Fatalf("ReadDir(>260): %v", err)
	}
}
