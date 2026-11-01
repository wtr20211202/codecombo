package claudesessions

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/store"
)

// expectUsage 断言会话聚合值（usage.go 口径 = input+output+cache_read，
// cache_creation 不计入）
func expectUsage(t *testing.T, got *Usage, in, out, cr int64) {
	t.Helper()
	if got == nil {
		t.Fatalf("Usage = nil, want {in=%d out=%d cr=%d}", in, out, cr)
	}
	if got.InputTokens != in || got.OutputTokens != out || got.CacheReadTokens != cr {
		t.Fatalf("Usage = {in=%d out=%d cr=%d}, want {in=%d out=%d cr=%d}",
			got.InputTokens, got.OutputTokens, got.CacheReadTokens, in, out, cr)
	}
	if got.TotalTokens != in+out+cr {
		t.Fatalf("TotalTokens = %d, want %d", got.TotalTokens, in+out+cr)
	}
}

func rfc(ts time.Time) string { return ts.UTC().Format(time.RFC3339) }

// fixtureHead 首行 last-prompt 元信息（fixtureJSONL 的首行形态；usage 用例
// 自行拼装行序，不取其标题/计数）
func fixtureHead() string { return `{"type":"last-prompt","sessionId":"x"}` }

// TestScanAggregatesUsage 全文扫描逐条累计：多条 assistant usage 相加
// （提案原文口径 input+output+cache_read），搜索路径（全量扫描）同样携带
func TestScanAggregatesUsage(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc(now.Add(-50*time.Minute)), "用量会话"),
		// input 1000 + cache_creation 500（不计）+ cache_read 100 + output 200 = 1300
		assistantUsageLine(rfc(now.Add(-50*time.Minute)), assistantUsage{InputTokens: 1000, CacheCreationTokens: 500, CacheReadTokens: 100, OutputTokens: 200}),
		// input 400 + cache_read 50 + output 100 = 550
		assistantUsageLine(rfc(now.Add(-40*time.Minute)), assistantUsage{InputTokens: 400, CacheReadTokens: 50, OutputTokens: 100}),
	})
	write(t, root, EncodePath(`D:\e2e-demo`), "usage-sum", content, now.Add(-time.Hour))

	res, err := List(root, `D:\e2e-demo`, "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 {
		t.Fatalf("Total = %d, want 1", res.Total)
	}
	expectUsage(t, res.Sessions[0].Usage, 1400, 300, 150)

	res, err = List(root, `D:\e2e-demo`, "用量会话", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("search list: total=%d err=%v", res.Total, err)
	}
	expectUsage(t, res.Sessions[0].Usage, 1400, 300, 150)
}

