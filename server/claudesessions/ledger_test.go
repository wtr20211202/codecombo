package claudesessions

// 结构化台账单测（P-20261005-208）：提取器聚合口径（写文件去重 / shell 计数 /
// 首尾跨时 / 宽容容错 / 零值不上账）+ scanFile 集成 + 索引透传与旧条目升级重扫
//（LedgerKnown 与 UsageKnown 同款升级标记）。

import (
	"testing"
	"time"

	"codecombo/server/store"
)

func ledgerToolLine(ts, tool, input string) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"` + tool + `","input":` + input + `}]},"timestamp":"` + ts + `"}`
}

func TestLedgerAccumulate(t *testing.T) {
	base := time.Date(2026, 10, 13, 10, 0, 0, 0, time.UTC)
	rfc := base.UTC().Format(time.RFC3339)
	rfc2 := base.Add(30 * time.Minute).UTC().Format(time.RFC3339)
	rfc3 := base.Add(42 * time.Minute).UTC().Format(time.RFC3339)
	a := newLedgerAccum()
	lines := []string{
		`not json at all`, // 坏行宽容
		userLine(rfc, "帮我改"),
		// 写类工具同文件两次：去重为 1
		ledgerToolLine(rfc, "Write", `{"file_path":"D:/p/a.go","content":"x"}`),
		ledgerToolLine(rfc2, "Edit", `{"file_path":"D:/p/a.go"}`),
		// 不同写类工具不同路径：NotebookEdit 走 notebook_path 键
		ledgerToolLine(rfc2, "NotebookEdit", `{"notebook_path":"D:/p/n.ipynb"}`),
		// 同一行多个 tool_use 块
		`{"type":"assistant","message":{"role":"assistant","content":[` +
			`{"type":"tool_use","name":"Bash","input":{"command":"go build ./..."}},` +
			`{"type":"tool_use","name":"Bash","input":{"command":"go test ./..."}}]},"timestamp":"` + rfc3 + `"}`,
		// 只读工具与未知工具：不计
		ledgerToolLine(rfc3, "Read", `{"file_path":"D:/p/a.go"}`),
		ledgerToolLine(rfc3, "MysteryTool", `{"path":"D:/p/x"}`),
		// 工具结果挂 user 行：不计
		toolResultLine(rfc3, "t1", "ok", false),
		// 时间戳缺失的 tool_use：计数不计跨时
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}`,
	}
	for _, l := range lines {
		a.accumulate([]byte(l))
	}
	led := a.result()
	if led == nil {
		t.Fatal("ledger should be non-nil")
	}
	if led.FilesWritten != 2 {
		t.Errorf("FilesWritten = %d, want 2 (a.go 去重 + n.ipynb)", led.FilesWritten)
	}
	if led.CommandsRun != 3 {
		t.Errorf("CommandsRun = %d, want 3", led.CommandsRun)
	}
	if led.DurationMs != 42*60*1000 {
		t.Errorf("DurationMs = %d, want %d", led.DurationMs, 42*60*1000)
	}
}

func TestLedgerZeroValueHidden(t *testing.T) {
	rfc := time.Date(2026, 10, 13, 10, 0, 0, 0, time.UTC).UTC().Format(time.RFC3339)
	// 纯聊天会话（无任何 tool_use）：nil
	chat := newLedgerAccum()
	chat.accumulate([]byte(userLine(rfc, "聊聊")))
	chat.accumulate([]byte(assistantTextLine(rfc, "好的")))
	if led := chat.result(); led != nil {
		t.Fatalf("pure chat should be nil, got %+v", led)
	}
	// 纯只读工具会话（聚合为零）：nil（DiagSnapshot 零值隐藏同款纪律）
	ro := newLedgerAccum()
	ro.accumulate([]byte(ledgerToolLine(rfc, "Read", `{"file_path":"D:/p/a.go"}`)))
	ro.accumulate([]byte(ledgerToolLine(rfc, "Grep", `{"pattern":"x"}`)))
	if led := ro.result(); led != nil {
		t.Fatalf("read-only session should be nil, got %+v", led)
	}
	// 只跑命令不写文件：commands 段独存
	sh := newLedgerAccum()
	sh.accumulate([]byte(ledgerToolLine(rfc, "Bash", `{"command":"ls"}`)))
	if led := sh.result(); led == nil || led.CommandsRun != 1 || led.FilesWritten != 0 || led.DurationMs != 0 {
		t.Fatalf("shell-only session = %+v", led)
	}
}

