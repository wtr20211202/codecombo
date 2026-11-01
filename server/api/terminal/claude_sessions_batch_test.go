package terminal

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 会话批量导出 zip（P-20261003-165）handler 测试：zip 结构（每会话一条目 +
// MANIFEST）/内容与单会话导出一致（md 渲染与 jsonl 相对化逐字节对齐）/护栏
//（≤50 拒绝、未知 format 400、全落空 404、部分缺失跳过进清单）/审计入账。
// 渲染结构与容错在 claudesessions 包测试，此处不重复

// setupBatchExportTest store 装配（审计断言需要）+ gin 路由 + SC_CLAUDE_DIR 临时根
func setupBatchExportTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	r := gin.New()
	r.POST("/api/claude/sessions/export-archive", BatchExportClaudeSessions)
	return r, root
}

// writeBatchFixture 播种一条会话 transcript（同 claude_sessions_export_test.go
// 的目录编码约定：D:\p → D--p）
func writeBatchFixture(t *testing.T, root, id, userText string) {
	t.Helper()
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

func postBatchExport(r *gin.Engine, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/claude/sessions/export-archive", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

// readZipEntries 极简 zip 解包（archive/zip.Reader 正口径）：条目名 → 未压缩内容
func readZipEntries(t *testing.T, body []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("open zip: %v (head=%q)", err, body[:min(len(body), 60)])
	}
	out := make(map[string]string, len(zr.File))
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open entry %s: %v", f.Name, err)
		}
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(rc); err != nil {
			t.Fatalf("read entry %s: %v", f.Name, err)
		}
		rc.Close() //nolint:errcheck // 测试读句柄
		out[f.Name] = buf.String()
	}
	return out
}

