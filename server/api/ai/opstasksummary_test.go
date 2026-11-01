package ai

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/claudesessions"
)

// task.progress 终态摘要提取链单测（P-20261005-221）：挑选/窗口匹配/压平装箱
// 三段纯函数以夹具直驱——不经 DefaultManager（活会话需 PTY，由 e2e
// task-done-notify.spec 的真实会话链覆盖端到端）。

func TestPickTaskNotifyTail(t *testing.T) {
	entries := []claudesessions.TimelineEntry{
		{Kind: "user", Text: "修复登录超时"},
		{Kind: "tool", Tool: "Bash", Input: "go test ./..."},
		{Kind: "result", Status: "ok", Text: "all tests passed"},
		{Kind: "assistant", Text: "已完成：修复了登录超时并补齐回归测试"},
	}
	if got := pickTaskNotifyTail(entries, false); got != "已完成：修复了登录超时并补齐回归测试" {
		t.Fatalf("done 挑选 = %q", got)
	}
	// done 不吃 error 结果（即使更靠后）
	entries = append(entries, claudesessions.TimelineEntry{Kind: "result", Status: "error", Text: "boom"})
	if got := pickTaskNotifyTail(entries, false); got != "已完成：修复了登录超时并补齐回归测试" {
		t.Fatalf("done 不应取 error 结果 = %q", got)
	}
	// failed 优先 error 结果（第一现场），即使 assistant 文本更靠后
	if got := pickTaskNotifyTail(entries, true); got != "boom" {
		t.Fatalf("failed 挑选 = %q, want boom", got)
	}
	// failed 无 error 结果回落 assistant 文本
	if got := pickTaskNotifyTail(entries[:4], true); got != "已完成：修复了登录超时并补齐回归测试" {
		t.Fatalf("failed 回落 = %q", got)
	}
	// 窗口内两者皆无（纯工具会话）= 空串不硬凑
	tools := []claudesessions.TimelineEntry{{Kind: "tool", Tool: "Bash", Input: "ls"}}
	if got := pickTaskNotifyTail(tools, false); got != "" {
		t.Fatalf("纯工具会话 = %q, want 空", got)
	}
	if got := pickTaskNotifyTail(nil, true); got != "" {
		t.Fatalf("空时间线 = %q, want 空", got)
	}
}

func TestTaskNotifyTranscriptID(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "proj")
	if err := os.MkdirAll(filepath.Join(root, claudesessions.EncodePath(dir)), 0o755); err != nil {
		t.Fatal(err)
	}
	enc := claudesessions.EncodePath(dir)
	now := time.Now()
	write := func(name string, at time.Time) {
		p := filepath.Join(root, enc, name)
		if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	// 窗外（早于窗起点/晚于窗终点）各一，窗内两份：最新者胜
	write("old.jsonl", now.Add(-time.Hour))
	write("future.jsonl", now.Add(2*time.Hour)) // 超窗终点（时钟容差外）
	write("a.jsonl", now.Add(-10*time.Minute))
	write("b.jsonl", now.Add(-time.Minute))

	got := taskNotifyTranscriptID(root, dir, now.Add(-30*time.Minute), now.Add(time.Minute))
	if got != "b" {
		t.Fatalf("时间窗匹配 = %q, want b（窗内最新）", got)
	}
	// 目录不可得/空目录 = 空串（非 claude 会话是常态）
	if got := taskNotifyTranscriptID(root, filepath.Join(root, "nope"), now, now); got != "" {
		t.Fatalf("缺失目录 = %q, want 空", got)
	}
	if got := taskNotifyTranscriptID("", dir, now, now); got != "" {
		t.Fatalf("空 root = %q, want 空", got)
	}
}

func TestTaskNotifySingleLineAndTruncate(t *testing.T) {
	if got := taskNotifySingleLine("第一行\n\n第二行\t制表  尾 "); got != "第一行 第二行 制表 尾" {
		t.Fatalf("压平 = %q", got)
	}
	if got := truncateRunesSummary("短文本", 10); got != "短文本" {
		t.Fatalf("短文本不应截断 = %q", got)
	}
	got := truncateRunesSummary("结"+string([]rune("论"))+"abcdef", 4)
	if got != "结论ab…" {
		t.Fatalf("截断 = %q, want 结论ab…", got)
	}
}

func TestAttachTaskProgressSummaryGating(t *testing.T) {
	// 非对象载荷：不 panic、无从写字段
	attachTaskProgressSummary("plain string")
	// 非终态：不写字段
	running := map[string]interface{}{"status": "running", "terminalId": "term-x"}
	attachTaskProgressSummary(running)
	if _, present := running["summary"]; present {
		t.Fatal("running 不应附 summary")
	}
	// 已携 summary（agent 自带）：服务端不覆写
	own := map[string]interface{}{"status": "done", "terminalId": "term-x", "summary": "自报摘要"}
	attachTaskProgressSummary(own)
	if own["summary"] != "自报摘要" {
		t.Fatalf("自带 summary 被覆写 = %v", own["summary"])
	}
	// 无 terminalId：无从定位，不写字段
	plain := map[string]interface{}{"status": "done"}
	attachTaskProgressSummary(plain)
	if _, present := plain["summary"]; present {
		t.Fatal("无 terminalId 不应附 summary")
	}
}
