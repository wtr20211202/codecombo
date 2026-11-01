package terminal

import (
	"bytes"
	"strings"
	"testing"
	"unicode/utf8"

	"codecombo/server/store"
)

// 服务端试跑原语（P-20261004-107）单测：命中摘录 / RE2 专属语法权威验证 / 坏
// 正则逐规则隔离 / 样例行·字节双钳制 / 无副作用隔离（不触通知回调、不读存储
// 编译缓存）/ 分块喂入的跨块边界命中。试跑不依赖 store 与规则供给 stub——
// 内联规则自带编译，OnSentinelHit 由用例自装计数器验证零回调

func TestSentinelProbe_HitMissAndExcerpt(t *testing.T) {
	hits := collectSentinelHits(t) // 装计数器验证试跑零回调（无副作用面）
	results, truncated := TestSentinelSample(
		[]SentinelProbeRule{
			{ID: "t1", Pattern: `(?i)(out of memory|OOMKilled)`},
			{ID: "t2", Pattern: ` DeadLockGoneNoSuchToken `},
		},
		[]byte("service started normally\npanic: container OOMKilled after 3 retries\nall healthy\n"),
	)
	if truncated {
		t.Fatal("常规样例不应报 truncated")
	}
	if len(results) != 2 {
		t.Fatalf("应逐规则返回 2 条，得到 %d", len(results))
	}
	if !results[0].Hit || results[0].Error != "" {
		t.Fatalf("t1 应命中且无错误: %+v", results[0])
	}
	if results[0].Matched != "panic: container OOMKilled after 3 retries" {
		t.Fatalf("摘录应为命中整行，得到 %q", results[0].Matched)
	}
	if results[1].Hit || results[1].Matched != "" || results[1].Error != "" {
		t.Fatalf("t2 未命中应保持零值结果: %+v", results[1])
	}
	if len(*hits) != 0 {
		t.Fatalf("试跑不应触发生产通知回调，得到 %v", *hits)
	}

	// 同一样例内多次出现：防抖语义取首条命中，结果仍单条
	results, _ = TestSentinelSample(
		[]SentinelProbeRule{{ID: "t1", Pattern: `OOM`}},
		[]byte("OOM once\nOOM twice\nOOM thrice\n"),
	)
	if len(results) != 1 || !results[0].Hit || results[0].Matched != "OOM once" {
		t.Fatalf("多次出现应只报首条命中: %+v", results)
	}
}

func TestSentinelProbe_RE2SyntaxAuthoritative(t *testing.T) {
	// RE2 专属语法（命名捕获组）：本地 JS 试跑编译不了（降级提示档），服务端
	// 档给出权威命中——本原语存在的核心理由
	results, _ := TestSentinelSample(
		[]SentinelProbeRule{{ID: "re2", Pattern: `(?P<word>oom)`}},
		[]byte("graceful oomkilled shutdown at boot\n"),
	)
	if len(results) != 1 || !results[0].Hit || results[0].Error != "" {
		t.Fatalf("RE2 专属语法应服务端命中: %+v", results)
	}

	// 坏正则：该条记 Error 不拖累其他规则（与生产「编译失败跳过」不同——试跑
	// 把失败显式还给调用方，写入口校验才是用户可见反馈）
	results, _ = TestSentinelSample(
		[]SentinelProbeRule{
			{ID: "bad", Pattern: `([unclosed`},
			{ID: "good", Pattern: `OOM`},
		},
		[]byte("OOM incoming\n"),
	)
	if len(results) != 2 {
		t.Fatalf("应逐规则返回，得到 %d", len(results))
	}
	if results[0].Hit || results[0].Error == "" {
		t.Fatalf("坏正则应报 Error 不命中: %+v", results[0])
	}
	if !results[1].Hit || results[1].Error != "" {
		t.Fatalf("好规则不应被坏正则拖累: %+v", results[1])
	}
}

