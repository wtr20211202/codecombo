package terminal

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"codecombo/server/store"
)

// 输出哨兵（P-20261004-8）单测：规则命中 / 作用域过滤 / 每规则独立防抖 / 编译
// 缓存版本失效 / 跨包滑窗聚合 / ANSI 剥除 / 命中行摘录。规则供给经
// stubSentinelRules 注入（不动全局 store），测试结束复位

// sentinelInvalidate stub 装的版本推进钩子（模拟规则 CRUD 使编译缓存失效）
var sentinelInvalidate func()

// stubSentinelRules 注入规则供给：版本号只在显式调 sentinelInvalidate 时自增
// （与存储「读不动版本、写自增」同语义），用例改规则集后必须推进版本。
// 同时复位包级编译缓存——缓存跨用例共享（生产版本单调递增不会串；测试各 stub
// 版本基线相同会误命中上一用例的旧缓存）
func stubSentinelRules(t *testing.T, rules func() []store.SentinelRule) {
	t.Helper()
	version := int64(100)
	prevVersion, prevLoad := sentinelVersionFn, sentinelLoadFn
	sentinelVersionFn = func() int64 { return version }
	sentinelLoadFn = func() []store.SentinelRule { return rules() }
	sentinelInvalidate = func() { version++ }
	resetSentinelRulesCache()
	t.Cleanup(func() {
		sentinelVersionFn, sentinelLoadFn = prevVersion, prevLoad
		sentinelInvalidate = nil
		resetSentinelRulesCache()
	})
}

// resetSentinelRulesCache 编译缓存复位（测试隔离用；生产路径无此需求）
func resetSentinelRulesCache() {
	sentinelRulesCache.mu.Lock()
	defer sentinelRulesCache.mu.Unlock()
	sentinelRulesCache.loaded = false
	sentinelRulesCache.version = 0
	sentinelRulesCache.rules = nil
}

func sentinelRule(id, name, pattern, scope, level string) store.SentinelRule {
	return store.SentinelRule{ID: id, Name: name, Pattern: pattern, Scope: scope, Level: level}
}

func collectSentinelHits(t *testing.T) *[]SentinelHit {
	t.Helper()
	hits := &[]SentinelHit{}
	prev := OnSentinelHit
	OnSentinelHit = func(sessionID string, hit SentinelHit) {
		*hits = append(*hits, hit)
	}
	t.Cleanup(func() { OnSentinelHit = prev })
	return hits
}

func TestSentinelDetect_PatternHits(t *testing.T) {
	hits := collectSentinelHits(t)
	stubSentinelRules(t, func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-1", "盯死锁", `(?i)fatal error.*deadlock`, store.SentinelScopeGlobal, store.SentinelLevelError),
		}
	})

	d := newSentinelDetector("term-1", "proj-1")
	// 着色割裂文本 + 大写：CSI 剥除后大小写不敏感命中
	d.feed([]byte("\x1b[31mFATAL ERROR\x1b[0m: \x1b[35mdeadlock detected\x1b[0m\n"))
	if len(*hits) != 1 {
		t.Fatalf("应命中 1 次，得到 %v", *hits)
	}
	hit := (*hits)[0]
	if hit.RuleID != "sn-1" || hit.Name != "盯死锁" || hit.Level != store.SentinelLevelError {
		t.Fatalf("命中字段不符: %+v", hit)
	}
	// 命中行摘录 = 匹配所在行整行（去 ANSI、去首尾空白）
	if hit.Matched != "FATAL ERROR: deadlock detected" {
		t.Fatalf("Matched = %q, want %q", hit.Matched, "FATAL ERROR: deadlock detected")
	}

	// 不匹配的输出不命中
	d.feed([]byte("all tests passed\n"))
	if len(*hits) != 1 {
		t.Fatalf("不匹配输出不应命中，得到 %v", *hits)
	}
}

func TestSentinelDetect_ScopeFilter(t *testing.T) {
	hits := collectSentinelHits(t)
	stubSentinelRules(t, func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-proj", "项目规则", `BOOM`, "sc_proj_42", store.SentinelLevelWarn),
			sentinelRule("sn-global", "全局规则", `BOOM`, store.SentinelScopeGlobal, store.SentinelLevelInfo),
		}
	})

	// 同项目会话：两条规则各自命中（互不干扰、各自防抖）
	d := newSentinelDetector("term-1", "sc_proj_42")
	d.feed([]byte("BOOM\n"))
	if len(*hits) != 2 {
		t.Fatalf("同项目会话应双规则命中，得到 %v", *hits)
	}
	// 他项目会话：只有 global 规则命中
	d2 := newSentinelDetector("term-2", "sc_proj_99")
	d2.feed([]byte("BOOM\n"))
	if len(*hits) != 3 {
		t.Fatalf("他项目会话只应 global 命中，得到 %v", *hits)
	}
	if (*hits)[2].RuleID != "sn-global" {
		t.Fatalf("第三个命中应为 sn-global，得到 %+v", (*hits)[2])
	}
	// agent 会话（ProjectID 空）：同样只吃 global
	d3 := newSentinelDetector("agent-1", "")
	d3.feed([]byte("BOOM\n"))
	if len(*hits) != 4 || (*hits)[3].RuleID != "sn-global" {
		t.Fatalf("agent 会话只应 global 命中，得到 %v", *hits)
	}
}

