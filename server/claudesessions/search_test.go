package claudesessions

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 全文搜索单测（P-20261003-19）：扫描命中/上下文取窗、护栏三闸（单文件 5MB
// 跳过/会话上限 200/总时限）、损坏行容错、P-108 敏感遮蔽、冷索引回退与项目
// 范围。fixture 复用列表测试的 write/fixtureJSONL 装配（同包白盒）。

func newSearchIndexForTest(t *testing.T, root string) *Index {
	t.Helper()
	return NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
}

// userLineWith 构造一条用户消息行（content 为指定文本）
func userLineWith(text string, ts time.Time) string {
	return `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"` + text + `"},"timestamp":"` + ts.UTC().Format(time.RFC3339) + `","cwd":"D:\\proj"}`
}

// assistantLineWith 构造一条 assistant 文本行
func assistantLineWith(text string, ts time.Time) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"` + text + `"}]},"timestamp":"` + ts.UTC().Format(time.RFC3339) + `"}`
}

const searchKeyword = "websocket-reconnect"

// 命中与上下文：命中会话返回 id/标题/上下文（带时刻），未命中会话不出现；
// 排序按最近活跃在前；元数据取自 claudeindex 条目
func TestSearchFindsHitsWithContext(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	// 旧会话：标题行与 assistant 行都含关键词 → 上下文取到上限 2 条
	write(t, root, EncodePath(`D:\projA`), "id-old",
		fixtureJSONL("命中会话 "+searchKeyword, now.Add(-3*time.Hour),
			assistantLineWith("讨论 "+searchKeyword+" 的重连方案", now.Add(-3*time.Hour)),
		), now.Add(-3*time.Hour))
	write(t, root, EncodePath(`D:\projA`), "id-new",
		fixtureJSONL("无关会话 "+searchKeyword, now.Add(-time.Hour)), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projB`), "id-none",
		fixtureJSONL("毫不相关的会话", now.Add(-30*time.Minute)), now.Add(-30*time.Minute))

	ix := newSearchIndexForTest(t, root)
	if _, err := ix.List("", 10, 0); err != nil { // 先建索引：元数据走 claudeindex 条目
		t.Fatal(err)
	}
	res := ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 2 {
		t.Fatalf("hits = %d, want 2: %+v", len(res.Hits), res.Hits)
	}
	if res.Truncated {
		t.Fatalf("small corpus must not be truncated: %+v", res)
	}
	// 最近活跃在前
	if res.Hits[0].SessionID != "id-new" || res.Hits[1].SessionID != "id-old" {
		t.Fatalf("order by recency: %+v", res.Hits)
	}
	// 元数据：标题/cwd 取自索引条目，Active 按当前时刻判定
	h := res.Hits[0]
	if h.Title != "无关会话 "+searchKeyword || h.Cwd != `D:\e2e-demo` {
		t.Fatalf("metadata from index: %+v", h)
	}
	if h.Active {
		t.Fatalf("aged fixture must not be active: %+v", h)
	}
	if len(h.Lines) != 1 || !strings.Contains(h.Lines[0].Text, searchKeyword) {
		t.Fatalf("hit lines: %+v", h.Lines)
	}
	if h.Lines[0].At == "" {
		t.Fatalf("hit line must carry message timestamp: %+v", h.Lines[0])
	}
	// 第二个命中：user 标题行 + assistant 行都含关键词 → 上下文封顶 2 条即止读
	if got := len(res.Hits[1].Lines); got != searchHitLinesMax {
		t.Fatalf("hit lines capped at %d, got %d", searchHitLinesMax, got)
	}
}

// 大小写不敏感：查询大写形态命中小写原文，上下文保留原文大小写
func TestSearchCaseInsensitive(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "id-1",
		fixtureJSONL("讨论 WebSocket-Reconnect 细节", now.Add(-time.Hour)), now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root)
	res := ix.Search("", "WEBSOCKET-RECONNECT", 10)
	if len(res.Hits) != 1 || !strings.Contains(res.Hits[0].Lines[0].Text, "WebSocket-Reconnect") {
		t.Fatalf("case-insensitive hit: %+v", res.Hits)
	}
}

// 修正项：命中上下文套 P-108 敏感遮蔽——password= 赋值/sc?_ 令牌不离开服务端
// （遮蔽而非整行丢弃：键名保留、值替换 ***）
func TestSearchMasksSensitiveContext(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "id-secret",
		fixtureJSONL("第二条",
			now.Add(-time.Hour),
			userLineWith("修复 "+searchKeyword+" 时 export password=super-secret-e2e-123 和 sca_tokABCDEF123 令牌", now.Add(-time.Hour)),
		), now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root)
	res := ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 1 {
		t.Fatalf("hits = %d, want 1: %+v", len(res.Hits), res.Hits)
	}
	for _, l := range res.Hits[0].Lines {
		if strings.Contains(l.Text, "super-secret-e2e-123") || strings.Contains(l.Text, "sca_tokABCDEF123") {
			t.Fatalf("sensitive value leaked in context: %q", l.Text)
		}
	}
	foundMask := false
	for _, l := range res.Hits[0].Lines {
		if strings.Contains(l.Text, "password=***") && strings.Contains(l.Text, searchKeyword) {
			foundMask = true
		}
	}
	if !foundMask {
		t.Fatalf("masked assignment form expected: %+v", res.Hits[0].Lines)
	}
}

