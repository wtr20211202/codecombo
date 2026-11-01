package claudesessions

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// 构造 transcript 的行构造器（字段形态与真实存储一致）
func userLine(ts, text string) string {
	return `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"` + text + `"},"timestamp":"` + ts + `","cwd":"D:\\p"}`
}

func assistantTextLine(ts, text string) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"` + text + `"}]},"timestamp":"` + ts + `"}`
}

func assistantToolLine(ts, callID, tool, input string) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"` + callID + `","name":"` + tool + `","input":` + input + `}]},"timestamp":"` + ts + `"}`
}

func toolResultLine(ts, callID, text string, isErr bool) string {
	errField := "false"
	if isErr {
		errField = "true"
	}
	return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + callID + `","content":[{"type":"text","text":"` + text + `"}],"is_error":` + errField + `}]},"timestamp":"` + ts + `"}`
}

func joinLines(lines []string) string { return strings.Join(lines, "\n") + "\n" }

func TestTimelineParseFullExchange(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines([]string{
		`{"type":"last-prompt","sessionId":"x"}`,
		userLine(now.Add(-3*time.Minute).UTC().Format(time.RFC3339), "帮我跑一下测试"),
		assistantTextLine(now.Add(-2*time.Minute).UTC().Format(time.RFC3339), "好的，先看测试列表"),
		assistantToolLine(now.Add(-2*time.Minute).UTC().Format(time.RFC3339), "toolu_1", "Bash", `{"command":"go test ./...","description":"跑全量测试"}`),
		toolResultLine(now.Add(-time.Minute).UTC().Format(time.RFC3339), "toolu_1", "ok  pass", false),
		// 未知类型行：宽松容错，静默跳过
		`{"type":"file-history-snapshot","messageId":"x"}`,
		// sidechain（子代理）行：跳过
		`{"type":"user","isSidechain":true,"message":{"role":"user","content":"子代理内部消息"},"timestamp":"` + now.UTC().Format(time.RFC3339) + `"}`,
		// 非法行：跳过
		`not json at all`,
	})
	write(t, root, EncodePath(`D:\p`), "sess-tl", content, now)

	res, err := Timeline(root, "sess-tl", 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Truncated {
		t.Error("small session must not be truncated")
	}
	if res.Total != 4 {
		t.Fatalf("Total = %d, want 4 (user/assistant/tool/result)", res.Total)
	}
	want := []string{"user", "assistant", "tool", "result"}
	for i, k := range want {
		if res.Entries[i].Kind != k {
			t.Fatalf("kinds = %v, want %v", res.Entries, want)
		}
	}
	u := res.Entries[0]
	if u.Text != "帮我跑一下测试" || u.At == "" {
		t.Errorf("user entry = %+v", u)
	}
	tl := res.Entries[2]
	if tl.Tool != "Bash" {
		t.Errorf("tool name = %q", tl.Tool)
	}
	// 输入摘要走偏好键序：command 优先于 description
	if tl.Input != "go test ./..." {
		t.Errorf("tool input = %q, want command value", tl.Input)
	}
	r := res.Entries[3]
	if r.Status != "ok" || r.Text != "ok  pass" {
		t.Errorf("result entry = %+v", r)
	}
}

// 工具失败：result 条目 status=error（审计高危操作轨迹依赖此区分）
func TestTimelineResultErrorStatus(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines([]string{
		userLine(now.UTC().Format(time.RFC3339), "删掉这个目录"),
		assistantToolLine(now.UTC().Format(time.RFC3339), "t1", "Bash", `{"command":"rm -rf /tmp/x"}`),
		toolResultLine(now.UTC().Format(time.RFC3339), "t1", "permission denied", true),
	})
	write(t, root, EncodePath(`D:\p`), "sess-err", content, now)

	res, err := Timeline(root, "sess-err", 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 3 {
		t.Fatalf("Total = %d", res.Total)
	}
	if res.Entries[2].Status != "error" {
		t.Errorf("Status = %q, want error", res.Entries[2].Status)
	}
}

// 时间正序 + 分页：Total 供「加载更多」判断，越界返回空页
func TestTimelinePagingChronological(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	lines := []string{}
	for i := 0; i < 10; i++ {
		ts := now.Add(-time.Duration(10-i) * time.Minute).UTC().Format(time.RFC3339)
		lines = append(lines, userLine(ts, `消息`+string(rune('0'+i))))
	}
	write(t, root, EncodePath(`D:\p`), "sess-page", joinLines(lines), now)

	res, err := Timeline(root, "sess-page", 4, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 10 || len(res.Entries) != 4 {
		t.Fatalf("page1: total=%d len=%d", res.Total, len(res.Entries))
	}
	if res.Entries[0].Text != "消息0" {
		t.Errorf("first page must start at oldest, got %q", res.Entries[0].Text)
	}
	res2, _ := Timeline(root, "sess-page", 4, 8)
	if len(res2.Entries) != 2 || res2.Entries[1].Text != "消息9" {
		t.Fatalf("last page = %+v", res2.Entries)
	}
	res3, _ := Timeline(root, "sess-page", 4, 99)
	if len(res3.Entries) != 0 || res3.Total != 10 {
		t.Fatalf("beyond-range: len=%d total=%d", len(res3.Entries), res3.Total)
	}
}

// 尾部窗口：行数超窗只保留最近（truncated 如实上报），窗口内条目仍正序
func TestTimelineTailWindowTruncation(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	lines := []string{}
	// 超出 timelineWindowLines(4000) 的用户消息行：每条间隔足够散开时间戳
	const extra = 30
	for i := 0; i < timelineWindowLines+extra; i++ {
		ts := now.Add(-time.Duration(timelineWindowLines+extra-i) * time.Second).UTC().Format(time.RFC3339)
		lines = append(lines, userLine(ts, `消息-`+itoaPad(i)))
	}
	write(t, root, EncodePath(`D:\p`), "sess-win", joinLines(lines), now)

	res, err := Timeline(root, "sess-win", 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated {
		t.Error("oversized session must report truncated")
	}
	if res.Total != timelineWindowLines {
		t.Fatalf("Total = %d, want window size %d", res.Total, timelineWindowLines)
	}
	// 窗口保留的是「最近」段：窗口内最老一条 = 全量的第 extra 条
	if res.Entries[0].Text != "消息-"+itoaPad(extra) {
		t.Errorf("window oldest = %q, want 消息-%d", res.Entries[0].Text, extra)
	}
	// 最后一页（offset 取到窗口末尾）= 全量最新一条
	lastPage, _ := Timeline(root, "sess-win", 50, res.Total-1)
	if len(lastPage.Entries) != 1 || lastPage.Entries[0].Text != "消息-"+itoaPad(timelineWindowLines+extra-1) {
		t.Errorf("window newest = %+v, want 消息-%d", lastPage.Entries, timelineWindowLines+extra-1)
	}
}

// 跨块回读的行边界：行跨度大于读取块长时行完整不粘连（含文件首块无换行形态）
func TestTimelineCollectTailLinesChunkBoundary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.jsonl")
	var b strings.Builder
	// 每行 ~120KB > timelineTailChunk(64KB)：行必然跨块
	for i := 0; i < 3; i++ {
		b.WriteString(`{"pad":"` + strings.Repeat("x", 120_000) + `","n":"` + string(rune('0'+i)) + `"}` + "\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close() //nolint:errcheck
	st, _ := f.Stat()

	lines, trunc := collectTailLines(f, st.Size(), 100, 1<<20)
	if trunc {
		t.Error("small file must not truncate")
	}
	if len(lines) != 3 {
		t.Fatalf("lines = %d, want 3", len(lines))
	}
	for i, line := range lines {
		if !strings.HasPrefix(string(line), `{"pad":"`) || !strings.HasSuffix(string(line), `","n":"`+string(rune('0'+i))+`"}`) {
			t.Fatalf("line %d corrupted across chunk boundary: head=%q tail=%q",
				i, line[:16], line[len(line)-16:])
		}
	}
}

// 字节预算截断：maxBytes 压到只够半块时 trunc 如实上报且行完整
func TestTimelineCollectTailLinesByteBudget(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.jsonl")
	var b strings.Builder
	for i := 0; i < 4; i++ {
		b.WriteString(`{"pad":"` + strings.Repeat("x", 120_000) + `","n":"` + string(rune('0'+i)) + `"}` + "\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close() //nolint:errcheck
	st, _ := f.Stat()

	// 预算 64KB < 单行 120KB：一行都读不全 → 0 行 + truncated
	lines, trunc := collectTailLines(f, st.Size(), 100, timelineTailChunk)
	if !trunc {
		t.Error("tiny budget must report truncated")
	}
	if len(lines) != 0 {
		t.Fatalf("lines = %d, want 0 (no complete line fits budget)", len(lines))
	}
}

// 防目录穿越：非法 id 归一为 ErrSessionNotFound；不存在的会话 404 语义
func TestTimelineTraversalAndMissing(t *testing.T) {
	root := t.TempDir()
	for _, bad := range []string{"../evil", `a\b`, "a.b", "", "missing"} {
		if _, err := Timeline(root, bad, 50, 0); !errors.Is(err, ErrSessionNotFound) {
			t.Fatalf("Timeline(root, %q) err = %v, want ErrSessionNotFound", bad, err)
		}
	}
}

// 文本摘要截断：超长正文按 rune 截断（中文不截半字）；工具输入回退首个
// 字符串值（未知工具的新键名也能给出可用摘要）
func TestTimelineSummariesTruncateAndFallback(t *testing.T) {
	long := strings.Repeat("长", timelineTextMaxRunes+10)
	got := truncateRunes(long, timelineTextMaxRunes)
	if utf8.RuneCountInString(got) != timelineTextMaxRunes+1 { // +1 = 追加的省略号
		t.Fatalf("truncateRunes keep = %d", utf8.RuneCountInString(got))
	}
	// 未知键名：回退首个字符串值
	if in := summarizeToolInput([]byte(`{"unknownKey":"回退值","n":3}`)); in != "回退值" {
		t.Errorf("fallback input = %q", in)
	}
	// 空对象/坏 JSON：空摘要不报错
	if got := summarizeToolInput([]byte(`{}`)); got != "" {
		t.Errorf("empty input = %q", got)
	}
	if got := summarizeToolInput([]byte(`not json`)); got != "" {
		t.Errorf("bad input = %q", got)
	}
}

// itoaPad 定长编号（fixture 断言用，避免引 strconv.Sort 风格干扰可读性）
func itoaPad(i int) string {
	s := ""
	if i == 0 {
		return "0000"
	}
	for i > 0 {
		s = string(rune('0'+i%10)) + s
		i /= 10
	}
	for len(s) < 4 {
		s = "0" + s
	}
	return s
}

// --- 整窗 mtime 缓存（P-20261002-116）：命中 / 失效 / 键隔离 / 并发安全 ---

// cacheHitFixtureContent 缓存命中测试的 fixture：等字节长度的两版内容（中文
// 等宽替换），配合 Chtimes 恢复原 mtime 构造「stat 指纹未变、内容已换」
func cacheHitFixtureContent(text string) string {
	return joinLines([]string{
		userLine("2026-01-02T10:00:00Z", text),
		assistantTextLine("2026-01-02T10:00:01Z", "回复"+text),
	})
}

// 命中：stat 指纹（mtime+size）未变 → 直接复用缓存整窗，零重读。换成同尺寸
// 不同内容并恢复原 mtime——若误重读会返回第二版内容；跨分页参数的请求同样
// 命中（窗口解析与分页参数无关，缓存存整窗）
func TestTimelineCacheHitOnSameStat(t *testing.T) {
	root := t.TempDir()
	mod := time.Now().Add(-time.Hour)
	write(t, root, EncodePath(`D:\p`), "sess-cache", cacheHitFixtureContent("第一版"), mod)

	page1, err := Timeline(root, "sess-cache", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if page1.Total != 2 || page1.Entries[0].Text != "第一版" {
		t.Fatalf("first read = %+v", page1)
	}

	// 同字节数不同内容 + Chtimes 恢复原 mtime：stat 比对必命中
	if orig := cacheHitFixtureContent("第一版"); len(orig) != len(cacheHitFixtureContent("第二版")) {
		t.Fatal("fixture versions must be byte-equal length")
	}
	path := filepath.Join(root, EncodePath(`D:\p`), "sess-cache.jsonl")
	if err := os.WriteFile(path, []byte(cacheHitFixtureContent("第二版")), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}

	hit, err := Timeline(root, "sess-cache", 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	if hit.Total != 2 || hit.Entries[0].Text != "第一版" {
		t.Fatalf("stat-unchanged request must serve cached window, got %+v", hit)
	}
	// 缓存整窗上的分页照常：换 limit/offset 仍命中并切出对应页
	page2, err := Timeline(root, "sess-cache", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page2.Total != 2 || len(page2.Entries) != 1 || page2.Entries[0].Text != "回复第一版" {
		t.Fatalf("paged read over cached window = %+v", page2)
	}
}

// 失效：文件追加（size、mtime 均变）→ 重读重解析并刷新缓存，新条目可见
func TestTimelineCacheInvalidatedOnAppend(t *testing.T) {
	root := t.TempDir()
	mod := time.Now().Add(-time.Hour)
	write(t, root, EncodePath(`D:\p`), "sess-grow",
		joinLines([]string{userLine(mod.UTC().Format(time.RFC3339), "旧消息")}), mod)

	if r, err := Timeline(root, "sess-grow", 50, 0); err != nil || r.Total != 1 {
		t.Fatalf("first read total=%d err=%v", r.Total, err)
	}

	newer := mod.Add(time.Minute)
	path := filepath.Join(root, EncodePath(`D:\p`), "sess-grow.jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, werr := f.WriteString(userLine(newer.UTC().Format(time.RFC3339), "新消息") + "\n")
	if cerr := f.Close(); werr != nil {
		t.Fatal(werr)
	} else if cerr != nil {
		t.Fatal(cerr)
	}
	if err := os.Chtimes(path, newer, newer); err != nil {
		t.Fatal(err)
	}

	r, err := Timeline(root, "sess-grow", 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if r.Total != 2 || r.Entries[1].Text != "新消息" {
		t.Fatalf("appended content must be re-read, got total=%d %+v", r.Total, r.Entries)
	}
}

// 键隔离：缓存键为解析后路径而非裸 sessionID——不同 root 的同 id 会话
// （SC_CLAUDE_DIR 隔离场景）各归各，命中不串
func TestTimelineCacheKeyedByPath(t *testing.T) {
	mod := time.Now().Add(-time.Hour)
	rootA, rootB := t.TempDir(), t.TempDir()
	write(t, rootA, EncodePath(`D:\p`), "sess-dual", cacheHitFixtureContent("A侧"), mod)
	write(t, rootB, EncodePath(`D:\p`), "sess-dual", cacheHitFixtureContent("B侧"), mod)

	for i := 0; i < 2; i++ { // 第二轮走缓存，验证命中也不串
		ra, err := Timeline(rootA, "sess-dual", 50, 0)
		if err != nil {
			t.Fatal(err)
		}
		rb, err := Timeline(rootB, "sess-dual", 50, 0)
		if err != nil {
			t.Fatal(err)
		}
		if ra.Entries[0].Text != "A侧" || rb.Entries[0].Text != "B侧" {
			t.Fatalf("round %d cross-root mix: A=%q B=%q", i, ra.Entries[0].Text, rb.Entries[0].Text)
		}
	}
}

// 并发安全：多 goroutine 混合请求超过 timelineCacheMaxSessions 个会话，反复
// 触发入缓存与超限清空，与命中路径竞争同一 map（go test -race 下无数据竞争）
func TestTimelineCacheConcurrentAccess(t *testing.T) {
	root := t.TempDir()
	mod := time.Now().Add(-time.Hour)
	const sessions = timelineCacheMaxSessions + 8
	for i := 0; i < sessions; i++ {
		write(t, root, EncodePath(`D:\p`), "sess-cc-"+itoaPad(i),
			joinLines([]string{userLine(mod.UTC().Format(time.RFC3339), "消息"+itoaPad(i))}), mod)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 1)
	for g := 0; g < 24; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for k := 0; k < 10; k++ {
				id := "sess-cc-" + itoaPad((g*7+k*3)%sessions)
				if _, err := Timeline(root, id, 10, 0); err != nil {
					select {
					case errs <- err:
					default:
					}
					return
				}
			}
		}(g)
	}
	wg.Wait()
	select {
	case err := <-errs:
		t.Fatal(err)
	default:
	}
}

// 缓存条目数封顶：超过 timelineCacheMaxSessions 后整体清空，map 不无界增长
func TestTimelineCacheBounded(t *testing.T) {
	root := t.TempDir()
	mod := time.Now().Add(-time.Hour)
	for i := 0; i < timelineCacheMaxSessions+5; i++ {
		id := "sess-cap-" + strconv.Itoa(i)
		write(t, root, EncodePath(`D:\p`), id,
			joinLines([]string{userLine(mod.UTC().Format(time.RFC3339), "消息")}), mod)
		if _, err := Timeline(root, id, 50, 0); err != nil {
			t.Fatal(err)
		}
	}
	timelineCacheMu.RLock()
	n := len(timelineCache)
	timelineCacheMu.RUnlock()
	if n > timelineCacheMaxSessions {
		t.Fatalf("cache size = %d, must stay capped at %d", n, timelineCacheMaxSessions)
	}
}