func TestSentinelDetect_Debounce(t *testing.T) {
	hits := collectSentinelHits(t)
	stubSentinelRules(t, func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-a", "规则A", `ERROR-A`, store.SentinelScopeGlobal, store.SentinelLevelWarn),
			sentinelRule("sn-b", "规则B", `ERROR-B`, store.SentinelScopeGlobal, store.SentinelLevelWarn),
		}
	})
	d := newSentinelDetector("term-1", "proj-1")
	d.debounce = 40 * time.Millisecond // 注入短窗口验证过期再报	// 同规则窗口内重复命中（错误横幅常驻滑窗、滚动重扫）→ 只报一次
	d.feed([]byte("ERROR-A happened\n"))
	d.feed([]byte("ERROR-A again\n"))
	if n := len(*hits); n != 1 {
		t.Fatalf("防抖窗内同规则应只报 1 次，得到 %d 次", n)
	}

	// 另一规则不受影响（每规则独立防抖）
	d.feed([]byte("ERROR-B happened\n"))
	if n := len(*hits); n != 2 {
		t.Fatalf("另一规则应正常上报，得到 %d 次", n)
	}

	// 灌超窗量无关输出把模式滚出滑窗（残留窗口在防抖过期后会重扫再报，
	// 属滑窗+防抖设计的既有语义；先滚窗让过期断言聚焦单一规则）
	d.feed([]byte(strings.Repeat("compiling module ...\n", sentinelWindowCap/10)))
	if n := len(*hits); n != 2 {
		t.Fatalf("滚窗不应产生命中，得到 %d 次", n)
	}

	// 防抖窗过期后同规则可再报
	time.Sleep(60 * time.Millisecond)
	d.feed([]byte("ERROR-A third\n"))
	if n := len(*hits); n != 3 {
		t.Fatalf("防抖过期后应再报，得到 %d 次", n)
	}
}

func TestSentinelDetect_CacheInvalidatedByVersion(t *testing.T) {
	hits := collectSentinelHits(t)
	rules := []store.SentinelRule{}
	stubSentinelRules(t, func() []store.SentinelRule { return rules })

	d := newSentinelDetector("term-1", "proj-1")
	d.debounce = 0 // 本用例聚焦缓存失效语义：关闭防抖避免同规则重报被拦
	// 规则集为空：零命中（功能未使用的常态路径，零正则成本）
	d.feed([]byte("OOM incoming\n"))
	if len(*hits) != 0 {
		t.Fatalf("空规则集不应命中，得到 %v", *hits)
	}

	// 追加规则 + 版本推进（模拟 CRUD）：下一 feed 起新规则生效
	rules = append(rules, sentinelRule("sn-new", "盯 OOM", `OOM`, store.SentinelScopeGlobal, store.SentinelLevelError))
	sentinelInvalidate()
	d.feed([]byte("OOM incoming\n"))
	if len(*hits) != 1 || (*hits)[0].RuleID != "sn-new" {
		t.Fatalf("版本失效后新规则应生效，得到 %v", *hits)
	}

	// 编译失败的规则被跳过，不拖垮其他规则
	rules = append(rules, sentinelRule("sn-bad", "坏正则", `([unclosed`, store.SentinelScopeGlobal, store.SentinelLevelWarn))
	sentinelInvalidate()
	d.feed([]byte("OOM again\n"))
	if len(*hits) != 2 {
		t.Fatalf("坏正则规则应被跳过且不影响好规则，得到 %v", *hits)
	}

	// 版本未动时缓存复用（规则集变化但不推进版本 = 未生效，与存储语义一致）
	rules = append(rules, sentinelRule("sn-hidden", "未生效", `HIDDEN-MARK`, store.SentinelScopeGlobal, store.SentinelLevelWarn))
	d.feed([]byte("HIDDEN-MARK\n"))
	for _, h := range *hits {
		if h.RuleID == "sn-hidden" {
			t.Fatalf("版本未推进时新规则不应生效，得到 %v", *hits)
		}
	}
}

func TestSentinelDetect_WindowAggregationAndCap(t *testing.T) {
	hits := collectSentinelHits(t)
	stubSentinelRules(t, func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-1", "跨包", `DEADLOCK`, store.SentinelScopeGlobal, store.SentinelLevelError),
		}
	})
	d := newSentinelDetector("term-1", "proj-1")

	// 模式拆在两次 feed 之间（滑窗聚合命中）
	d.feed([]byte("fatal error: all goroutines are asleep - "))
	if len(*hits) != 0 {
		t.Fatalf("模式未完整到达不应命中，得到 %v", *hits)
	}
	d.feed([]byte("DEADLOCK!\n"))
	if len(*hits) != 1 {
		t.Fatalf("跨包模式应命中，得到 %v", *hits)
	}

	// 关闭防抖纯考窗口：灌入超窗量的无关输出把模式滚出窗口 → 无残留重报
	d.debounce = 0
	d.feed([]byte(strings.Repeat("compiling module ...\n", sentinelWindowCap/10)))
	if len(*hits) != 1 {
		t.Fatalf("窗口滚掉后不应重复命中，得到 %v", *hits)
	}
	if len(d.window) > sentinelWindowCap {
		t.Fatalf("窗口应不超过 %d 字节，得到 %d", sentinelWindowCap, len(d.window))
	}
	// 滚动后再来新命中，正常上报
	d.feed([]byte("DEADLOCK again\n"))
	if len(*hits) != 2 {
		t.Fatalf("滚动后新命中应上报，得到 %v", *hits)
	}
}

