package store

// 失败路径必产日志断言（P-20261122-12 必改4）：token salt 落盘失败必须留
// WARN——盐不落盘时本进程内校验照常，重启后盐重新生成会让全部既有令牌失效，
// 用户只感知「重启后全要重新登录」；此前完全静默无从归因。
// 包内测试（package store）而非 store_test：persistTokenSalt 是未导出实现细节，
// 且包级 sync.Once 使 getTokenSalt 无法在同一测试二进制内重放失败态。

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// tokenLogCapture 捕获 Warn 及以上记录。
type tokenLogCapture struct {
	mu   sync.Mutex
	msgs []string
}

func (c *tokenLogCapture) Enabled(_ context.Context, level slog.Level) bool {
	return level >= slog.LevelWarn
}
func (c *tokenLogCapture) Handle(_ context.Context, r slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, r.Message)
	return nil
}
func (c *tokenLogCapture) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c *tokenLogCapture) WithGroup(string) slog.Handler      { return c }
func (c *tokenLogCapture) found(substr string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, m := range c.msgs {
		if strings.Contains(m, substr) {
			return true
		}
	}
	return false
}

// TestPersistTokenSaltFailureLogs 目录/文件都不可写时两条 WARN 齐备；
// 正常路径零告警（防每台机器启动都刷 WARN）。
func TestPersistTokenSaltFailureLogs(t *testing.T) {
	c := &tokenLogCapture{}
	orig := slog.Default()
	slog.SetDefault(slog.New(c))
	t.Cleanup(func() { slog.SetDefault(orig) })

	dir := t.TempDir()
	// 用文件占位 data 目录：MkdirAll 与 WriteFile 都必失败（三平台一致）
	blocker := filepath.Join(dir, "data")
	if err := os.WriteFile(blocker, []byte("occupied"), 0o644); err != nil {
		t.Fatal(err)
	}
	persistTokenSalt(filepath.Join(blocker, "token-salt"), []byte("0123456789abcdef"))
	if !c.found("token salt") {
		t.Fatalf("盐落盘失败无告警，msgs = %v", c.msgs)
	}

	// 正常路径：零告警
	c2 := &tokenLogCapture{}
	slog.SetDefault(slog.New(c2))
	persistTokenSalt(filepath.Join(dir, "ok", "token-salt"), []byte("0123456789abcdef"))
	if len(c2.msgs) != 0 {
		t.Fatalf("正常落盘不应告警，msgs = %v", c2.msgs)
	}
}
