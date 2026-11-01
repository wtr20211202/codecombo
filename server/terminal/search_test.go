package terminal

import (
	"encoding/json"
	"strings"
	"testing"
)

// —— OutputHit 对外契约（json tag 即响应键拼写，前端/手册按此消费）——

func TestOutputHitJSONShape(t *testing.T) {
	b, err := json.Marshal(OutputHit{SessionID: "s1", SessionName: "构建", ProjectID: "p1", LineText: "line", HitIndex: 3})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"sessionId":"s1","sessionName":"构建","projectId":"p1","lineText":"line","hitIndex":3}`
	if string(b) != want {
		t.Fatalf("json shape drifted:\n got %s\nwant %s", b, want)
	}
}

// —— StripANSI（跨会话输出检索与滑窗匹配共用实现，语义改动双向生效）——

func TestStripANSIPlainPassthrough(t *testing.T) {
	plain := []byte("hello world\nsecond line")
	if got := string(StripANSI(plain)); got != string(plain) {
		t.Fatalf("plain text should pass through unchanged, got %q", got)
	}
}

func TestStripANSICSIColors(t *testing.T) {
	got := string(StripANSI([]byte("\x1b[31mERROR\x1b[0m: build failed\x1b[0m")))
	if got != "ERROR: build failed" {
		t.Fatalf("CSI not fully stripped: %q", got)
	}
}

func TestStripANSIOSC133Markers(t *testing.T) {
	// shell integration 133 E 帧内嵌命令文本：不剥会把标记串混进命中行
	got := string(StripANSI([]byte("\x1b]133;E;echo secret-cmd;0\x07echo secret-cmd done\n")))
	if !strings.Contains(got, "echo secret-cmd done") {
		t.Fatalf("payload text lost: %q", got)
	}
	if strings.Contains(got, "133;E") {
		t.Fatalf("OSC 133 marker not stripped: %q", got)
	}
}

func TestStripANSIOSCHyperlinkST(t *testing.T) {
	// 超链接形态 \x1b]8;;url\x1b\\text\x1b]8;;\x1b\\（ST 终止，非 BEL）
	got := string(StripANSI([]byte("\x1b]8;;http://x\x1b\\click\x1b]8;;\x1b\\here")))
	if got != "clickhere" {
		t.Fatalf("OSC ST form not stripped: %q", got)
	}
}

// —— SearchSessionsOutput（检索/大小写/ANSI 剥离/上限护栏）——

// newSearchTestSession 构造带 scrollback 缓冲的裸 Session（不起真实 PTY）
func newSearchTestSession(id, name, projectID, output string) *Session {
	s := &Session{
		ID:         id,
		Name:       name,
		ProjectID:  projectID,
		Backend:    string(BackendNative),
		scrollback: NewScrollbackWithCapacity(64 * 1024),
	}
	s.scrollback.Write([]byte(output))
	return s
}

func TestSearchSessionsOutputCaseInsensitiveAndANSI(t *testing.T) {
	sessions := []*Session{
		newSearchTestSession("s1", "构建", "p1", "compiling...\x1b[31mE2EMARKER error\x1b[0m\ndone\n"),
		newSearchTestSession("s2", "其他", "p1", "nothing here\n"),
	}
	hits := SearchSessionsOutput(sessions, "e2emarker", SearchPerSession, SearchTotal)
	if len(hits) != 1 {
		t.Fatalf("want 1 hit, got %d: %+v", len(hits), hits)
	}
	h := hits[0]
	if h.SessionID != "s1" || h.SessionName != "构建" || h.ProjectID != "p1" {
		t.Fatalf("hit attribution wrong: %+v", h)
	}
	// 行文本已剥 ANSI 且大小写不区分命中（CSI 剥除后与行首前缀粘连）
	if h.LineText != "compiling...E2EMARKER error" {
		t.Fatalf("line text should be stripped plain text, got %q", h.LineText)
	}
	if h.HitIndex != 0 {
		t.Fatalf("hit index should be line 0 of window, got %d", h.HitIndex)
	}
}

func TestSearchSessionsOutputCRLFTrim(t *testing.T) {
	sessions := []*Session{newSearchTestSession("s1", "t", "p", "CRLFMARK line\r\nnext\r\n")}
	hits := SearchSessionsOutput(sessions, "crlfmark", SearchPerSession, SearchTotal)
	if len(hits) != 1 || hits[0].LineText != "CRLFMARK line" {
		t.Fatalf("CRLF not trimmed: %+v", hits)
	}
}

func TestSearchSessionsOutputPerSessionCap(t *testing.T) {
	// 同会话 5 行命中，单会话上限 3（注入小上限验证截断）
	var sb strings.Builder
	for i := 0; i < 5; i++ {
		sb.WriteString("capmark line\n")
	}
	sessions := []*Session{newSearchTestSession("s1", "t", "p", sb.String())}
	hits := SearchSessionsOutput(sessions, "capmark", 3, SearchTotal)
	if len(hits) != 3 {
		t.Fatalf("per-session cap not applied, want 3 got %d", len(hits))
	}
	// 命中序 = 行序（头部命中优先保留）
	if hits[0].HitIndex != 0 || hits[2].HitIndex != 2 {
		t.Fatalf("hits should keep line order: %+v", hits)
	}
}

func TestSearchSessionsOutputTotalCap(t *testing.T) {
	// 两会话各 2 行命中，总量上限 3：创建序先到先得
	var sb strings.Builder
	for i := 0; i < 2; i++ {
		sb.WriteString("totalmark line\n")
	}
	sessions := []*Session{
		newSearchTestSession("s1", "first", "p1", sb.String()),
		newSearchTestSession("s2", "second", "p1", sb.String()),
	}
	hits := SearchSessionsOutput(sessions, "totalmark", SearchPerSession, 3)
	if len(hits) != 3 {
		t.Fatalf("total cap not applied, want 3 got %d", len(hits))
	}
	if hits[0].SessionID != "s1" || hits[2].SessionID != "s2" {
		t.Fatalf("session order should follow input (creation order): %+v", hits)
	}
}

func TestSearchSessionsOutputEmptyAndMiss(t *testing.T) {
	// 空缓冲/无命中：返回空切片语义由调用方兜底，这里验证不 panic 且为空
	sessions := []*Session{
		newSearchTestSession("s1", "empty", "p", ""),
		newSearchTestSession("s2", "miss", "p", "unrelated\n"),
	}
	if hits := SearchSessionsOutput(sessions, "nomatch", SearchPerSession, SearchTotal); len(hits) != 0 {
		t.Fatalf("no-match should return empty, got %+v", hits)
	}
}

func TestSearchLineTruncationWindow(t *testing.T) {
	// 超长行：命中词保持可见 + 两侧省略号 + 截窗 rune 计 ≤ 上限
	prefix := strings.Repeat("前", 500)
	suffix := strings.Repeat("后", 500)
	line := prefix + "NEEDLEWORD" + suffix
	got := truncateLineAround(strings.ToLower(line), "needleword", line)
	if !strings.Contains(got, "NEEDLEWORD") {
		t.Fatalf("needle must stay visible in truncated window: %q", got)
	}
	if !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "…") {
		t.Fatalf("cut sides should carry ellipsis: %q", got)
	}
	if n := len([]rune(got)); n > SearchLineMax+2 {
		t.Fatalf("window too long: %d runes", n)
	}
	// 短行原样返回（无省略号）
	if got := truncateLineAround(strings.ToLower("short NEEDLEWORD line"), "needleword", "short NEEDLEWORD line"); got != "short NEEDLEWORD line" {
		t.Fatalf("short line should be untouched: %q", got)
	}
}
