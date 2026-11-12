package claudesessions

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TranscriptHead（P-20261111-6 S1 自动命名数据面）：头部有界读——首个时间戳与
// 首条可作标题的用户消息，与 scanFile/parseHead 全量读同一解析语义

func writeTranscript(t *testing.T, path string, lines []string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := ""
	for _, l := range lines {
		content += l + "\n"
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestTranscriptHead(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a1111111-1111-4111-8111-111111111111.jsonl")
	at := "2026-11-11T08:00:00.000Z"
	writeTranscript(t, p, []string{
		`{"type":"last-prompt","sessionId":"a1111111-1111-4111-8111-111111111111"}`,
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"修复 update 看门狗竞态\n补充：从 S7 用例复现"},"timestamp":"` + at + `","cwd":"/tmp/x"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"` + at + `"}`,
	})

	firstAt, title := TranscriptHead(p)
	if firstAt.IsZero() {
		t.Fatal("firstAt should be parsed from head window")
	}
	if want, _ := time.Parse(time.RFC3339, at); !firstAt.Equal(want) {
		t.Fatalf("firstAt = %v, want %v", firstAt, want)
	}
	// 首条可作标题的用户消息原文（多行不在此截——首行提取是命名策略侧职责）
	if title != "修复 update 看门狗竞态\n补充：从 S7 用例复现" {
		t.Fatalf("title = %q", title)
	}
}

func TestTranscriptHeadSkipsMetaAndNoise(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "b2222222-2222-4222-8222-222222222222.jsonl")
	writeTranscript(t, p, []string{
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"<local-command-caveat>这不算消息</local-command-caveat>"},"timestamp":"2026-11-11T08:00:00.000Z"}`,
		// 纯噪声（8×U+FFFD，实测形态）：不配作标题，继续向后找
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD"},"timestamp":"2026-11-11T08:00:01.000Z"}`,
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"真实首条指令"},"timestamp":"2026-11-11T08:00:02.000Z"}`,
	})
	firstAt, title := TranscriptHead(p)
	if title != "真实首条指令" {
		t.Fatalf("title = %q, want 真实首条指令（meta/噪声跳过）", title)
	}
	if firstAt.IsZero() || firstAt.Format(time.RFC3339) != "2026-11-11T08:00:00Z" {
		t.Fatalf("firstAt = %v（首个时间戳，与标题无关）", firstAt)
	}
}

func TestTranscriptHeadMissingAndEmpty(t *testing.T) {
	dir := t.TempDir()
	// 文件缺失：零值降级
	firstAt, title := TranscriptHead(filepath.Join(dir, "nope.jsonl"))
	if !firstAt.IsZero() || title != "" {
		t.Fatalf("missing file = (%v, %q), want zero values", firstAt, title)
	}
	// 空文件：零值降级
	empty := filepath.Join(dir, "c3333333-3333-4333-8333-333333333333.jsonl")
	writeTranscript(t, empty, nil)
	firstAt, title = TranscriptHead(empty)
	if !firstAt.IsZero() || title != "" {
		t.Fatalf("empty file = (%v, %q), want zero values", firstAt, title)
	}
	// 只有时间戳没有用户消息（首条消息未落盘）：firstAt 有值 title 空
	at := filepath.Join(dir, "d4444444-4444-4444-8444-444444444444.jsonl")
	writeTranscript(t, at, []string{
		`{"type":"last-prompt","timestamp":"2026-11-11T08:00:00.000Z"}`,
	})
	firstAt, title = TranscriptHead(at)
	if firstAt.IsZero() || title != "" {
		t.Fatalf("no-user-line = (%v, %q), want (firstAt, \"\")", firstAt, title)
	}
}
