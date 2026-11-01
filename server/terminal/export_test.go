package terminal

import (
	"strings"
	"testing"
	"time"
)

// —— ExportDownloadName（下载名合成：净化/摘要/回退，与前端 exportFileName 同约定）——

func TestExportDownloadNameBasic(t *testing.T) {
	got := ExportDownloadName("deploy", "term-1", time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC))
	if got != "terminal-deploy-20261005.txt" {
		t.Fatalf("unexpected name: %q", got)
	}
}

func TestExportDownloadNameCJKKept(t *testing.T) {
	got := ExportDownloadName("构建输出", "term-1", time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC))
	if got != "terminal-构建输出-20261005.txt" {
		t.Fatalf("CJK name should survive (RFC 5987 side): %q", got)
	}
}

func TestExportDownloadNameUnsafeFolded(t *testing.T) {
	// 控制字符（CRLF）/路径分隔符/Windows 非法字符折叠为 '-'，连续并缩
	got := ExportDownloadName("a/b\\c:d*e?f\"g<h>i|j\r\nk", "term-1", time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC))
	want := "terminal-a-b-c-d-e-f-g-h-i-j-k-20261005.txt"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestExportDownloadNameTrimAndClip(t *testing.T) {
	// 首尾折叠符修整（Windows 段规则）+ rune 截断不割裂多字节字符
	got := ExportDownloadName("///部署///"+strings.Repeat("长", 50), "term-1", time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC))
	if !strings.HasPrefix(got, "terminal-部署") || !strings.HasSuffix(got, ".txt") {
		t.Fatalf("trim failed: %q", got)
	}
	body := strings.TrimSuffix(strings.TrimPrefix(got, "terminal-"), "-20261005.txt")
	if n := len([]rune(body)); n > exportTitleMaxRunes {
		t.Fatalf("slug too long: %d runes in %q", n, got)
	}
}

func TestExportDownloadNameEmptyFallbackID(t *testing.T) {
	got := ExportDownloadName("   \t", "term-abc-123", time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC))
	if got != "terminal-term-abc-123-20261005.txt" {
		t.Fatalf("fallback to sanitized id failed: %q", got)
	}
}

// —— ExportText（scrollback 读取链 + StripANSI，留档为可读纯文本）——

func TestExportTextStripsANSIKeepsLines(t *testing.T) {
	s := newSearchTestSession("s1", "构建", "p1", "\x1b]133;E;go build\x07building...\x1b[31mFAIL: x\x1b[0m\ndone\n")
	out, err := s.ExportText()
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	text := string(out)
	if strings.ContainsRune(text, 0x1b) {
		t.Fatalf("escape bytes must not survive export: %q", text)
	}
	if !strings.Contains(text, "FAIL: x") || !strings.Contains(text, "done") {
		t.Fatalf("known output lines lost: %q", text)
	}
	if strings.Contains(text, "133;E") {
		t.Fatalf("OSC 133 marker not stripped: %q", text)
	}
}

func TestExportTextEmptyBufferNil(t *testing.T) {
	s := newSearchTestSession("s1", "t", "p", "")
	out, err := s.ExportText()
	if err != nil || out != nil {
		t.Fatalf("empty buffer should export empty, got %v, %v", out, err)
	}
}

func TestExportTextBoundedByHistoryLimit(t *testing.T) {
	// 护栏沿 history 上限：环形缓冲容量钳制导出体上界——写入远超容量的输出，
	// 导出体必须收敛于缓冲容量（保尾语义：最近输出保留，最旧截断）
	s := newSearchTestSession("s1", "t", "p", "")
	// 最旧标记在缓冲头部，单次写入远超容量 → 环形按字节保尾覆盖头部
	big := "OLDEST-MARKER\n" + strings.Repeat("x", 128*1024)
	s.scrollback.Write([]byte(big))
	for i := 0; i < 8; i++ {
		s.scrollback.Write([]byte("NEWMARKER-"+string(rune('a'+i))+"\n"))
	}
	out, err := s.ExportText()
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if len(out) > 64*1024 {
		t.Fatalf("export must be bounded by buffer capacity (%d), got %d bytes", 64*1024, len(out))
	}
	if strings.Contains(string(out), "OLDEST-MARKER") {
		t.Fatalf("evicted head should not survive: tail-preserving guardrail broken")
	}
	if !strings.Contains(string(out), "NEWMARKER-h") {
		t.Fatalf("most recent output must survive: %q", string(out)[:min(200, len(out))])
	}
}
