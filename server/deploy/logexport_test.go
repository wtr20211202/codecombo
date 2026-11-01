package deploy

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
)

// TestLogEntriesSnapshot 内存日志环快照（P-20261003-142）：窗内任务返回逐条
// 拷贝（改快照不影响原缓冲）；窗外任务 ok=false——「过期」与「不存在」同形
// 返回，由 api 层结合存库记录区分
func TestLogEntriesSnapshot(t *testing.T) {
	m := NewManager(&fakeTaskStore{})
	m.mu.Lock()
	m.running["t1"] = &runningTask{
		task: &config.DeployTask{ID: "t1"},
		logBuf: []LogEntry{
			{Time: time.Now(), Step: "start", Level: LevelInfo, Message: "task started, 1 instances"},
		},
	}
	m.mu.Unlock()

	entries, ok := m.LogEntries("t1")
	if !ok {
		t.Fatal("t1 in memory, ok = false")
	}
	if len(entries) != 1 || entries[0].Message != "task started, 1 instances" {
		t.Fatalf("entries = %+v", entries)
	}
	// 快照拷贝：改动不回写原缓冲
	entries[0].Message = "mutated"
	again, _ := m.LogEntries("t1")
	if again[0].Message != "task started, 1 instances" {
		t.Fatalf("snapshot mutation leaked into logBuf: %+v", again[0])
	}

	if _, ok := m.LogEntries("t_missing"); ok {
		t.Fatal("t_missing not in memory, ok = true")
	}
}

// TestRenderLogText 留档 txt 渲染：头部任务元数据 + 逐条日志行；Message 为空
// 而 MessageKey 在场（taskLogger.LogKV 形态）以 key 原样落盘（服务端不做 i18n
// 渲染，留档保原始可对账形态）；task 为 nil（存库读异常的降级面）不 panic
func TestRenderLogText(t *testing.T) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	task := &config.DeployTask{
		ID: "sc_dt_x", Host: "192.0.2.10", Status: config.TaskStatusFailed,
		Error:     "init_user: boom",
		StartedAt: &now,
		Instances: []config.DeployerInstance{
			{DeployerID: "init_user"}, {DeployerID: "claude_code"}, {DeployerID: "init_user"},
		},
	}
	entries := []LogEntry{
		{Time: now, Step: "start", Level: LevelInfo, Message: "task started, 2 instances"},
		{Time: now, Deployer: "init_user", Step: "run", Level: LevelInfo,
			MessageKey:    "deploy.log.startingInstance",
			MessageParams: map[string]any{"index": 1, "total": 2, "deployer": "init_user"}},
		{Time: now, Step: "done", Level: LevelFail, Message: "task failed: init_user: boom"},
	}
	text := string(RenderLogText(task, entries))

	for _, want := range []string{
		"codecombo deploy log",
		"task:     sc_dt_x",
		"host:     192.0.2.10",
		"tools:    init_user+claude_code", // deployerSummary 去重拼接
		"status:   failed",
		"error:    init_user: boom",
		"[" + LevelInfo + "] start: task started, 2 instances",
		"[init_user] run: deploy.log.startingInstance", // 空 Message 回退 key 原样
		"[" + LevelFail + "] done: task failed: init_user: boom",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("rendered text missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "\r") {
		t.Error("rendered text must be LF-only (cross-platform line ending discipline)")
	}

	// nil task：只有日志行，无头部，不 panic
	nilText := string(RenderLogText(nil, entries[:1]))
	if !strings.Contains(nilText, "start: task started") || strings.Contains(nilText, "task:") {
		t.Errorf("nil task render = %q", nilText)
	}
}

// TestLogDownloadName 下载名净化：控制字符/路径分隔符折叠 '-'、连续并缩、
// rune 截断、首尾 '-. ' 修整；空摘要回退任务 id；日期段 yyyymmdd
func TestLogDownloadName(t *testing.T) {
	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name, host, taskID, want string
	}{
		{"plain ipv4", "192.0.2.10", "sc_dt_x", "deploy-192.0.2.10-20261007.txt"},
		{"control chars folded", "h\x01ost\r\nx", "sc_dt_x", "deploy-h-ost-x-20261007.txt"},
		{"path separators folded", `/etc\passwd`, "sc_dt_x", "deploy-etc-passwd-20261007.txt"},
		{"trailing dots/spaces trimmed", "host. ", "sc_dt_x", "deploy-host-20261007.txt"},
		{"empty host falls back to task id", "", "sc_dt_abc", "deploy-sc_dt_abc-20261007.txt"},
	}
	for _, c := range cases {
		if got := LogDownloadName(c.host, c.taskID, now); got != c.want {
			t.Errorf("%s: LogDownloadName(%q) = %q, want %q", c.name, c.host, got, c.want)
		}
	}
	// rune 截断：40 rune 上限（多字节不劈开）
	long := strings.Repeat("主", 50)
	got := LogDownloadName(long, "sc_dt_x", now)
	// deploy-(40 runes)-20261007.txt
	if !strings.HasPrefix(got, "deploy-"+strings.Repeat("主", 40)+"-20261007.txt") {
		t.Errorf("rune clip failed: %q", got)
	}
}
