package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 会话导出端点（P-20261003-44）handler 测试：200 全链（markdown 头 + 净化的
// Content-Disposition + 审计入账）/ 404 不存在 / 头净化 helper 的敌意输入面。
// 渲染结构/容错/护栏在 claudesessions 包（export_test.go），此处不重复

// setupExportTest store 装配（审计断言需要）+ gin 路由 + SC_CLAUDE_DIR 临时根
func setupExportTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	r := gin.New()
	r.GET("/api/claude/sessions/:id/export", GetClaudeSessionExport)
	return r, root
}

func writeExportFixture(t *testing.T, root, id, userText string) {
	t.Helper()
	// 目录名按 claude 存储编码规则（分隔符/盘符冒号 → '-'）：D:\p → D--p
	dir := filepath.Join(root, "D--p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	line := `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"` +
		userText + `"},"timestamp":"` + ts + `","cwd":"D:\\p"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGetClaudeSessionExportOK(t *testing.T) {
	r, root := setupExportTest(t)
	writeExportFixture(t, root, "sess-http", "导出链路验证会话")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-http/export", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "text/markdown") {
		t.Errorf("Content-Type = %q", ct)
	}
	// 下载头：非 ASCII 标题走 RFC 5987 filename* 形式（shared 统一净化 helper
	// 产出，P-20261003-109 收编包内私有实现）；charset 大小写不敏感，helper
	// 产出大写 UTF-8''（与全站下载端点双形式口径一致），按小写对账
	cd := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd, "attachment") {
		t.Errorf("Content-Disposition = %q, want attachment prefix", cd)
	}
	if !strings.Contains(strings.ToLower(cd), "filename*=utf-8''") {
		t.Errorf("Content-Disposition = %q, want RFC 5987 filename* form", cd)
	}
	if !strings.Contains(cd, "claude-") || !strings.Contains(cd, ".md") {
		t.Errorf("Content-Disposition = %q, want claude-*.md name", cd)
	}
	if !strings.HasPrefix(w.Body.String(), "# Claude 会话：导出链路验证会话") {
		t.Errorf("body = %.60q", w.Body.String())
	}
	// 审计入账（修正项 2）：claude.export 成功事件，detail = 会话 id（内容不入账）
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditClaudeExport && e.Result == store.AuditResultSuccess && e.Detail == "sess-http" {
			found = true
		}
	}
	if !found {
		b, _ := json.Marshal(events)
		t.Errorf("audit event claude.export missing, events = %s", b)
	}
}

func TestGetClaudeSessionExportNotFound(t *testing.T) {
	r, _ := setupExportTest(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/no-such/export", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	// jsonl 分支同 404 语义（双格式共用错误出口）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/no-such/export?format=jsonl", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("jsonl status = %d, want 404", w.Code)
	}
}

// 原始 JSONL 导出（P-20261003-60 + P-20261003-113 相对化）：ndjson 头 +
// .jsonl 附件名 + 响应 = 源 transcript 按 cwd 相对化改写后的字节（除改写段外
// 逐字节保留，结构无损）+ 审计入账；未知 format 400 拒绝
func TestGetClaudeSessionExportJSONL(t *testing.T) {
	r, root := setupExportTest(t)
	writeExportFixture(t, root, "sess-raw", "原始导出验证会话")
	src := filepath.Join(root, "D--p", "sess-raw.jsonl")
	want, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-raw/export?format=jsonl", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/x-ndjson" {
		t.Errorf("Content-Type = %q, want application/x-ndjson", ct)
	}
	cd := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd, "attachment") || !strings.Contains(cd, ".jsonl") {
		t.Errorf("Content-Disposition = %q, want attachment .jsonl name", cd)
	}
	// P-20261003-113 出域相对化：cwd 字段值 D:\p → .（主机布局不出域），其余
	// 字节（元信息行、换行、正文）逐字节保留
	exp := strings.ReplaceAll(string(want), `"cwd":"D:\\p"`, `"cwd":"."`)
	if got := w.Body.String(); got != exp {
		t.Errorf("body %d bytes != relativized source %d bytes:\n%q", len(got), len(exp), got)
	}
	if strings.Contains(w.Body.String(), `D:\\p`) {
		t.Errorf("body still contains project root (escaped form)")
	}
	if !strings.Contains(w.Body.String(), "原始导出验证会话") {
		t.Errorf("body missing raw user text")
	}
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditClaudeExport && e.Result == store.AuditResultSuccess && e.Detail == "sess-raw" {
			found = true
		}
	}
	if !found {
		b, _ := json.Marshal(events)
		t.Errorf("audit event claude.export missing for jsonl, events = %s", b)
	}

	// 未知 format：400 明确拒绝（不静默回落 md）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-raw/export?format=yaml", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown format status = %d, want 400", w.Code)
	}
	// 缺省 = md 主链零回归
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-raw/export", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Content-Type"), "text/markdown") {
		t.Fatalf("default format = %d/%q, want 200 markdown", w.Code, w.Header().Get("Content-Type"))
	}
}