// 修正项（标题面）：首条用户消息常是粘贴内容——命中条目标题同为敏感曝光面，
// password= 赋值形态在标题里同样遮蔽（索引条目与扫描自取两条来源都过 MaskText）
func TestSearchMasksSensitiveTitle(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "id-titled",
		fixtureJSONL("求助 "+searchKeyword+" password=titled-secret-889 事发", now.Add(-time.Hour)),
		now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root)
	// 冷索引路径：标题由扫描自取（parseHead 首条用户文本）
	res := ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 1 {
		t.Fatalf("hits = %d, want 1: %+v", len(res.Hits), res.Hits)
	}
	if strings.Contains(res.Hits[0].Title, "titled-secret-889") {
		t.Fatalf("title leaked secret: %q", res.Hits[0].Title)
	}
	if !strings.Contains(res.Hits[0].Title, "password=***") {
		t.Fatalf("title masked form expected: %q", res.Hits[0].Title)
	}

	// 索引命中路径：标题取自 claudeindex 条目（同样为原文存储，出结果前遮蔽）
	if _, err := ix.List("", 10, 0); err != nil {
		t.Fatal(err)
	}
	res = ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 1 || strings.Contains(res.Hits[0].Title, "titled-secret-889") {
		t.Fatalf("indexed title must be masked too: %+v", res.Hits)
	}
}

// 护栏一：单文件 5MB 上限——超大文件跳过且 truncated 如实上报
func TestSearchSkipsOversizeFiles(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	// 大文件：标题行含关键词（若被扫描必然命中）+ >5MB 无关填充
	write(t, root, EncodePath(`D:\projA`), "id-big",
		fixtureJSONL("大文件会话 "+searchKeyword, now.Add(-2*time.Hour))+strings.Repeat("x", 5<<20),
		now.Add(-2*time.Hour))
	write(t, root, EncodePath(`D:\projA`), "id-small",
		fixtureJSONL("小文件会话 "+searchKeyword, now.Add(-time.Hour)), now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root)
	res := ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 1 || res.Hits[0].SessionID != "id-small" {
		t.Fatalf("oversize file must be skipped: %+v", res.Hits)
	}
	if !res.Truncated {
		t.Fatalf("oversize skip must mark truncated: %+v", res)
	}
}

// 护栏二：扫描会话上限 200——只扫最近 200 个（白盒断言枚举封顶），端到端
// truncated 如实上报
func TestSearchSessionCap(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	for i := 0; i <= searchSessionCap; i++ { // 201 个：恰好多出一个被封顶截掉
		mod := now.Add(-time.Duration(i+1) * time.Hour)
		write(t, root, EncodePath(`D:\projA`), "id-"+itoaPad(i),
			fixtureJSONL("cap 会话 "+searchKeyword, mod), mod)
	}
	ix := newSearchIndexForTest(t, root)
	targets, capped := ix.searchTargets("")
	if len(targets) != searchSessionCap || !capped {
		t.Fatalf("targets capped: len=%d capped=%v", len(targets), capped)
	}
	if targets[0].id != "id-0000" || targets[searchSessionCap-1].id != "id-0199" {
		t.Fatalf("cap keeps newest: first=%s last=%s", targets[0].id, targets[searchSessionCap-1].id)
	}
	res := ix.Search("", searchKeyword, SearchLimitMax)
	if len(res.Hits) != SearchLimitMax || !res.Truncated {
		t.Fatalf("hits capped by limit and truncated: n=%d trunc=%v", len(res.Hits), res.Truncated)
	}
}

// 护栏三：总时限——注入过去时刻立即收手并上报 truncated
func TestSearchDeadline(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "id-1",
		fixtureJSONL("超时会话 "+searchKeyword, now.Add(-time.Hour)), now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root)
	res := ix.searchWithin("", searchKeyword, 10, time.Now().Add(-time.Second))
	if len(res.Hits) != 0 {
		t.Fatalf("expired deadline must return nothing: %+v", res.Hits)
	}
	if !res.Truncated {
		t.Fatalf("deadline must mark truncated: %+v", res)
	}
}

// 响应条数上限：命中会话数超 limit 时截断并如实上报
func TestSearchLimitTruncates(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	for i := 0; i < 3; i++ {
		mod := now.Add(-time.Duration(i+1) * time.Hour)
		write(t, root, EncodePath(`D:\projA`), "id-"+itoaPad(i),
			fixtureJSONL("limit 会话 "+searchKeyword, mod), mod)
	}
	ix := newSearchIndexForTest(t, root)
	res := ix.Search("", searchKeyword, 2)
	if len(res.Hits) != 2 || !res.Truncated {
		t.Fatalf("limit must cap hits and mark truncated: %+v", res)
	}
}