func TestLedgerMaxFilesCap(t *testing.T) {
	a := newLedgerAccum()
	rfc := time.Date(2026, 10, 13, 10, 0, 0, 0, time.UTC).UTC().Format(time.RFC3339)
	for i := 0; i < ledgerMaxFiles+50; i++ {
		a.accumulate([]byte(ledgerToolLine(rfc, "Write", `{"file_path":"D:/p/f`+itoa(i)+`.go"}`)))
	}
	if got := len(a.files); got != ledgerMaxFiles {
		t.Fatalf("dedup set = %d, want cap %d", got, ledgerMaxFiles)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// TestScanFileLedger 扫描集成：Session.Ledger 随 scanFile 产出
func TestScanFileLedger(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	rfc1 := now.Add(-time.Hour).UTC().Format(time.RFC3339)
	rfc2 := now.Add(-30 * time.Minute).UTC().Format(time.RFC3339)
	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc1, "扫描台账"),
		ledgerToolLine(rfc1, "Write", `{"file_path":"D:/p/a.go"}`),
		ledgerToolLine(rfc2, "Bash", `{"command":"go vet ./..."}`),
	})
	write(t, root, EncodePath(`D:\p`), "scan-ledger", content, now.Add(-time.Hour))

	res, err := List(root, "", "", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("list: total=%d err=%v", res.Total, err)
	}
	led := res.Sessions[0].Ledger
	if led == nil || led.FilesWritten != 1 || led.CommandsRun != 1 {
		t.Fatalf("scan ledger = %+v", led)
	}

	// 无工具会话：Ledger 缺省（零值隐藏）
	write(t, root, EncodePath(`D:\p`), "scan-plain", fixtureJSONL("无工具", now.Add(-2*time.Hour)), now.Add(-2*time.Hour))
	res, err = List(root, "", "", 10, 0)
	if err != nil || res.Total != 2 {
		t.Fatalf("list2: total=%d err=%v", res.Total, err)
	}
	for _, s := range res.Sessions {
		if s.ID == "scan-plain" && s.Ledger != nil {
			t.Fatalf("plain session should have nil ledger, got %+v", s.Ledger)
		}
	}
}

// TestIndexCarriesLedger 索引透传：首次列表建条目带台账，二次列表（索引命中，
// 零内容读）台账原样返回
func TestIndexCarriesLedger(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	dir := EncodePath(`D:\e2e-demo`)
	rfc1 := now.Add(-time.Hour).UTC().Format(time.RFC3339)
	rfc2 := now.Add(-30 * time.Minute).UTC().Format(time.RFC3339)
	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc1, "索引台账"),
		ledgerToolLine(rfc1, "Write", `{"file_path":"D:/p/a.go"}`),
		ledgerToolLine(rfc2, "Bash", `{"command":"go build"}`),
	})
	write(t, root, dir, "ledger-idx", content, now.Add(-time.Hour))

	ix := newIndexForTest(t, root)
	res, err := ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("first list: total=%d err=%v", res.Total, err)
	}
	if led := res.Sessions[0].Ledger; led == nil || led.FilesWritten != 1 || led.CommandsRun != 1 {
		t.Fatalf("first list ledger = %+v", led)
	}

	// 二次列表走索引命中：台账从条目透传
	res, err = ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("second list: total=%d err=%v", res.Total, err)
	}
	if led := res.Sessions[0].Ledger; led == nil || led.FilesWritten != 1 || led.CommandsRun != 1 {
		t.Fatalf("second list ledger = %+v", led)
	}
	// LookupLedger 同源可查（接力前言取数面）
	if led := ix.LookupLedger("ledger-idx"); led == nil || led.CommandsRun != 1 {
		t.Fatalf("LookupLedger = %+v", led)
	}
	if led := ix.LookupLedger("no-such"); led != nil {
		t.Fatalf("missing id should be nil, got %+v", led)
	}
}

// TestIndexLegacyLedgerRescans 升级一致性：历史上写入的旧条目无 LedgerKnown
// 标记——stat 命中也不得复用，重扫补齐台账（幂等，无迁移脚本）
func TestIndexLegacyLedgerRescans(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	dir := EncodePath(`D:\e2e-demo`)
	rfc := now.Add(-time.Hour).UTC().Format(time.RFC3339)
	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc, "旧条目台账"),
		ledgerToolLine(rfc, "Write", `{"file_path":"D:/p/legacy.go"}`),
	})
	write(t, root, dir, "ledger-legacy", content, now.Add(-time.Hour))

	ix := newIndexForTest(t, root)
	if _, err := ix.List("", 10, 0); err != nil {
		t.Fatal(err)
	}
	// 把条目改写回「旧版」形态（LedgerKnown=false，stat 指纹不变——隔离变量）
	key := store.ClaudeIndexKey(root, dir, "ledger-legacy")
	batch, err := ix.repo.GetBatch(key)
	if err != nil || len(batch) != 1 {
		t.Fatalf("get entry: n=%d err=%v", len(batch), err)
	}
	for _, e := range batch {
		e.LedgerKnown = false
		e.LedgerFiles = 0
		if err := ix.repo.Put(e); err != nil {
			t.Fatal(err)
		}
	}
	res, err := ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("list after legacy: total=%d err=%v", res.Total, err)
	}
	if led := res.Sessions[0].Ledger; led == nil || led.FilesWritten != 1 {
		t.Fatalf("ledger not restored: %+v", led)
	}
	batch, err = ix.repo.GetBatch(key)
	if err != nil || len(batch) != 1 || !batch[key].LedgerKnown || batch[key].LedgerFiles != 1 {
		t.Fatalf("entry LedgerKnown not restored: %+v err=%v", batch, err)
	}
}