// cwd 未知的降级路径（P-20261003-113）：transcript 头部窗口无 cwd 字段 →
// Root 为空 → 原样直传（出域不因改写锚点缺失而失败，ServeContent 语义保留）
func TestGetClaudeSessionExportJSONLNoRoot(t *testing.T) {
	r, root := setupExportTest(t)
	dir := filepath.Join(root, "D--p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	line := `{"type":"user","message":{"role":"user","content":"无 cwd 的会话"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "sess-noroot.jsonl"), []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-noroot/export?format=jsonl", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Body.String(); got != line {
		t.Errorf("body = %q, want raw passthrough %q", got, line)
	}
}

// 仅问答档 handler 面（P-20261004-132）：mode=qa → 过滤档正文（无工具噪声）+
// -qa 尾缀下载名 + 审计同链；mode 协议面校验——未知值 400、jsonl+mode=qa 400
// （jsonl 无渲染面，mode 语义不成立不静默忽略）
func TestGetClaudeSessionExportQAMode(t *testing.T) {
	r, root := setupExportTest(t)
	// fixture：user → assistant(思考+正文+工具) → 工具结果 → 第二回合
	//（writeExportFixture 只有单 user 行，带工具行的 fixture 就地写）
	dir := filepath.Join(root, "D--p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	lines := []string{
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"问答档验证"},` +
			`"timestamp":"` + ts + `","cwd":"D:\\p"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[` +
			`{"type":"thinking","thinking":"草稿噪声"},{"type":"text","text":"结论在此"},` +
			`{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"grep -rn secret"}}]},` +
			`"timestamp":"` + ts + `"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1",` +
			`"content":[{"type":"text","text":"结果噪声"}]}]},"timestamp":"` + ts + `"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"收尾答复"}]},` +
			`"timestamp":"` + ts + `"}`,
	}
	if err := os.WriteFile(filepath.Join(dir, "sess-qa-http.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-qa-http/export?mode=qa", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("qa status = %d, want 200", w.Code)
	}
	body := w.Body.String()
	for _, noise := range []string{"🔧", "↳", "💭", "grep -rn secret", "结果噪声", "草稿噪声"} {
		if strings.Contains(body, noise) {
			t.Errorf("qa body contains noise %q:\n%s", noise, body)
		}
	}
	for _, want := range []string{"# Claude 会话：问答档验证", "- 会话 ID：`sess-qa-http`", "结论在此", "收尾答复"} {
		if !strings.Contains(body, want) {
			t.Errorf("qa body missing %q:\n%s", want, body)
		}
	}
	// 下载名：-qa 尾缀在扩展名前
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "-qa.md") {
		t.Errorf("Content-Disposition = %q, want -qa.md suffix", cd)
	}
	// 审计同链（出域记账与档位无关，detail = 会话 id）
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditClaudeExport && e.Result == store.AuditResultSuccess && e.Detail == "sess-qa-http" {
			found = true
		}
	}
	if !found {
		t.Errorf("audit event claude.export missing for qa mode, events = %d", len(events))
	}

	// 未知 mode：400 明确拒绝（与未知 format 同款不静默回落）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-qa-http/export?mode=brief", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown mode status = %d, want 400", w.Code)
	}
	// jsonl 无渲染面：mode=qa 语义不成立，400（不静默忽略出原始档）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-qa-http/export?format=jsonl&mode=qa", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("jsonl+qa status = %d, want 400", w.Code)
	}
	// mode=full 显式完整档：零回归（与缺省同链）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-qa-http/export?mode=full", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("full status = %d, want 200", w.Code)
	}
	if body := w.Body.String(); !strings.Contains(body, "🔧") {
		t.Errorf("full body missing tool line (mode=full must equal default):\n%s", body)
	}
	if cd := w.Header().Get("Content-Disposition"); strings.Contains(cd, "-qa.md") {
		t.Errorf("full Content-Disposition = %q, must not carry -qa suffix", cd)
	}
}

func TestContentDispositionAttachment(t *testing.T) {
	// P-20261003-109：净化 helper 收编为 shared.ContentDispositionFile（RFC 6266
	// 双形式：filename 兜底 + filename* 承载真实名），本表保留端点侧敌意输入
	// 面与下载名形态回归；全量边界用例在 shared 包 contentdisposition_test.go
	cases := []struct {
		name    string
		in      string
		wantSub []string
		notWant []string
	}{
		{
			// 双形式：纯 ASCII token 名在兜底与扩展值中均原样出现
			name:    "ASCII token 名",
			in:      "claude-plain-20261004.md",
			wantSub: []string{`filename="claude-plain-20261004.md"`, `filename*=UTF-8''claude-plain-20261004.md`},
		},
		{
			name:    "非 ASCII 名走 RFC 5987 编码",
			in:      "claude-修复-20261004.md",
			wantSub: []string{"filename*=UTF-8''"},
		},
		{
			// 核心安全性质：CR/LF 剥除后响应头注入不成形（残留字符只是
			// 下载文件名的一部分，整体仍是单个合法头值）
			name:    "CRLF 注入被剥除",
			in:      "claude-x\r\nX-Injected: 1\r\n-y.md",
			notWant: []string{"\r", "\n"},
		},
		{
			name:    "引号反斜杠剥除（quoted-string 破坏面）",
			in:      `claude-"quote"\path.md`,
			wantSub: []string{`filename="claude-quotepath.md"`},
			notWant: []string{`\`},
		},
		{
			name:    "含空格名兜底 quoted-string + filename* 转义",
			in:      "claude-a b.md",
			wantSub: []string{`filename="claude-a b.md"`, `filename*=UTF-8''claude-a%20b.md`},
		},
		{
			name:    "全净空名回退裸 attachment",
			in:      "\r\n\r\n",
			wantSub: []string{"attachment"},
			notWant: []string{"\r", "\n"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shared.ContentDispositionFile(tc.in)
			if !strings.HasPrefix(got, "attachment") {
				t.Errorf("value = %q, want attachment prefix", got)
			}
			for _, want := range tc.wantSub {
				if !strings.Contains(got, want) {
					t.Errorf("value = %q, want contains %q", got, want)
				}
			}
			for _, bad := range tc.notWant {
				if strings.Contains(got, bad) {
					t.Errorf("value = %q, must not contain %q", got, bad)
				}
			}
		})
	}
}