func TestSentinelProbe_ClampLinesAndBytes(t *testing.T) {
	// 行钳制：501 行样例（与前端 split('\n')+slice(0,500) 同口径）——第 551 行
	// 的命中被钳掉，truncated 如实上报；前 500 行内的命中照常
	var b bytes.Buffer
	for i := 0; i < 549; i++ {
		b.WriteString("filler line\n")
	}
	b.WriteString("OOM beyond the clamp\n") // 第 550 行（1-based）
	b.WriteString("tail\n")
	results, truncated := TestSentinelSample(
		[]SentinelProbeRule{{ID: "t1", Pattern: `OOM`}},
		b.Bytes(),
	)
	if !truncated {
		t.Fatal("超 500 行应报 truncated")
	}
	if len(results) != 1 || results[0].Hit {
		t.Fatalf("钳制窗口外的命中不应出现: %+v", results)
	}

	// 恰 500 段（无尾换行，split 口径 = 500 行）：第 500 行命中保留，且不误报
	// truncated——与前端 split('\n') 段数口径一致（带尾换行的 500 行在两侧同为
	// 501 段、同样如实报 truncated，属既定口径不属误报）
	b.Reset()
	for i := 0; i < 499; i++ {
		b.WriteString("filler line\n")
	}
	b.WriteString("OOM on the last kept line")
	results, truncated = TestSentinelSample(
		[]SentinelProbeRule{{ID: "t1", Pattern: `OOM`}},
		b.Bytes(),
	)
	if truncated {
		t.Fatal("恰 500 行不应报 truncated")
	}
	if len(results) != 1 || !results[0].Hit {
		t.Fatalf("第 500 行命中应保留: %+v", results)
	}

	// 字节钳制：单行超长样例在硬顶处按 rune 边界截断——命中词滚出窗口则不命中，
	// 截断产物仍须合法 UTF-8
	huge := bytes.Repeat([]byte("占"), sentinelProbeMaxBytes/2+16) // 3 字节/字符，超硬顶
	results, truncated = TestSentinelSample(
		[]SentinelProbeRule{{ID: "t1", Pattern: `OOM`}},
		append(huge, []byte("OOM at tail")...),
	)
	if !truncated {
		t.Fatal("超字节硬顶应报 truncated")
	}
	if !utf8.ValidString(results[0].Matched) {
		t.Fatalf("钳制后摘录应合法 UTF-8: %q", results[0].Matched)
	}
	if len(results) != 1 || results[0].Hit {
		t.Fatalf("命中词已被字节钳制滚出不应命中: %+v", results)
	}
}

func TestSentinelProbe_NoSideEffects(t *testing.T) {
	hits := collectSentinelHits(t)
	// 生产规则供给面装探针：试跑全链路不得触碰（内联规则与存储编译缓存两世界）。
	// 探针只罩试跑段——末尾的生产 feed 复检前先换回正常桩（feed 本就会读供给）
	prevVersion, prevLoad := sentinelVersionFn, sentinelLoadFn
	sentinelVersionFn = func() int64 { return 1 }
	sentinelLoadFn = func() []store.SentinelRule {
		t.Error("试跑不应读取生产规则供给")
		return nil
	}
	resetSentinelRulesCache()

	results, _ := TestSentinelSample(
		[]SentinelProbeRule{{ID: "t1", Pattern: `(?i)oom`}},
		[]byte("watch: OOM detected\n"),
	)
	if len(results) != 1 || !results[0].Hit {
		t.Fatalf("试跑应独立命中: %+v", results)
	}
	if len(*hits) != 0 {
		t.Fatalf("试跑不得触发通知回调，得到 %v", *hits)
	}

	// 试跑后生产路径不受污染：stub 规则集（不匹配 plain output）对生产 feed
	// 照常生效，且无残留命中/通知
	sentinelLoadFn = func() []store.SentinelRule {
		return []store.SentinelRule{
			sentinelRule("sn-1", "n", `HIT-ME`, store.SentinelScopeGlobal, store.SentinelLevelWarn),
		}
	}
	resetSentinelRulesCache()
	t.Cleanup(func() {
		sentinelVersionFn, sentinelLoadFn = prevVersion, prevLoad
		resetSentinelRulesCache()
	})
	d := newSentinelDetector("term-1", "proj-1")
	d.feed([]byte("plain output\n"))
	if len(*hits) != 0 {
		t.Fatalf("生产 feed 不应受试跑影响，得到 %v", *hits)
	}
}

func TestSentinelProbe_ChunkBoundaryMatch(t *testing.T) {
	// 跨分块边界（sentinelProbeChunk=窗口一半）的匹配：分块喂入语义下仍须命中
	//——块长若等于窗口上限，跨界匹配的头部会在下块喂入前滚出窗口（漏报）；
	// 半窗步长保证任一 ≤ 窗口长的匹配在其尾部所属块喂入时完整落窗
	pad := strings.Repeat("x", sentinelProbeChunk-8) // 使模式横跨 chunk 边界
	sample := pad + "DEADLOCK-DETECT\n"
	if !(len(pad) < sentinelProbeChunk && len(sample) > sentinelProbeChunk) {
		t.Fatalf("夹具未横跨 chunk 边界: pad=%d total=%d chunk=%d", len(pad), len(sample), sentinelProbeChunk)
	}
	results, truncated := TestSentinelSample(
		[]SentinelProbeRule{{ID: "t1", Pattern: `DEADLOCK-DETECT`}},
		[]byte(sample),
	)
	if truncated {
		t.Fatal("未超钳制的样例不应报 truncated")
	}
	if len(results) != 1 || !results[0].Hit {
		t.Fatalf("跨块边界匹配应命中: %+v", results)
	}
	if !strings.Contains(results[0].Matched, "DEADLOCK-DETECT") {
		t.Fatalf("摘录应包含命中词: %q", results[0].Matched)
	}
}