// 损坏行容错：垃圾行/截断 JSON/非对象行混入不影响命中（与包级宽松容错同语义）
func TestSearchToleratesCorruptLines(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := strings.Join([]string{
		`not json at all`,
		`{"truncated json, no close`,
		`["json","array","not object"]`,
		fixtureJSONL("损坏行会话 "+searchKeyword, now.Add(-time.Hour)),
		`{"type":"user","message":{"content":"\a\b bad bytes"`,
	}, "\n")
	write(t, root, EncodePath(`D:\projA`), "id-corrupt", content, now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root)
	res := ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 1 || len(res.Hits[0].Lines) == 0 {
		t.Fatalf("corrupt lines must not block hits: %+v", res.Hits)
	}
	if !strings.Contains(res.Hits[0].Lines[0].Text, searchKeyword) {
		t.Fatalf("hit context: %+v", res.Hits[0].Lines)
	}
}

// 冷索引回退：索引为空（未列表过/缓存被清）时搜索照常可用，标题/cwd 由扫描自取
func TestSearchColdIndexFallback(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "id-cold",
		fixtureJSONLCwd("冷索引会话 "+searchKeyword, now.Add(-time.Hour), `D:\cold-proj`), now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root) // 不做 List：claudeindex 为空
	res := ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 1 {
		t.Fatalf("cold index must not block search: %+v", res.Hits)
	}
	h := res.Hits[0]
	if h.Title != "冷索引会话 "+searchKeyword {
		t.Fatalf("title from scan fallback: %+v", h)
	}
	if h.Cwd != `D:\cold-proj` {
		t.Fatalf("cwd from scan fallback: %+v", h)
	}
}

// 项目范围：projectPath 非空只扫该工作目录对应子目录（尾分隔符归一化与列表同款）
func TestSearchProjectScope(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "id-a",
		fixtureJSONLCwd("A 会话 "+searchKeyword, now.Add(-time.Hour), `D:\projA`), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projB`), "id-b",
		fixtureJSONLCwd("B 会话 "+searchKeyword, now.Add(-2*time.Hour), `D:\projB`), now.Add(-2*time.Hour))

	ix := newSearchIndexForTest(t, root)
	res := ix.Search(`D:\projA\`, searchKeyword, 10)
	if len(res.Hits) != 1 || res.Hits[0].SessionID != "id-a" {
		t.Fatalf("project scope: %+v", res.Hits)
	}
}

// 片段取窗：长文本以命中点为中心截断并补省略号；短文本原样；空白折叠单行化
func TestSearchSnippetWindow(t *testing.T) {
	long := strings.Repeat("前导", 60) + searchKeyword + strings.Repeat("后缀", 60)
	got := searchSnippet(long, indexFoldRunes(long, searchKeyword))
	if !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "…") {
		t.Fatalf("window must ellipsize both ends: %q", got)
	}
	if n := utf8.RuneCountInString(got); n > searchSnippetRunes+2 {
		t.Fatalf("window exceeds cap: %d runes", n)
	}
	if !strings.Contains(got, searchKeyword) {
		t.Fatalf("window keeps the hit: %q", got)
	}

	short := "短文本 " + searchKeyword + " 结束"
	got = searchSnippet(short, indexFoldRunes(short, searchKeyword))
	if strings.Contains(got, "…") {
		t.Fatalf("short text stays whole: %q", got)
	}
	if got := searchSnippet("多行\n文本\t折叠", 0); strings.ContainsAny(got, "\n\t") {
		t.Fatalf("whitespace must collapse: %q", got)
	}
}

// 超大单行（截图 base64 形态）之后的命中不受影响：预滤无关键词行零解析成本
func TestSearchHitAfterHugeLine(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := fixtureJSONL("大行会话", now.Add(-time.Hour)) +
		`{"type":"user","message":{"role":"user","content":"` + strings.Repeat("A", 1<<20) + `"},"timestamp":"` + now.UTC().Format(time.RFC3339) + `"}` + "\n" +
		assistantLineWith("提及 "+searchKeyword+" 的收尾", now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projA`), "id-huge-line", content, now.Add(-time.Hour))

	ix := newSearchIndexForTest(t, root)
	res := ix.Search("", searchKeyword, 10)
	if len(res.Hits) != 1 || !strings.Contains(res.Hits[0].Lines[0].Text, searchKeyword) {
		t.Fatalf("hit after huge line: %+v", res.Hits)
	}
}

// 文件恰被删除（枚举后读取失败）：跳过不报错（白盒：防御路径直测）
func TestSearchSkipsMissingFile(t *testing.T) {
	root := t.TempDir()
	ix := newSearchIndexForTest(t, root)
	tgt := searchTarget{
		id:      "id-gone",
		path:    filepath.Join(root, EncodePath(`D:\projA`), "id-gone.jsonl"),
		modTime: time.Now().Add(-time.Hour),
	}
	hit, over := scanSessionForMatch(&tgt, searchKeyword, time.Now().Add(time.Second), new(int))
	if hit != nil || over {
		t.Fatalf("missing file must be skipped: hit=%v over=%v", hit, over)
	}
	if res := ix.Search("", searchKeyword, 10); len(res.Hits) != 0 {
		t.Fatalf("empty corpus: %+v", res.Hits)
	}
}