// TestScanUsageTolerance 坏数据宽容：坏 JSON 行、usage 字段类型错、全零
// usage、sidechain、非 assistant 行内嵌 usage 一律不计；全不可计 = 无数据
// （Usage nil，「无数据」≠「零消耗」）
func TestScanUsageTolerance(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc(now.Add(-time.Hour)), "坏数据会话"),
		"not-a-json-line", // 裸文本行
		`{"type":"assistant","message":{"usage":{"input_tokens":"x"}}}`,                                            // usage 类型坏
		`{"type":"assistant","message":{"usage":{"input_tokens":0,"output_tokens":0}}}`,                            // 全零 usage
		sidechainUsageLine(rfc(now.Add(-30*time.Minute)), assistantUsage{InputTokens: 99999, OutputTokens: 99999}), // 子代理
		// 非 assistant 行内嵌 message.usage（合成条目形态）：类型预滤排除
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"hi","usage":{"input_tokens":777}},"timestamp":"` + rfc(now) + `"}`,
		assistantUsageLine(rfc(now.Add(-20*time.Minute)), assistantUsage{InputTokens: 300, OutputTokens: 60}), // 有效行 360
	})
	write(t, root, EncodePath(`D:\e2e-demo`), "usage-bad", content, now.Add(-time.Hour))

	res, err := List(root, `D:\e2e-demo`, "坏数据会话", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("list: total=%d err=%v", res.Total, err)
	}
	expectUsage(t, res.Sessions[0].Usage, 300, 60, 0)

	// 全部行不可计：Usage 保持 nil，列表照常返回
	write(t, root, EncodePath(`D:\e2e-demo`), "usage-none",
		joinLines([]string{fixtureHead(), userLine(rfc(now.Add(-2*time.Hour)), "无用量会话"), "garbage"}),
		now.Add(-2*time.Hour))
	res, err = List(root, `D:\e2e-demo`, "无用量会话", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("list none: total=%d err=%v", res.Total, err)
	}
	if res.Sessions[0].Usage != nil {
		t.Fatalf("Usage = %+v, want nil（无数据 ≠ 零消耗）", res.Sessions[0].Usage)
	}
}

// TestUsageWindow 窗口归账：只累计时间戳落在 [start, end) 的主线 usage 行；
// 跨天 resume 的会话昨日用量不串账，无时间戳行跳过
func TestUsageWindow(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, now.Location())
	yesterday := today.AddDate(0, 0, -1)
	start, end := today, today.AddDate(0, 0, 1)

	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc(yesterday), "窗口会话"),
		assistantUsageLine(rfc(yesterday.Add(time.Hour)), assistantUsage{InputTokens: 1000, OutputTokens: 100}),    // 昨日：不计
		assistantUsageLine(rfc(today), assistantUsage{InputTokens: 2000, CacheReadTokens: 200, OutputTokens: 400}), // 今日：2600
		sidechainUsageLine(rfc(today.Add(time.Minute)), assistantUsage{InputTokens: 5000, OutputTokens: 500}),      // 子代理：不计
		`{"type":"assistant","message":{"usage":{"input_tokens":888}}}`,                                            // 无时间戳：跳过
		assistantUsageLine(rfc(today.Add(2*time.Hour)), assistantUsage{InputTokens: 300, OutputTokens: 60}),        // 今日：360
	})
	write(t, root, EncodePath(`D:\e2e-demo`), "usage-win", content, now.Add(-time.Hour))

	got, ok, err := UsageWindow(root, EncodePath(`D:\e2e-demo`), "usage-win", start, end)
	if err != nil || !ok {
		t.Fatalf("UsageWindow: ok=%v err=%v", ok, err)
	}
	expectUsage(t, &got, 2300, 460, 200)

	// 窗口收窄到昨日：只剩昨日那条
	got, ok, err = UsageWindow(root, EncodePath(`D:\e2e-demo`), "usage-win", yesterday.AddDate(0, 0, -1), today)
	if err != nil || !ok {
		t.Fatalf("UsageWindow yesterday: ok=%v err=%v", ok, err)
	}
	expectUsage(t, &got, 1000, 100, 0)

	// 窗内无数据：ok=false（≠ 零消耗）；文件缺失返回 err；穿越 id 拒绝
	if _, ok, err = UsageWindow(root, EncodePath(`D:\e2e-demo`), "usage-win", now.AddDate(0, 0, -30), now.AddDate(0, 0, -29)); err != nil || ok {
		t.Fatalf("empty window: ok=%v err=%v", ok, err)
	}
	if _, _, err = UsageWindow(root, EncodePath(`D:\e2e-demo`), "missing-id", start, end); err == nil {
		t.Fatal("missing file should return err")
	}
	if _, ok, _ = UsageWindow(root, EncodePath(`D:\e2e-demo`), `..\evil`, start, end); ok {
		t.Fatal("traversal id should be rejected")
	}
}

// TestIndexCarriesUsage 索引透传：首次列表建条目带聚合，二次列表（索引命中，
// 零内容读）聚合原样返回；文件变更重扫后聚合随之更新
func TestIndexCarriesUsage(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	dir := EncodePath(`D:\e2e-demo`)
	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc(now.Add(-time.Hour)), "索引用量"),
		assistantUsageLine(rfc(now.Add(-30*time.Minute)), assistantUsage{InputTokens: 1000, CacheReadTokens: 100, OutputTokens: 200}),
	})
	write(t, root, dir, "usage-idx", content, now.Add(-time.Hour))

	ix := newIndexForTest(t, root)
	res, err := ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("first list: total=%d err=%v", res.Total, err)
	}
	expectUsage(t, res.Sessions[0].Usage, 1000, 200, 100)
	if n := countIndex(t, ix); n != 1 {
		t.Fatalf("index entries = %d, want 1", n)
	}

	// 二次列表走索引命中：聚合从条目透传
	res, err = ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("second list: total=%d err=%v", res.Total, err)
	}
	expectUsage(t, res.Sessions[0].Usage, 1000, 200, 100)

	// 追加一条 usage 后 mtime 变化：重扫，聚合更新
	f := filepath.Join(root, dir, "usage-idx.jsonl")
	fh, err := os.OpenFile(f, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fh.WriteString(assistantUsageLine(rfc(now.Add(-10*time.Minute)), assistantUsage{InputTokens: 500, OutputTokens: 100}) + "\n"); err != nil {
		t.Fatal(err)
	}
	fh.Close()
	future := now.Add(-time.Minute)
	if err := os.Chtimes(f, future, future); err != nil {
		t.Fatal(err)
	}
	res, err = ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("rescan list: total=%d err=%v", res.Total, err)
	}
	expectUsage(t, res.Sessions[0].Usage, 1500, 300, 100)
}

// TestIndexLegacyEntryRescans 升级一致性（任务书「缓存失效一致性」）：历史上
// 写入的旧条目无 UsageKnown 标记——stat 命中也不得复用，重扫补齐聚合
func TestIndexLegacyEntryRescans(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	dir := EncodePath(`D:\e2e-demo`)
	content := joinLines([]string{
		fixtureHead(),
		userLine(rfc(now.Add(-time.Hour)), "旧条目会话"),
		assistantUsageLine(rfc(now.Add(-30*time.Minute)), assistantUsage{InputTokens: 700, OutputTokens: 100}),
	})
	write(t, root, dir, "usage-legacy", content, now.Add(-time.Hour))

	ix := newIndexForTest(t, root)
	if _, err := ix.List("", 10, 0); err != nil {
		t.Fatal(err)
	}
	// 把条目改写回「旧版」形态（UsageKnown=false，stat 指纹不变——隔离变量）
	key := store.ClaudeIndexKey(root, dir, "usage-legacy")
	batch, err := ix.repo.GetBatch(key)
	if err != nil || len(batch) != 1 {
		t.Fatalf("get entry: n=%d err=%v", len(batch), err)
	}
	for _, e := range batch {
		e.UsageKnown = false
		e.UsageTotal = 0
		if err := ix.repo.Put(e); err != nil {
			t.Fatal(err)
		}
	}
	res, err := ix.List("", 10, 0)
	if err != nil || res.Total != 1 {
		t.Fatalf("list after legacy: total=%d err=%v", res.Total, err)
	}
	expectUsage(t, res.Sessions[0].Usage, 700, 100, 0)
	// 重扫后条目已补标记：聚合不回退
	batch, err = ix.repo.GetBatch(key)
	if err != nil || len(batch) != 1 || !batch[key].UsageKnown || batch[key].UsageTotal != 800 {
		t.Fatalf("entry UsageKnown not restored: %+v err=%v", batch, err)
	}
}

// TestSpendThresholdHit 花费告警纯判定（P-20261003-157）：功能关恒 false、
// 无 usage 数据恒 false（「无数据」≠「零消耗」）、达到即 true（≥ 语义）
func TestSpendThresholdHit(t *testing.T) {
	// 功能关（默认 0 / 负值）：任何用量都不告警
	if SpendThresholdHit(&Usage{TotalTokens: 1 << 40}, 0) {
		t.Fatal("threshold off: want false")
	}
	if SpendThresholdHit(&Usage{TotalTokens: 999}, -5) {
		t.Fatal("negative threshold: want false")
	}
	// 无 usage 数据：不告警（不能因 transcript 缺 usage 行就告警）
	if SpendThresholdHit(nil, 1000) {
		t.Fatal("nil usage: want false")
	}
	// 达到 / 未达到
	u := &Usage{TotalTokens: 1000}
	if SpendThresholdHit(u, 1001) {
		t.Fatal("below threshold: want false")
	}
	if !SpendThresholdHit(u, 1000) {
		t.Fatal("equal threshold: want true")
	}
	if !SpendThresholdHit(u, 999) {
		t.Fatal("above threshold: want true")
	}
}
