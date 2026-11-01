package share

// 会话回放 cast 文本处理单测（P-20261004-103）：敏感模式扫描警示（行号级、
// 不含命中原文）与落盘前全量兜底遮蔽（含 OSC133 E 帧载荷解码）两条纪律的
// 纯函数锁。访客面行为在 castpage_test.go。

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func castLine(t *testing.T, tt float64, text string) string {
	t.Helper()
	b, err := json.Marshal([]any{tt, "o", text})
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	return string(b)
}

const castHeader = `{"version":2,"width":80,"height":24,"timestamp":1700000000}`

func TestSanitizeCastText(t *testing.T) {
	ePayload := base64.StdEncoding.EncodeToString([]byte("export TOKEN=frame-secret"))
	secretFrame := "\x1b]133;E;" + ePayload + "\x07\x1b]133;C\x07"
	input := strings.Join([]string{
		castHeader,
		castLine(t, 0.1, "export PASSWORD=hunter2\r\n"),
		castLine(t, 0.2, "token sca_deadbeef001 AKIAABCDEFGHIJKLMNOP\r\n"),
		castLine(t, 0.3, secretFrame+"ran\r\n\x1b]133;D;0\x07"),
	}, "\n")

	out := SanitizeCastText(input)
	lines := strings.Split(out, "\n")
	if lines[0] != castHeader {
		t.Fatalf("header must be preserved: %q", lines[0])
	}
	for _, secret := range []string{"hunter2", "sca_deadbeef001", "AKIAABCDEFGHIJKLMNOP", "frame-secret"} {
		if strings.Contains(out, secret) {
			t.Fatalf("sanitized cast still leaks %q: %s", secret, out)
		}
	}
	if !strings.Contains(out, "***") {
		t.Fatalf("sanitized cast lacks *** placeholders: %s", out)
	}
	// 每条事件行仍是合法 cast 事件（回放端 parseCast 可解析）
	for i := 1; i < len(lines); i++ {
		var row []any
		if err := json.Unmarshal([]byte(lines[i]), &row); err != nil {
			t.Fatalf("line %d no longer parses: %v (%q)", i+1, err, lines[i])
		}
		if len(row) != 3 || row[1] != "o" {
			t.Fatalf("line %d shape drifted: %v", i+1, row)
		}
	}
	// E 帧结构保留：base64 载荷解码后是遮蔽态（帧仍可被章节索引解析）
	last := lines[len(lines)-1]
	idx := strings.Index(last, "133;E;")
	if idx < 0 {
		t.Fatalf("E frame structure lost: %q", last)
	}
	rest := last[idx+len("133;E;"):]
	end := strings.Index(rest, `\u0007`)
	if end < 0 {
		t.Fatalf("E frame terminator lost: %q", last)
	}
	decoded, err := base64.StdEncoding.DecodeString(rest[:end])
	if err != nil {
		t.Fatalf("E frame payload is not base64: %v (%q)", err, rest[:end])
	}
	if strings.Contains(string(decoded), "frame-secret") || !strings.Contains(string(decoded), "***") {
		t.Fatalf("E frame payload not masked: %q", decoded)
	}

	// 干净输入原样返回（零改动快路径）
	clean := castHeader + "\n" + castLine(t, 0.1, "hello\r\n")
	if got := SanitizeCastText(clean); got != clean {
		t.Fatalf("clean cast must be returned unchanged: %q", got)
	}
}

func TestScanCastSensitive(t *testing.T) {
	input := strings.Join([]string{
		castHeader,
		castLine(t, 0.1, "hello\r\n"),
		castLine(t, 0.2, "export PASSWORD=hunter2\r\n"),
		castLine(t, 0.3, "sca_deadbeef001\r\n"),
	}, "\n")
	res := ScanCastSensitive(input)
	if len(res.Warnings) != 2 || res.Warnings[0] != "line 3" || res.Warnings[1] != "line 4" {
		t.Fatalf("warnings = %v, want [line 3 line 4]", res.Warnings)
	}
	if res.Truncated {
		t.Fatal("two hits must not be truncated")
	}
	// 警示清单不含命中原文（警示面本身不得成为泄露面）
	for _, w := range res.Warnings {
		if strings.Contains(w, "hunter2") || strings.Contains(w, "deadbeef") {
			t.Fatalf("warning leaks hit text: %q", w)
		}
	}

	// 干净文本零警示
	if clean := ScanCastSensitive(castHeader + "\n" + castLine(t, 0.1, "ok\r\n")); len(clean.Warnings) != 0 {
		t.Fatalf("clean warnings = %v", clean.Warnings)
	}

	// 超上限：截断标注（确有未列出命中）
	var b strings.Builder
	b.WriteString(castHeader)
	for i := 0; i < maxCastScanWarnings+5; i++ {
		b.WriteString("\n")
		b.WriteString(castLine(t, float64(i), "token=secret\r\n"))
	}
	trunc := ScanCastSensitive(b.String())
	if !trunc.Truncated || len(trunc.Warnings) != maxCastScanWarnings {
		t.Fatalf("trunc = %d warnings, truncated=%v; want %d/true",
			len(trunc.Warnings), trunc.Truncated, maxCastScanWarnings)
	}
}

func TestCastHasOutput(t *testing.T) {
	if CastHasOutput(castHeader) {
		t.Fatal("header-only cast must report no output")
	}
	if CastHasOutput("") {
		t.Fatal("empty cast must report no output")
	}
	if !CastHasOutput(castHeader + "\n" + castLine(t, 0, "x")) {
		t.Fatal("cast with an output event must report output")
	}
}
