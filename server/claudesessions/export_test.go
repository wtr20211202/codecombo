package claudesessions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 导出 Markdown（P-20261003-44）单测：渲染结构 / 损坏行容错 / 双护栏（窗口
// 截断、输出上限）/ 下载文件名净化。行构造器复用 timeline_test.go 同款。

func exportFixtureLines(now time.Time) []string {
	ts := func(offsetMin int) string {
		return now.Add(-time.Duration(offsetMin) * time.Minute).UTC().Format(time.RFC3339)
	}
	return []string{
		`{"type":"last-prompt","sessionId":"sess-exp"}`,
		// 元信息块（不可作标题）+ 真实首条用户消息
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"<local-command-caveat>提示</local-command-caveat>"},"timestamp":"` + ts(9) + `"}`,
		userLine(ts(8), "帮我排查 WebSocket 重连"),
		// assistant 行：思考 + 正文 + 工具调用 文档序交错
		`{"type":"assistant","message":{"role":"assistant","content":[` +
			`{"type":"thinking","thinking":"先看网关日志再定位心跳间隔"},{"type":"text","text":"好的，先确认心跳配置"},` +
			`{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"grep -rn heartbeat ws/"}}]},` +
			`"timestamp":"` + ts(7) + `"}`,
		toolResultLine(ts(6), "t1", "ws/heartbeat.go:12 interval=30s", false),
		// 未知类型行 / sidechain / 非法行：宽松容错静默跳过
		`{"type":"file-history-snapshot","messageId":"x"}`,
		`{"type":"user","isSidechain":true,"message":{"role":"user","content":"子代理内部消息"},"timestamp":"` + ts(5) + `"}`,
		`not json at all`,
		// 失败的工具结果：错误标记渲染
		toolResultLine(ts(4), "t1", "connection refused", true),
		assistantTextLine(ts(3), "心跳间隔 30s 正常，问题在网络层"),
		// 第二回合：kind 变化再开新节
		userLine(ts(2), "原来是网关配置"),
		assistantTextLine(ts(1), "已修复，网关已重启"),
	}
}

func TestExportMarkdownStructure(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines(exportFixtureLines(now))
	write(t, root, EncodePath(`D:\p`), "sess-exp", content, now)

	res, err := ExportAt(root, "sess-exp", now)
	if err != nil {
		t.Fatal(err)
	}
	doc := res.Markdown

	// 标题 = 首条有效用户消息（元信息块跳过，与列表标题同源口径）
	if !strings.HasPrefix(doc, "# Claude 会话：帮我排查 WebSocket 重连\n") {
		t.Errorf("title heading wrong: %.80q", doc)
	}
	if res.Title != "帮我排查 WebSocket 重连" {
		t.Errorf("Title = %q", res.Title)
	}
	// 元数据区
	for _, want := range []string{"- 会话 ID：`sess-exp`", "- 导出时间：" + now.Format("2006-01-02")} {
		if !strings.Contains(doc, want) {
			t.Errorf("meta missing %q", want)
		}
	}
	// 分节：kind 变化开新节——用户 2 回合 2 节；助手 3 节（工具结果把
	// 「工具前」「工具后」两段助手文本拆为两节）
	if got := strings.Count(doc, "## 👤 用户"); got != 2 {
		t.Errorf("user sections = %d, want 2", got)
	}
	if got := strings.Count(doc, "## 🤖 助手"); got != 3 {
		t.Errorf("assistant sections = %d, want 3", got)
	}
	// 思考块以引用块标记
	if !strings.Contains(doc, "> 💭 先看网关日志再定位心跳间隔") {
		t.Errorf("thinking quote missing")
	}
	// 工具调用折叠为摘要行（工具名+目标一行）
	if !strings.Contains(doc, "- 🔧 **Bash**：") || !strings.Contains(doc, "grep -rn heartbeat ws/") {
		t.Errorf("tool summary line wrong:\n%s", doc)
	}
	// 工具结果：成功 ↳ / 失败 ⚠️
	if !strings.Contains(doc, "> ↳ ws/heartbeat.go:12") {
		t.Errorf("ok result quote missing")
	}
	if !strings.Contains(doc, "> ⚠️ 失败：connection refused") {
		t.Errorf("error result quote missing")
	}
	// 正文落节内
	if !strings.Contains(doc, "帮我排查 WebSocket 重连") || !strings.Contains(doc, "心跳间隔 30s 正常") {
		t.Errorf("body text missing")
	}
	// 宽松容错：噪声行内容不入文档
	if strings.Contains(doc, "子代理内部消息") || strings.Contains(doc, "not json") || strings.Contains(doc, "file-history-snapshot") {
		t.Errorf("noise leaked into doc")
	}
	// 分节顺序：首节用户、次节助手
	if i := strings.Index(doc, "## 👤 用户"); i < 0 || strings.Index(doc, "## 🤖 助手") < i {
		t.Errorf("section order wrong")
	}
	if res.Truncated {
		t.Error("small session must not be truncated")
	}
	if res.EntryCount != 9 { // user/assistant/thinking/tool/result×2/assistant/user/assistant
		t.Errorf("EntryCount = %d, want 9", res.EntryCount)
	}
}

// 仅问答档（P-20261004-132）：与完整档同一 fixture 的两档渲染差异——过程噪声
// 三形态（工具摘要 🔧 / 结果引用 ↳⚠️ / 思考引用 💭）全跳过、问答正文与分节/
// 元数据完整、相邻 assistant 合并同节；完整档同链零变化对账
func TestExportQAMode(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	content := joinLines(exportFixtureLines(now))
	write(t, root, EncodePath(`D:\p`), "sess-qa", content, now)

	full, err := ExportAt(root, "sess-qa", now)
	if err != nil {
		t.Fatal(err)
	}
	qa, err := ExportAtMode(root, "sess-qa", now, ExportModeQA)
	if err != nil {
		t.Fatal(err)
	}

	// 对账：完整档含全部噪声形态（断言面不是空洞的——fixture 确实有这些行）
	for _, noise := range []string{"- 🔧 **Bash**：", "> ↳ ws/heartbeat.go:12", "> ⚠️ 失败：", "> 💭 先看网关日志再定位心跳间隔"} {
		if !strings.Contains(full.Markdown, noise) {
			t.Errorf("full doc missing %q — fixture/expectation drift", noise)
		}
	}
	// 仅问答档：过程噪声三形态与其携带的内容全部跳过（工具命令/结果文本/思考草稿）
	for _, noise := range []string{
		"🔧", "↳", "⚠️", "💭",
		"grep -rn heartbeat", "ws/heartbeat.go:12", "connection refused",
		"先看网关日志再定位心跳间隔",
	} {
		if strings.Contains(qa.Markdown, noise) {
			t.Errorf("qa doc contains process noise %q:\n%s", noise, qa.Markdown)
		}
	}
	// 问答正文完整：两回合 user 与三段 assistant 文本都在
	for _, want := range []string{
		"帮我排查 WebSocket 重连", "好的，先确认心跳配置",
		"原来是网关配置", "心跳间隔 30s 正常，问题在网络层", "已修复，网关已重启",
	} {
		if !strings.Contains(qa.Markdown, want) {
			t.Errorf("qa doc missing Q&A body %q:\n%s", want, qa.Markdown)
		}
	}
	// 元数据区与完整档同形（标题/会话 ID/导出时间），标题同源
	if !strings.HasPrefix(qa.Markdown, "# Claude 会话：帮我排查 WebSocket 重连\n") {
		t.Errorf("qa title heading wrong: %.80q", qa.Markdown)
	}
	for _, want := range []string{"- 会话 ID：`sess-qa`", "- 导出时间：" + now.Format("2006-01-02")} {
		if !strings.Contains(qa.Markdown, want) {
			t.Errorf("qa meta missing %q", want)
		}
	}
	// 分节：用户 2 节；助手 2 节（原被工具步隔开的两段助手文本合并续节——
	// kind 变化开新节规则在过滤后的相邻 assistant 上自然收敛）
	if got := strings.Count(qa.Markdown, "## 👤 用户"); got != 2 {
		t.Errorf("qa user sections = %d, want 2", got)
	}
	if got := strings.Count(qa.Markdown, "## 🤖 助手"); got != 2 {
		t.Errorf("qa assistant sections = %d, want 2 (merged across removed tool step)", got)
	}
	// 步数 = 过滤后条目数（渲染面口径，与完整档 9 相区分）
	if qa.EntryCount != 5 {
		t.Errorf("qa EntryCount = %d, want 5", qa.EntryCount)
	}
	if qa.Truncated {
		t.Error("qa small session must not be truncated")
	}
	// 完整档零回归：ExportAt 与 ExportAtMode(full) 同字节（mode 缺省语义）
	viaMode, err := ExportAtMode(root, "sess-qa", now, ExportModeFull)
	if err != nil {
		t.Fatal(err)
	}
	if viaMode.Markdown != full.Markdown || viaMode.EntryCount != full.EntryCount {
		t.Error("ExportAtMode(full) diverges from ExportAt")
	}
}

// mode 查询串解析：空串/full/qa 三合法形态 + 未知值拒绝（handler 400 面的包内口径）
func TestParseExportMode(t *testing.T) {
	cases := []struct {
		raw  string
		want ExportMode
		ok   bool
	}{
		{"", ExportModeFull, true},
		{"full", ExportModeFull, true},
		{"qa", ExportModeQA, true},
		{" qa ", ExportModeQA, true}, // 查询串两翼空白容忍（与 format 同款 TrimSpace 口径）
		{"md", "", false},
		{"QA", "", false}, // 大小写敏感：档位值是协议面，不静默归一
	}
	for _, tc := range cases {
		got, ok := ParseExportMode(tc.raw)
		if ok != tc.ok || got != tc.want {
			t.Errorf("ParseExportMode(%q) = (%q,%v), want (%q,%v)", tc.raw, got, ok, tc.want, tc.ok)
		}
	}
}

// 仅问答档下载名：完整档名 + "-qa" 尾缀在扩展名前（同日同题双档不互覆）
func TestExportQADownloadName(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	got := ExportQADownloadName("修复 WebSocket 重连 bug", "id-qa", now)
	if !strings.HasSuffix(got, "-20261024-qa.md") {
		t.Errorf("ExportQADownloadName = %q, want *-20261024-qa.md", got)
	}
	// 与完整档仅差尾缀（同净化链）
	full := ExportDownloadName("修复 WebSocket 重连 bug", "id-qa", now, "md")
	if got != strings.TrimSuffix(full, ".md")+"-qa.md" {
		t.Errorf("qa name %q not derived from full name %q", got, full)
	}
}

func TestExportCorruptTolerant(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	// 坏行占主体的会话：坏行整行跳过（宽松容错，绝不因坏行失败）、
	// 唯一有效行照常渲染——导出不失败、不产空文档
	content := joinLines([]string{
		`{"type":"assistant","message":{"role":"assistant","content": BROKEN`,
		`}`,
		`{"type":"user","message":{"role":"user","content":"坏行里的内容"}},
`,
		`{"type":"user","message":{"role":"user","content":`,
		userLine(now.Format(time.RFC3339), "补一句正常消息"),
	})
	write(t, root, EncodePath(`D:\p`), "sess-bad", content, now)

	res, err := ExportAt(root, "sess-bad", now)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Markdown, "补一句正常消息") {
		t.Errorf("valid line lost:\n%s", res.Markdown)
	}
	// 坏行内容（含 JSON 形态合法但尾逗号破坏的行）不入文档
	if strings.Contains(res.Markdown, "坏行里的内容") || strings.Contains(res.Markdown, "BROKEN") {
		t.Errorf("corrupt line content leaked:\n%s", res.Markdown)
	}
	if !strings.HasPrefix(res.Markdown, "# Claude 会话：补一句正常消息") {
		t.Errorf("title wrong: %.60q", res.Markdown)
	}
}

func TestExportGuardWindowTruncation(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	// 4010 行 > 时间线窗口 4000 行：窗口截断必须如实上报（注记进文档）
	var b strings.Builder
	for i := 0; i < 4010; i++ {
		b.WriteString(userLine(now.Add(-time.Duration(4010-i)*time.Minute).UTC().Format(time.RFC3339), "步骤窗口截断") + "\n")
	}
	write(t, root, EncodePath(`D:\p`), "sess-win", b.String(), now)

	res, err := ExportAt(root, "sess-win", now)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated {
		t.Error("Truncated = false, want true (window cap)")
	}
	if !strings.Contains(res.Markdown, "仅包含最近一段") {
		t.Errorf("window truncation note missing")
	}
}

func TestExportGuardOutputCap(t *testing.T) {
	now := time.Now()
	// 大条目 × 小上限（注入）：到顶止渲染 + 注记；条目保持行完整
	entries := make([]TimelineEntry, 0, 64)
	for i := 0; i < 64; i++ {
		entries = append(entries, TimelineEntry{Kind: "user", Text: strings.Repeat("很长的正文内容", 40)})
	}
	doc, truncated := renderExportMarkdown(entries, "标题", "sess-cap", now, false, 4096)
	if !truncated {
		t.Error("truncated = false, want true (output cap)")
	}
	if !strings.Contains(doc, "内容超过导出大小上限") {
		t.Errorf("output truncation note missing")
	}
	// 无截断路径：小条目 + 大上限不误报
	doc2, truncated2 := renderExportMarkdown(entries[:2], "标题", "sess-cap", now, false, 1<<20)
	if truncated2 {
		t.Error("small doc must not be truncated")
	}
	if strings.Contains(doc2, "内容超过导出大小上限") {
		t.Errorf("spurious truncation note")
	}
	// 窗口注记独立于输出注记
	doc3, _ := renderExportMarkdown(entries[:2], "标题", "sess-cap", now, true, 1<<20)
	if !strings.Contains(doc3, "仅包含最近一段") {
		t.Errorf("window note missing")
	}
}

func TestExportNotFound(t *testing.T) {
	root := t.TempDir()
	if _, err := Export(root, "no-such-session"); err != ErrSessionNotFound {
		t.Errorf("err = %v, want ErrSessionNotFound", err)
	}
	// 目录穿越形态 id 与 LocateSession 同闸：不暴露文件系统布局
	if _, err := Export(root, "../escape"); err != ErrSessionNotFound {
		t.Errorf("traversal id err = %v, want ErrSessionNotFound", err)
	}
}

func TestExportDownloadName(t *testing.T) {
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		title     string
		sessionID string
		wantSub   string   // 文件名必须含
		notWant   []string // 文件名必须不含
	}{
		{
			name:      "普通中英文标题",
			title:     "修复 WebSocket 重连 bug",
			sessionID: "id-1",
			wantSub:   "claude-修复 WebSocket 重连 bug-20261004.md",
		},
		{
			name:      "引号与路径分隔符折叠",
			title:     `a"b/c\d:e*f?g<h>i|j`,
			sessionID: "id-2",
			wantSub:   "claude-a-b-c-d-e-f-g-h-i-j-20261004.md",
			notWant:   []string{`"`, `/`, `\`, `:`, `*`, `?`, `<`, `>`, `|`},
		},
		{
			name:      "CRLF 控制字符折叠",
			title:     "行一\r\n行二\t行三",
			sessionID: "id-3",
			wantSub:   "claude-行一-行二-行三-20261004.md",
			notWant:   []string{"\r", "\n", "\t"},
		},
		{
			name:      "超长标题截断到 40 rune",
			title:     strings.Repeat("长", 80),
			sessionID: "id-4",
			wantSub:   "claude-" + strings.Repeat("长", 40) + "-20261004.md",
		},
		{
			name:      "空标题回退会话 id",
			title:     "   ",
			sessionID: "abc-def",
			wantSub:   "claude-abc-def-20261004.md",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExportDownloadName(tc.title, tc.sessionID, now, "md")
			if !strings.Contains(got, tc.wantSub) {
				t.Errorf("ExportDownloadName = %q, want contains %q", got, tc.wantSub)
			}
			for _, bad := range tc.notWant {
				if strings.Contains(got, bad) {
					t.Errorf("ExportDownloadName = %q, must not contain %q", got, bad)
				}
			}
			if !strings.HasSuffix(got, ".md") || !strings.HasPrefix(got, "claude-") {
				t.Errorf("ExportDownloadName = %q, prefix/suffix wrong", got)
			}
		})
	}
	// 首尾修整：折叠符与点号不得出现在 slug 两端（Windows 段规则）
	got := ExportDownloadName("??标题??", "id-9", now, "md")
	if strings.Contains(got, "claude---") || strings.Contains(got, "-.md") || strings.Contains(got, "..") {
		t.Errorf("edge dashes/dots not trimmed: %q", got)
	}
	// 双格式共用同一套净化/摘要规则，只换扩展名（P-20261003-60）
	if j := ExportDownloadName("??标题??", "id-9", now, "jsonl"); !strings.HasSuffix(j, "标题-20261004.jsonl") {
		t.Errorf("jsonl ext = %q, want .jsonl suffix", j)
	}
}

func TestExportRelativizesProjectRoots(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	// userLine 构造器自带 cwd `D:\p`（= 改写根）；正文/工具输入嵌项目根绝对
	// 路径 + 兄弟目录名前缀 + 非项目路径三形态（口径：仅 root+分隔符形态与
	// 串尾裸 root 改写，root 后随普通字符不命中——见 relpath.go）
	content := joinLines([]string{
		`{"type":"last-prompt","sessionId":"sess-rel"}`,
		// 文本参数须为 JSON 转义形态（userLine 原样拼接进 JSON 串，反斜杠加倍）
		userLine(tsAgo(now, 3), `请看 D:\\p\\docs\\plan.md 并整理`),
		assistantToolLine(tsAgo(now, 2), "toolu_1", "Read", `{"file_path":"D:\\p\\src\\main.go"}`),
		assistantToolLine(tsAgo(now, 2), "toolu_2", "Edit", `{"file_path":"D:\\p-sib\\other.go"}`),
		assistantToolLine(tsAgo(now, 2), "toolu_3", "Bash", `{"command":"type C:\\elsewhere\\cfg.json"}`),
		assistantTextLine(tsAgo(now, 1), `改动集中在 D:\\p\\ws 与 D:\\p\\api 两个包`),
	})
	write(t, root, EncodePath(`D:\p`), "sess-rel", content, now)

	res, err := ExportAt(root, "sess-rel", now)
	if err != nil {
		t.Fatal(err)
	}
	doc := res.Markdown
	// 项目根绝对路径 → 相对形态（用户正文/助手正文/工具输入全形态覆盖）
	for _, want := range []string{`docs\plan.md`, `src\main.go`, `ws 与 api`} {
		if !strings.Contains(doc, want) {
			t.Errorf("doc missing relativized form %q:\n%s", want, doc)
		}
	}
	if strings.Contains(doc, `D:\p\`) {
		t.Errorf("doc still contains project-root prefixed paths:\n%s", doc)
	}
	// 误判面：兄弟目录名前缀与非项目路径原样保留（降级不改写）
	if !strings.Contains(doc, `D:\p-sib\other.go`) {
		t.Errorf("sibling-prefix path must be preserved:\n%s", doc)
	}
	if !strings.Contains(doc, `C:\elsewhere\cfg.json`) {
		t.Errorf("non-project path must be preserved:\n%s", doc)
	}
}

// tsAgo 测试时刻回退 N 分钟（RFC3339，行构造器入参）
func tsAgo(now time.Time, min int) string {
	return now.Add(-time.Duration(min) * time.Minute).UTC().Format(time.RFC3339)
}

func TestExportRaw(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "D--p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 首行是元信息块（不可作标题），标题落在头部窗口内的第二条用户消息——
	// rawHeadTitle 须跳过元信息继续向前找（与列表标题同口径）
	content := "{\"summary\":\"索引行不参与标题\"}\n" +
		`{"type":"user","isSidechain":false,"message":{"content":"<command-name>/e2e</command-name>"},"timestamp":"2026-10-04T10:00:00Z"}` + "\n" +
		`{"type":"user","isSidechain":false,"message":{"content":"原始导出标题验证"},"timestamp":"2026-10-04T10:01:00Z","cwd":"D:\\p"}` + "\n" +
		`{"type":"assistant","message":{"content":[{"type":"text","text":"好"}]},"timestamp":"2026-10-04T10:02:00Z"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "raw-sess.jsonl"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	raw, err := ExportRaw(root, "raw-sess")
	if err != nil {
		t.Fatalf("ExportRaw err = %v", err)
	}
	if raw.Path != filepath.Join(dir, "raw-sess.jsonl") {
		t.Errorf("path = %q", raw.Path)
	}
	if raw.Title != "原始导出标题验证" {
		t.Errorf("title = %q, want first title-worthy user text", raw.Title)
	}
	// 定位不到/越权 id：ErrSessionNotFound（与 md 导出同 404 语义）
	if _, err := ExportRaw(root, "no-such"); err != ErrSessionNotFound {
		t.Errorf("err = %v, want ErrSessionNotFound", err)
	}
	if _, err := ExportRaw(root, "../escape"); err != ErrSessionNotFound {
		t.Errorf("traversal id err = %v, want ErrSessionNotFound", err)
	}
	// 空文件/无有效标题：回退会话 id（下载名仍可用）
	if err := os.WriteFile(filepath.Join(dir, "raw-empty.jsonl"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	raw, err = ExportRaw(root, "raw-empty")
	if err != nil {
		t.Fatalf("ExportRaw(raw-empty) err = %v", err)
	}
	if raw.Title != "raw-empty" {
		t.Errorf("empty title fallback = %q, want session id", raw.Title)
	}
}