func TestBatchExportZipMD(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "batch-one", "批量导出第一会话")
	writeBatchFixture(t, root, "batch-two", "批量导出第二会话")

	w := postBatchExport(r, `{"ids":["batch-one","batch-two"],"format":"md"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type = %q", ct)
	}
	cd := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd, "attachment") || !strings.Contains(cd, ".zip") {
		t.Errorf("Content-Disposition = %q, want attachment *.zip", cd)
	}

	entries := readZipEntries(t, w.Body.Bytes())
	// 每会话一条目 + MANIFEST，共 3 条
	if len(entries) != 3 {
		t.Fatalf("entries = %d (%v), want 3", len(entries), keysOf(entries))
	}
	// 内容与单会话导出逐字节一致（同一 Export 渲染链的抽样对账）
	var mdName string
	for name, content := range entries {
		if strings.HasSuffix(name, ".md") && strings.Contains(content, "批量导出第一会话") {
			mdName = name
		}
	}
	if mdName == "" {
		t.Fatalf("md entry for batch-one not found in %v", keysOf(entries))
	}
	md := entries[mdName]
	if !strings.HasPrefix(md, "# Claude 会话：批量导出第一会话") {
		t.Errorf("md head = %.40q", md)
	}
	// 单导一致性：与 GET /:id/export 的渲染同链——直接调 Export 对账（两侧
	// 请求时刻可能跨秒，「导出时间」行先剥除再逐字节比）
	direct, err := claudesessions.Export(root, "batch-one")
	if err != nil {
		t.Fatal(err)
	}
	if stripExportTime(md) != stripExportTime(direct.Markdown) {
		t.Errorf("batch md != single export md (%d vs %d bytes)", len(md), len(direct.Markdown))
	}
	// MANIFEST 清单：格式/计数/逐文件行
	mani := entries["MANIFEST.txt"]
	if !strings.Contains(mani, "格式：Markdown") || !strings.Contains(mani, "导出 2 个会话，跳过 0 个") {
		t.Errorf("manifest = %q", mani)
	}
	if !strings.Contains(mani, mdName+"\tbatch-one\t") {
		t.Errorf("manifest missing file line for %s: %q", mdName, mani)
	}

	// 审计：claude.export_batch 一条，明细含 N/M
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditClaudeBatchZip && e.Result == store.AuditResultSuccess &&
			strings.Contains(e.Detail, "batch md 2/2") {
			found = true
		}
	}
	if !found {
		b, _ := json.Marshal(events)
		t.Errorf("audit claude.export_batch missing, events = %s", b)
	}
}

func TestBatchExportZipJSONL(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "batch-raw", "批量原始导出")
	src, err := os.ReadFile(filepath.Join(root, "D--p", "batch-raw.jsonl"))
	if err != nil {
		t.Fatal(err)
	}

	w := postBatchExport(r, `{"ids":["batch-raw"],"format":"jsonl"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	entries := readZipEntries(t, w.Body.Bytes())
	if len(entries) != 2 {
		t.Fatalf("entries = %d (%v), want 2", len(entries), keysOf(entries))
	}
	var jsonl string
	for name, content := range entries {
		if strings.HasSuffix(name, ".jsonl") {
			jsonl = content
		}
	}
	// 内容与单会话 jsonl 导出一致：cwd 相对化改写（D:\p → .）逐字节对齐
	exp := strings.ReplaceAll(string(src), `"cwd":"D:\\p"`, `"cwd":"."`)
	if jsonl != exp {
		t.Errorf("batch jsonl %d bytes != relativized source %d bytes", len(jsonl), len(exp))
	}
	if strings.Contains(jsonl, `D:\\p`) {
		t.Errorf("jsonl still contains project root")
	}
	if !strings.Contains(entries["MANIFEST.txt"], "格式：原始 JSONL") {
		t.Errorf("manifest format line missing: %q", entries["MANIFEST.txt"])
	}
}

// 同题同日的批量高频撞名：条目名以短 id 后缀去重，两条都在包里
func TestBatchExportDuplicateNames(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "dup-aaaaaaaa", "同题会话")
	writeBatchFixture(t, root, "dup-bbbbbbbb", "同题会话")

	w := postBatchExport(r, `{"ids":["dup-aaaaaaaa","dup-bbbbbbbb"],"format":"md"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	entries := readZipEntries(t, w.Body.Bytes())
	mds := 0
	for name := range entries {
		if strings.HasSuffix(name, ".md") {
			mds++
		}
	}
	if mds != 2 {
		t.Errorf("md entries = %d (%v), want 2 deduped names", mds, keysOf(entries))
	}
}

// 部分缺失：定位成功的正常出包，缺失的进 MANIFEST 跳过清单；全部落空 404
// 不出空包（单会话导出同语义）
func TestBatchExportMissingSessions(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "batch-here", "在场的会话")

	w := postBatchExport(r, `{"ids":["batch-here","no-such-1","no-such-2"],"format":"md"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	entries := readZipEntries(t, w.Body.Bytes())
	mani := entries["MANIFEST.txt"]
	if !strings.Contains(mani, "导出 1 个会话，跳过 2 个") {
		t.Errorf("manifest = %q", mani)
	}
	if !strings.Contains(mani, "no-such-1") || !strings.Contains(mani, "no-such-2") {
		t.Errorf("manifest missing skipped ids: %q", mani)
	}
	if !strings.Contains(mani, "batch-here") {
		t.Errorf("manifest missing exported file line: %q", mani)
	}

	// 全落空：404 JSON（zip 头未发出）
	w = postBatchExport(r, `{"ids":["ghost-a","ghost-b"]}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("all-missing status = %d, want 404", w.Code)
	}

	// 缺失会话不算成功导出：审计明细带 skipped 计数
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditClaudeBatchZip && strings.Contains(e.Detail, "batch md 1/3 skipped 2") {
			found = true
		}
	}
	if !found {
		b, _ := json.Marshal(events)
		t.Errorf("audit detail missing skipped count, events = %s", b)
	}
}

// 护栏：>50 拒绝 / 空 ids 400 / 未知 format 400 / 畸形 id 400 / 缺省 format = md
func TestBatchExportGuards(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "batch-def", "缺省格式会话")

	ids := make([]string, 0, 51)
	for i := 0; i < 51; i++ {
		ids = append(ids, fmt.Sprintf("id-%03d-nohlash", i))
	}
	// 拼一个合法形态的 51 id 请求（不含 . / \ 的短 id）
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = `"` + id + `"`
	}
	w := postBatchExport(r, `{"ids":[`+strings.Join(parts, ",")+`]}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("51 ids status = %d, want 400", w.Code)
	}
	if msg := w.Body.String(); !strings.Contains(msg, "too many sessions for batch export (max 50)") {
		t.Errorf("body = %q, want stable max-50 marker", msg)
	}

	w = postBatchExport(r, `{"ids":[]}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty ids status = %d, want 400", w.Code)
	}
	w = postBatchExport(r, `{"ids":["batch-def"],"format":"yaml"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown format status = %d, want 400", w.Code)
	}
	w = postBatchExport(r, `{"ids":["../escape"]}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("malformed id status = %d, want 400", w.Code)
	}
	// 缺省 format = md 主链零回归
	w = postBatchExport(r, `{"ids":["batch-def"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("default format status = %d, want 200", w.Code)
	}
	entries := readZipEntries(t, w.Body.Bytes())
	foundMD := false
	for name, content := range entries {
		if strings.HasSuffix(name, ".md") && strings.Contains(content, "缺省格式会话") {
			foundMD = true
		}
	}
	if !foundMD {
		t.Errorf("default format did not produce md entry: %v", keysOf(entries))
	}
}

// 口令信封加密档（P-20261003-166）：携 passphrase → application/json 信封
// （*.zip.enc.json），解密还原 zip 与明文导出逐字节一致；错口令解不开；明文
// 档位（不携/空口令）零变化由既有各测试覆盖。审计带 enc 标记
func TestBatchExportEncrypted(t *testing.T) {
	r, root := setupBatchExportTest(t)
	// 标题避开「口令加密」字样：防清单比对与注记断言撞上标题文本（误报源）
	writeBatchFixture(t, root, "batch-enc", "信封归档样例会话")

	// 护栏：<8 位口令 400（remotehost 导出同口径稳定标记）
	w := postBatchExport(r, `{"ids":["batch-enc"],"passphrase":"short"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("short passphrase status = %d, want 400", w.Code)
	}
	if msg := w.Body.String(); !strings.Contains(msg, "passphrase too short (min 8)") {
		t.Errorf("body = %q, want stable min-8 marker", msg)
	}

	w = postBatchExport(r, `{"ids":["batch-enc"],"passphrase":"Correct-Horse-9"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("encrypted status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	cd := w.Header().Get("Content-Disposition")
	if !strings.Contains(cd, ".zip.enc.json") {
		t.Errorf("Content-Disposition = %q, want *.zip.enc.json", cd)
	}
	// 响应体绝不能是裸 zip（PK 魔数），必须是信封 JSON
	if strings.HasPrefix(w.Body.String(), "PK") {
		t.Fatalf("encrypted response body starts with zip magic")
	}

	// 同请求明文对照：解密还原包与明文包逐条目一致（同一渲染链的强对账；
	// MANIFEST 的口令加密注记行是唯一预期差异，剥除后对齐）
	plain := postBatchExport(r, `{"ids":["batch-enc"]}`)
	if plain.Code != http.StatusOK {
		t.Fatalf("plaintext status = %d", plain.Code)
	}
	if ct := plain.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("plaintext Content-Type = %q, want application/zip", ct)
	}

	// 信封形态（format 标识）→ 正口令解密 → 还原包条目与明文包一致
	var env config.PassphraseEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil || env.Format != config.EnvelopeFormat {
		t.Fatalf("body is not a passphrase envelope: %v", err)
	}
	decrypted, err := config.DecryptWithPassphrase(w.Body.Bytes(), []byte("Correct-Horse-9"))
	if err != nil {
		t.Fatalf("decrypt with correct passphrase: %v", err)
	}
	decEntries := readZipEntries(t, decrypted)
	plainEntries := readZipEntries(t, plain.Body.Bytes())
	if len(decEntries) != len(plainEntries) {
		t.Fatalf("entry count = %d (%v), want %d (%v)",
			len(decEntries), keysOf(decEntries), len(plainEntries), keysOf(plainEntries))
	}
	for name, content := range plainEntries {
		got, ok := decEntries[name]
		if !ok {
			t.Errorf("entry %q missing in decrypted zip", name)
			continue
		}
		if name == batchManifestName {
			// MANIFEST 剥两行再对齐：口令加密注记（加密包独有，预期差异）与
			// 导出时间（两次请求可能跨秒，时间一致性无断言价值——同 md 对账口径）
			content = stripManifestVolatile(content)
			got = stripManifestVolatile(got)
		}
		if strings.HasSuffix(name, ".md") {
			// md 条目剥导出时间行再对齐（stripExportTime 同款口径）：两次请求
			// 各自携带当下时刻，跨秒即整行差异——WSL /mnt/d 下两次导出间隔常
			// 超 1 秒实测必红（首轮 wsl-verify 抓获），时间一致性无断言价值
			content = stripExportTime(content)
			got = stripExportTime(got)
		}
		if got != content {
			t.Errorf("entry %q differs between decrypted and plaintext export", name)
		}
	}
	// 明文包 MANIFEST 绝不能带加密注记（档位注记如实）
	if strings.Contains(plainEntries[batchManifestName], "口令加密：已启用") {
		t.Errorf("plaintext manifest wrongly claims encryption: %q", plainEntries[batchManifestName])
	}

	// 还原包结构：md 条目 + MANIFEST（含口令加密注记）
	entries := readZipEntries(t, decrypted)
	if len(entries) != 2 {
		t.Fatalf("entries = %d (%v), want 2", len(entries), keysOf(entries))
	}
	if !strings.Contains(entries["MANIFEST.txt"], "口令加密：已启用") {
		t.Errorf("manifest missing encryption note: %q", entries["MANIFEST.txt"])
	}

	// 错口令：解不开且不区分原因（P-29 同语义）
	if _, err := config.DecryptWithPassphrase(w.Body.Bytes(), []byte("Wrong-Passphrase-1")); err == nil {
		t.Errorf("decrypt with wrong passphrase unexpectedly succeeded")
	}

	// 审计：enc 标记入账（口令本身绝不入账）
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditClaudeBatchZip && strings.Contains(e.Detail, "batch md 1/1 enc") {
			found = true
			if strings.Contains(e.Detail, "Correct-Horse-9") {
				t.Errorf("audit detail contains passphrase: %q", e.Detail)
			}
		}
	}
	if !found {
		b, _ := json.Marshal(events)
		t.Errorf("audit enc detail missing, events = %s", b)
	}
}

// 批量导出排除隐藏会话（P-20261003-237）：策展隐藏的 id 不打包——混合批量出包
// 只含可见会话，隐藏 id 进 MANIFEST 已隐藏清单（与缺失分节）且内容零泄漏；
// 全隐藏 404 不出空包（与全落空同语义）；审计 hidden 计数与 skipped 分列。
// 深链单导不拦（知情边界）不在此测：单导主链对 hidden 零感知（本测试的隐藏
// id 经 GET /:id/export 仍可达，由 session-batch-export e2e 面上断言）
func TestBatchExportSkipsHiddenSessions(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "bh-visible", "在场的可见会话")
	writeBatchFixture(t, root, "bh-hidden1", "被隐藏的会话甲")
	writeBatchFixture(t, root, "bh-hidden2", "被隐藏的会话乙")
	hideCur := func(id string) {
		t.Helper()
		if err := store.Get().ClaudeCur.Put(store.ClaudeSessionCur{
			Key:       store.ClaudeCurKey(root, id),
			ID:        id,
			Hidden:    true,
			UpdatedAt: time.Now(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	hideCur("bh-hidden1")
	hideCur("bh-hidden2")

	// 混合批量：1 可见 + 2 隐藏 → 200 出包，隐藏的进已隐藏清单
	w := postBatchExport(r, `{"ids":["bh-visible","bh-hidden1","bh-hidden2"],"format":"md"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	entries := readZipEntries(t, w.Body.Bytes())
	if len(entries) != 2 { // 1 md + MANIFEST
		t.Fatalf("entries = %d (%v), want 2", len(entries), keysOf(entries))
	}
	mani := entries["MANIFEST.txt"]
	// 汇总行跳过数 = 缺失 + 隐藏（分节列原因）；隐藏节带 id
	if !strings.Contains(mani, "导出 1 个会话，跳过 2 个") {
		t.Errorf("manifest summary = %q", mani)
	}
	if !strings.Contains(mani, "已隐藏") || !strings.Contains(mani, "bh-hidden1") || !strings.Contains(mani, "bh-hidden2") {
		t.Errorf("manifest missing hidden section: %q", mani)
	}
	// 隐藏会话内容零泄漏（md 条目正文与清单已导出段都不含）
	for name, content := range entries {
		if name != batchManifestName && strings.Contains(content, "bh-hidden") {
			t.Errorf("hidden session leaked into entry %q", name)
		}
	}
	if strings.Contains(mani, "bh-hidden1\t") {
		t.Errorf("hidden session listed as exported: %q", mani)
	}

	// 全隐藏 → 404（不出空包，头未发出）
	w = postBatchExport(r, `{"ids":["bh-hidden1","bh-hidden2"]}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("all-hidden status = %d, want 404", w.Code)
	}

	// 审计明细：hidden 计数与 skipped 分列（策略与异常不混记）
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditClaudeBatchZip && strings.Contains(e.Detail, "batch md 1/3 hidden 2") {
			found = true
		}
	}
	if !found {
		b, _ := json.Marshal(events)
		t.Errorf("audit hidden detail missing, events = %s", b)
	}
}

// --- helpers ---

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// stripExportTime 剥「- 导出时间：…」行：批量与单导两次渲染时刻可能跨秒，
// 该行差异不是内容差异（时间一致性无断言价值）
func stripExportTime(md string) string {
	var b strings.Builder
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "- 导出时间：") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

// stripManifestVolatile 剥 MANIFEST 的易变行（导出时间跨秒 + 口令加密注记仅
// 加密包持有）：剩余部分两档位必须一致
func stripManifestVolatile(m string) string {
	var b strings.Builder
	for _, line := range strings.Split(m, "\n") {
		if strings.HasPrefix(line, "导出时间：") || strings.HasPrefix(line, "口令加密：") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}
