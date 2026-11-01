package claudesessions

import (
	"errors"
	"strconv"
	"testing"
	"time"
)

// assistantUsageLine 带 usage 元数据的 assistant 行（字段形态与真实存储一致：
// usage 挂在 message 下，input/cache_* 为 input 侧、output 独立）
func assistantUsageLine(ts string, u assistantUsage) string {
	return `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":` + strconv.Itoa(u.InputTokens) +
		`,"cache_creation_input_tokens":` + strconv.Itoa(u.CacheCreationTokens) +
		`,"cache_read_input_tokens":` + strconv.Itoa(u.CacheReadTokens) +
		`,"output_tokens":` + strconv.Itoa(u.OutputTokens) + `}},"timestamp":"` + ts + `"}`
}

func sidechainUsageLine(ts string, u assistantUsage) string {
	return `{"parentUuid":null,"isSidechain":true,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"sub"}],"usage":{"input_tokens":` + strconv.Itoa(u.InputTokens) +
		`,"output_tokens":` + strconv.Itoa(u.OutputTokens) + `}},"timestamp":"` + ts + `"}`
}

// TestContextPressure_NewestUsageWins 取最新一条带 usage 的 assistant 条目
// （非求和——每轮 usage 已含全部历史，求和会重复累计数十倍）
func TestContextPressure_NewestUsageWins(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	old := now.Add(-3 * time.Minute).UTC().Format(time.RFC3339)
	newTS := now.Add(-time.Minute).UTC().Format(time.RFC3339)
	content := joinLines([]string{
		userLine(old, "跑测试"),
		assistantUsageLine(old, assistantUsage{InputTokens: 50000, OutputTokens: 10000}), // 旧快照 60k
		userLine(newTS, "继续"),
		assistantUsageLine(newTS, assistantUsage{InputTokens: 185000, CacheCreationTokens: 6000, CacheReadTokens: 2000, OutputTokens: 2000}), // 新快照 195k
	})
	write(t, root, EncodePath(`D:\p`), "sess-press", content, now)

	p, ok, err := ContextPressure(root, "sess-press")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if p.EstimatedTokens != 195000 {
		t.Errorf("EstimatedTokens = %d, want 195000 (newest entry)", p.EstimatedTokens)
	}
	if p.Percent != 97.5 {
		t.Errorf("Percent = %v, want 97.5", p.Percent)
	}
	if p.WindowTokens != ContextWindowTokens || !p.Estimated {
		t.Errorf("window/estimated = %d/%v", p.WindowTokens, p.Estimated)
	}
	if p.SampledAt != newTS {
		t.Errorf("SampledAt = %q, want %q", p.SampledAt, newTS)
	}
}

// TestContextPressure_SkipsSidechainAndEmptyUsage 子代理（独立上下文）与无有效
// 计数的 assistant 行都跳过，落到更早的主线 usage
func TestContextPressure_SkipsSidechainAndEmptyUsage(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	old := now.Add(-3 * time.Minute).UTC().Format(time.RFC3339)
	mid := now.Add(-2 * time.Minute).UTC().Format(time.RFC3339)
	newTS := now.Add(-time.Minute).UTC().Format(time.RFC3339)
	content := joinLines([]string{
		userLine(old, "主线指令"),
		assistantUsageLine(old, assistantUsage{InputTokens: 60000, OutputTokens: 2000}), // 唯一主线快照
		// 子代理行：上下文独立，不计入主线压力
		sidechainUsageLine(mid, assistantUsage{InputTokens: 190000, OutputTokens: 5000}),
		// 无 usage 键的 assistant 行（合成条目形态）：跳过
		assistantTextLine(newTS, "没有 usage 的回复"),
	})
	write(t, root, EncodePath(`D:\p`), "sess-skip", content, now)

	p, ok, err := ContextPressure(root, "sess-skip")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if p.EstimatedTokens != 62000 {
		t.Errorf("EstimatedTokens = %d, want 62000 (main-line snapshot, sidechain skipped)", p.EstimatedTokens)
	}
	if p.SampledAt != old {
		t.Errorf("SampledAt = %q, want %q", p.SampledAt, old)
	}
}

// TestContextPressure_NoUsageNoPressure 窗口内无任何可用 usage：ok=false
// （「无数据」≠「零压力」）
func TestContextPressure_NoUsageNoPressure(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines([]string{
		userLine(now.UTC().Format(time.RFC3339), "只有用户消息"),
		assistantTextLine(now.UTC().Format(time.RFC3339), "回复无 usage"),
	})
	write(t, root, EncodePath(`D:\p`), "sess-nousage", content, now)

	if _, ok, err := ContextPressure(root, "sess-nousage"); err != nil || ok {
		t.Fatalf("ok=%v err=%v, want ok=false", ok, err)
	}
}

// TestContextPressure_WindowCap 尾部窗口（50 行）之外的 usage 不可达：
// 唯一 usage 行被 55 条后续用户消息推出窗口 → ok=false
func TestContextPressure_WindowCap(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	lines := []string{
		assistantUsageLine(now.Add(-time.Hour).UTC().Format(time.RFC3339), assistantUsage{InputTokens: 90000}),
	}
	for i := 0; i < 55; i++ {
		ts := now.Add(-time.Duration(56-i) * time.Minute).UTC().Format(time.RFC3339)
		lines = append(lines, userLine(ts, "灌满窗口的消息"))
	}
	write(t, root, EncodePath(`D:\p`), "sess-cap", joinLines(lines), now)

	if _, ok, err := ContextPressure(root, "sess-cap"); err != nil || ok {
		t.Fatalf("ok=%v err=%v, want ok=false (usage outside 50-line window)", ok, err)
	}
}

// TestContextPressure_OverflowNotCapped 超窗（>200k）如实上报 >100%，
// 红档提示交给前端
func TestContextPressure_OverflowNotCapped(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines([]string{
		assistantUsageLine(now.UTC().Format(time.RFC3339), assistantUsage{InputTokens: 250000, OutputTokens: 1000}),
	})
	write(t, root, EncodePath(`D:\p`), "sess-over", content, now)

	p, ok, err := ContextPressure(root, "sess-over")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if p.Percent != 125.5 {
		t.Errorf("Percent = %v, want 125.5 (uncapped)", p.Percent)
	}
}

// TestContextPressure_NotFound 不存在/越权 id：ErrSessionNotFound（与时间线同语义）
func TestContextPressure_NotFound(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{"missing", "a.b", `..\evil`, `a/b`} {
		if _, _, err := ContextPressure(root, id); !errors.Is(err, ErrSessionNotFound) {
			t.Errorf("id %q: err = %v, want ErrSessionNotFound", id, err)
		}
	}
}