func TestSentinelDetect_MultiByteSafeTrimAndLine(t *testing.T) {
	hits := collectSentinelHits(t)
	stubSentinelRules(t, func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-1", "中文", `内存不足`, store.SentinelScopeGlobal, store.SentinelLevelWarn),
		}
	})
	d := newSentinelDetector("term-1", "proj-1")
	d.debounce = 0 // 同规则两轮命中都要求入账，关闭防抖聚焦摘录与裁剪

	// 多字节超长行：摘录按 rune 边界截断，不产生非法 UTF-8
	long := strings.Repeat("构建输出日志前缀占位，", 100) + "内存不足"
	d.feed([]byte(long + "\n"))
	if len(*hits) != 1 {
		t.Fatalf("应命中，得到 %v", *hits)
	}
	matched := (*hits)[0].Matched
	if !utf8.ValidString(matched) {
		t.Fatalf("摘录应为合法 UTF-8: %q", matched)
	}
	if len(matched) > sentinelMatchedMax+utf8.UTFMax {
		t.Fatalf("摘录应截断到 ≤%d 字节附近，得到 %d", sentinelMatchedMax, len(matched))
	}
	if !strings.Contains(matched, "内存不足") {
		t.Fatalf("摘录应包含命中词: %q", matched)
	}

	// 多字节填窗触发裁剪（越过字符边界的保尾裁剪）后仍能命中后续输出
	d.feed([]byte(strings.Repeat("依赖解析完成，共 3 项", 300)))
	d.feed([]byte("内存不足 again\n"))
	if len(*hits) != 2 {
		t.Fatalf("多字节裁剪后仍应命中，得到 %v", *hits)
	}
}

func TestSentinelDetect_OSCTitleNotMatched(t *testing.T) {
	// OSC 终端标题（shell 常设 \x1b]0;cwd 或当前命令）不参与规则匹配
	//（P-20261005-8）：修复前滑窗只剥 CSI，标题原文 \x1b]0;OOM detected\x07
	// 逐字留在匹配面、规则词命中即误报；修复后 OSC 整段剥除不触发。
	// 同一规则对正文输出照常命中（规则活性不因剥离面扩大而受损）
	hits := collectSentinelHits(t)
	stubSentinelRules(t, func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-oom", "盯 OOM", `OOM detected`, store.SentinelScopeGlobal, store.SentinelLevelError),
		}
	})
	d := newSentinelDetector("term-1", "proj-1")

	// 仅标题携带关键词：不命中
	d.feed([]byte("\x1b]0;OOM detected\x07"))
	if n := len(*hits); n != 0 {
		t.Fatalf("OSC 标题不应触发规则，得到 %v", *hits)
	}

	// 正文携带同一关键词：照常命中，摘录不含标题残片
	d.feed([]byte("process killed: OOM detected\n"))
	if len(*hits) != 1 {
		t.Fatalf("正文关键词应照常命中，得到 %v", *hits)
	}
	if got := (*hits)[0].Matched; got != "process killed: OOM detected" {
		t.Fatalf("Matched = %q, want 无标题残片的正文行", got)
	}
}

func TestSentinelDetect_NormalizeLevel(t *testing.T) {
	if got := normalizeSentinelLevel(""); got != store.SentinelLevelWarn {
		t.Fatalf("空级别应回落 warning，得到 %q", got)
	}
	if got := normalizeSentinelLevel("critical"); got != store.SentinelLevelWarn {
		t.Fatalf("非法级别应回落 warning，得到 %q", got)
	}
	for _, lv := range store.SentinelLevels {
		if got := normalizeSentinelLevel(lv); got != lv {
			t.Fatalf("合法级别 %q 应原样通过，得到 %q", lv, got)
		}
	}
}

func TestSentinelDetect_HookNilSafe(t *testing.T) {
	prev := OnSentinelHit
	OnSentinelHit = nil
	t.Cleanup(func() { OnSentinelHit = prev })
	stubSentinelRules(t, func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-1", "n", `HIT-ME`, store.SentinelScopeGlobal, store.SentinelLevelWarn),
		}
	})

	d := newSentinelDetector("term-1", "proj-1")
	d.feed([]byte("HIT-ME\n")) // 不应 panic；命中状态照常记录
	d.mu.Lock()
	_, ok := d.lastHit["sn-1"]
	d.mu.Unlock()
	if !ok {
		t.Fatal("钩子为空时命中状态仍应记录（保证通知装配晚启不丢防抖）")
	}
}
