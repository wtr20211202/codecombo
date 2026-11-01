package system

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// withTempLogDir 单测注入临时日志目录：serviceLogDir 走 config.DataDir()，
// 这里直接对 tailLogFile 传临时路径（纯函数无全局态）；dates 清单走
// listServiceLogDatesOn 目录参数化形态（见下），避免依赖进程级 DataDir
func writeTempLog(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write temp log: %v", err)
	}
	return path
}

// TestListServiceLogDatesOn 日期清单：合法日期收集、坏命名/坏日期段/子目录跳过、降序
func TestListServiceLogDatesOn(t *testing.T) {
	dir := t.TempDir()
	writeTempLog(t, dir, "simple-coding-2026-10-22.log", "")
	writeTempLog(t, dir, "simple-coding-2026-10-24.log", "")
	writeTempLog(t, dir, "simple-coding-2026-10-23.log", "")
	// 非法形态：无前缀 / 无 .log 后缀 / 坏日期段 / 子目录
	writeTempLog(t, dir, "other-2026-10-21.log", "")
	writeTempLog(t, dir, "simple-coding-20261020.log", "")
	writeTempLog(t, dir, "simple-coding-notadate.log", "")
	if err := os.MkdirAll(filepath.Join(dir, "simple-coding-2026-10-19.log"), 0o755); err != nil {
		t.Fatal(err)
	}

	dates, err := listServiceLogDatesOn(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(dates) != 3 {
		t.Fatalf("want 3 dates, got %v", dates)
	}
	// 降序：新→旧
	want := []string{"2026-10-24", "2026-10-23", "2026-10-22"}
	for i := range want {
		if dates[i] != want[i] {
			t.Fatalf("dates[%d]=%s want %s (full: %v)", i, dates[i], want[i], dates)
		}
	}
}

// TestTailLogFileWholeFile 小文件（单块内）整窗读出，时间序旧→新
func TestTailLogFileWholeFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "simple-coding-2026-10-24.log")
	content := "line-1\nline-2\nline-3\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, truncated, missing, err := tailLogFile(path, 200, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if missing || truncated {
		t.Fatalf("missing=%v truncated=%v want false/false", missing, truncated)
	}
	if len(lines) != 3 || lines[0] != "line-1" || lines[2] != "line-3" {
		t.Fatalf("lines=%v", lines)
	}
}

