package app

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"testing"
	"time"
)

// 可观测性装配验收（P-20261122-9 必改B/必改C）：
//   - CC_LOG_LEVEL 解析（大小写不敏感/非法值回落 Info 且报错）；
//   - dailyHandler.Enabled 读 LevelVar（运行期切换即时生效——53 处 slog.Debug
//     生产不可见的历史问题靠这个口打开）；
//   - crash.log 安装（文件创建 + 头注 + >1MiB 启动期轮转 .1）。

func TestResolveLogLevel(t *testing.T) {
	cases := []struct {
		raw     string
		want    slog.Level
		wantErr bool
	}{
		{"", slog.LevelInfo, false},         // 未设置 = 历史默认
		{"info", slog.LevelInfo, false},     //
		{"debug", slog.LevelDebug, false},   //
		{" DEBUG ", slog.LevelDebug, false}, // 大小写 + 空白容忍
		{"Warn", slog.LevelWarn, false},     // slog 词表外的大小写形态
		{"warning", slog.LevelWarn, false},  // 宽松同义词
		{"error", slog.LevelError, false},   //
		{"verbose", slog.LevelInfo, true},   // 非法值：回落 Info + 报错（启动告警）
	}
	for _, c := range cases {
		lv, err := resolveLogLevel(c.raw)
		if (err != nil) != c.wantErr {
			t.Fatalf("resolveLogLevel(%q) err = %v, wantErr=%v", c.raw, err, c.wantErr)
		}
		if lv == nil || lv.Level() != c.want {
			t.Fatalf("resolveLogLevel(%q) level = %v, want %v", c.raw, lv, c.want)
		}
	}
}

// LevelVar 动态生效：同一 handler 实例上切级别即可放行 Debug（无需重建），
// 且已在 Info 时被过滤的 Debug 不落盘
func TestDailyHandlerLevelVarDynamic(t *testing.T) {
	dir := t.TempDir()
	lv := new(slog.LevelVar)
	lv.Set(slog.LevelInfo)
	h := &dailyHandler{logDir: dir, prefix: "codecombo", maxAge: 15, level: lv}
	defer h.Close()
	logger := slog.New(h)
	ctx := context.Background()

	if h.Enabled(ctx, slog.LevelDebug) {
		t.Fatal("Debug must be filtered at the default info level")
	}
	logger.Debug("debug-line-before")

	lv.Set(slog.LevelDebug)
	if !h.Enabled(ctx, slog.LevelDebug) {
		t.Fatal("Debug must be enabled after LevelVar.Set(debug)")
	}
	logger.Debug("debug-line-after")

	body := readDailyLog(t, dir)
	if strings.Contains(body, "debug-line-before") {
		t.Fatalf("line before level switch must stay filtered, got %q", body)
	}
	if !strings.Contains(body, "debug-line-after") {
		t.Fatalf("line after level switch must land in the daily file, got %q", body)
	}
}

// 零值 handler（测试构造/极早期路径）不因 level 指针为 nil 而 panic：回落 Info
func TestDailyHandlerNilLevelFallsBackToInfo(t *testing.T) {
	h := &dailyHandler{}
	ctx := context.Background()
	if h.Enabled(ctx, slog.LevelDebug) {
		t.Fatal("nil level must filter Debug (Info fallback)")
	}
	if !h.Enabled(ctx, slog.LevelInfo) {
		t.Fatal("nil level must allow Info (Info fallback)")
	}
}

func TestInstallCrashOutputCreatesFileWithHeader(t *testing.T) {
	dir := t.TempDir()
	path, err := installCrashOutput(dir)
	if err != nil {
		t.Fatalf("installCrashOutput: %v", err)
	}
	// 还原进程级崩溃输出，防跨用例泄漏 fd
	t.Cleanup(func() { _ = debug.SetCrashOutput(nil, debug.CrashOptions{}) })
	if path != crashLogPath(dir) {
		t.Fatalf("path = %q, want %q", path, crashLogPath(dir))
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read crash.log: %v", err)
	}
	if !strings.Contains(string(body), "# crash.log") {
		t.Fatalf("crash.log header missing, got %q", string(body))
	}
}

// 启动期轮转：>1MiB 时把上一份挪到 .1（崩溃转储可能 MB 级，防无界增长）
func TestInstallCrashOutputRotatesLargeFile(t *testing.T) {
	dir := t.TempDir()
	path := crashLogPath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	big := strings.Repeat("x", crashLogMaxBytes+1)
	if err := os.WriteFile(path, []byte(big), 0644); err != nil {
		t.Fatalf("seed crash.log: %v", err)
	}
	if _, err := installCrashOutput(dir); err != nil {
		t.Fatalf("installCrashOutput: %v", err)
	}
	t.Cleanup(func() { _ = debug.SetCrashOutput(nil, debug.CrashOptions{}) })

	rotated, err := os.ReadFile(path + ".1")
	if err != nil || len(rotated) != len(big) {
		t.Fatalf("rotated file = %d bytes (err %v), want %d", len(rotated), err, len(big))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat fresh crash.log: %v", err)
	}
	if info.Size() >= int64(len(big)) {
		t.Fatalf("fresh crash.log = %d bytes, want a fresh file after rotation", info.Size())
	}
}

// readDailyLog 读当天日志（handler 的文件名按本地日期滚动）
func readDailyLog(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "codecombo-"+time.Now().Format("2006-01-02")+".log")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read daily log: %v", err)
	}
	return string(b)
}