// TestTailLogFileNoTrailingNewline 末行无换行符也是完整行
func TestTailLogFileNoTrailingNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	if err := os.WriteFile(path, []byte("a\nb\nc"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, _, _, err := tailLogFile(path, 200, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 3 || lines[2] != "c" {
		t.Fatalf("lines=%v want [a b c]", lines)
	}
}

// TestTailLogFileLimitWindow 够行即停：limit 截取最新 N 行且 truncated=true
func TestTailLogFileLimitWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	var b strings.Builder
	for i := 1; i <= 50; i++ {
		b.WriteString("line-" + itoa(i) + "\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, truncated, _, err := tailLogFile(path, 5, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Fatal("limit 命中即停应 truncated=true")
	}
	if len(lines) != 5 || lines[0] != "line-46" || lines[4] != "line-50" {
		t.Fatalf("lines=%v want line-46..line-50", lines)
	}
}

// TestTailLogFileCrossChunk 跨块半行续整：块边界落在行中间，行不得劈裂/丢失。
// 内容总长 > 2 块（128KB），边界行两端各留标记核验完整性
func TestTailLogFileCrossChunk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	marker := "MARKER-CROSS-CHUNK-BOUNDARY"
	// 构造：若干整行 + 一条 90KB 长行（跨 64KB 块边界）+ 尾部若干行
	var b strings.Builder
	for i := 0; i < 100; i++ {
		b.WriteString("head-line-")
		b.WriteString(itoa(i))
		b.WriteString("\n")
	}
	b.WriteString(marker + "-HEAD-")
	for i := 0; i < 90*1024; i++ {
		b.WriteByte('x')
	}
	b.WriteString("-" + marker + "-TAIL\n")
	for i := 0; i < 50; i++ {
		b.WriteString("tail-line-")
		b.WriteString(itoa(i))
		b.WriteString("\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	// 全量（limit 超行数）：长行必须恰好一条且头尾标记都在
	lines, truncated, _, err := tailLogFile(path, 1000, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("全量读取不应 truncated")
	}
	cross := 0
	for _, l := range lines {
		if strings.Contains(l, marker) {
			cross++
			if !strings.HasPrefix(l, marker+"-HEAD-") || !strings.HasSuffix("-"+marker+"-TAIL", l[len(l)-len("-"+marker+"-TAIL"):]) {
				t.Fatalf("长行被劈裂: head=%q tail=%q", l[:30], l[len(l)-30:])
			}
		}
	}
	if cross != 1 {
		t.Fatalf("长行出现 %d 次 want 1", cross)
	}
	if len(lines) != 100+1+50 {
		t.Fatalf("lines=%d want %d（行不得跨块丢失）", len(lines), 151)
	}

	// 尾窗（limit=3，只覆盖尾部三行）
	tail3, _, _, err := tailLogFile(path, 3, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail3) != 3 || tail3[2] != "tail-line-49" || tail3[0] != "tail-line-47" {
		t.Fatalf("tail3=%v", tail3)
	}
}

// TestTailLogFileFilter 关键词过滤：q 命中行收集、大小写不敏感、truncated 语义
func TestTailLogFileFilter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	content := "INFO ok-1\nWARN disk almost full\nINFO ok-2\nERROR git timeout\nINFO ok-3\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, truncated, _, err := tailLogFile(path, 200, "warn", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0] != "WARN disk almost full" {
		t.Fatalf("lines=%v", lines)
	}
	if truncated {
		t.Fatal("扫到文件头不应 truncated")
	}

	// 命中数 < limit 时扫到文件头 → truncated=false；limit=1 时凑满即停只留
	// 最新一条命中——更早命中被 limit 丢弃，truncated=true（诚实回告窗口外
	// 还有更早命中）
	lines1, truncated1, _, err := tailLogFile(path, 1, "INFO ok", false)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated1 {
		t.Fatal("limit 凑满提前收手应 truncated=true")
	}
	if len(lines1) != 1 || lines1[0] != "INFO ok-3" {
		t.Fatalf("lines1=%v want 最新命中 ok-3", lines1)
	}
}

// TestTailLogFileFilterBudget 过滤态扫过预算即停（truncated=true 如实回告）。
// 直接以 logScanMaxBytes 边界构造：预算很小是常量——这里以小文件验证不了预算，
// 改验「truncated 在到达文件头时为 false」已由上例覆盖；本例验证空命中返回空
// 窗口而非错误
func TestTailLogFileFilterNoHit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	if err := os.WriteFile(path, []byte("a\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, truncated, _, err := tailLogFile(path, 200, "zzz-no-hit", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 0 || truncated {
		t.Fatalf("lines=%v truncated=%v want 空且 false", lines, truncated)
	}
}

// TestTailLogFileMissing 文件不存在：missing=true 空窗口非错误
func TestTailLogFileMissing(t *testing.T) {
	lines, truncated, missing, err := tailLogFile(filepath.Join(t.TempDir(), "absent.log"), 10, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !missing || truncated || len(lines) != 0 {
		t.Fatalf("missing=%v truncated=%v lines=%v", missing, truncated, lines)
	}
}

// TestTailLogFileMask 遮蔽命中：令牌/口令赋值/云密钥被替换，mask 关闭原文透出
func TestTailLogFileMask(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	content := "auth failed token=sca_abcdef1234567890\n" +
		"password: \"hunter2secret\"\n" +
		"aws key AKIAIOSFODNN7EXAMPLE in line\n" +
		"plain line no secret\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, _, _, err := tailLogFile(path, 200, "", true)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(lines, "\n")
	if strings.Contains(joined, "sca_abcdef") || strings.Contains(joined, "hunter2secret") || strings.Contains(joined, "AKIAIOSFODNN7EXAMPLE") {
		t.Fatalf("遮蔽漏值: %s", joined)
	}
	if !strings.Contains(lines[0], "token=***") {
		t.Fatalf("赋值形态键名应保留: %q", lines[0])
	}
	if !strings.Contains(lines[3], "plain line no secret") {
		t.Fatalf("普通行不应被遮: %q", lines[3])
	}

	// mask 关闭：原文透出（取证/对账档）
	raw, _, _, err := tailLogFile(path, 200, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw[0], "sca_abcdef") {
		t.Fatalf("mask 关闭应透出原文: %q", raw[0])
	}
}

// TestTailLogFileEmptyFile 空文件：空窗口不 truncated
func TestTailLogFileEmptyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	lines, truncated, missing, err := tailLogFile(path, 10, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 0 || truncated || missing {
		t.Fatalf("lines=%v truncated=%v missing=%v", lines, truncated, missing)
	}
}

// TestServiceLogPathUsesFormattedDate 路径由 Format 生成：注入带分隔符的原始
// 输入不可能逃出日志目录（handler 侧已 400 拒绝，此处钉路径构造的纯函数形态）
func TestServiceLogPathUsesFormattedDate(t *testing.T) {
	// 数据目录隔离（whoami_test 同款）：serviceLogPath 对「legacy 前缀同名
	// 文件已存在」的真实机器状态敏感（实测本机 .codecombo/logs 存有旧版
	// simple-coding-2026-10-24.log 即红）——本用例钉的是路径构造形态，
	// 空目录下 canonical 形态恒可断言
	t.Setenv("CC_DATA_DIR", t.TempDir())
	day, err := time.ParseInLocation(logDateLayout, "2026-10-24", time.Local)
	if err != nil {
		t.Fatal(err)
	}
	p := serviceLogPath(day)
	if filepath.Base(p) != "codecombo-2026-10-24.log" || filepath.Dir(p) != serviceLogDir() {
		t.Fatalf("path=%s", p)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
