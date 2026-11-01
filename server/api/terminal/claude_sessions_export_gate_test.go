package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/store"
)

// 会话导出内容敏感闸（P-20261004-113）handler 级单测：
//   - md：命中且未确认 → 200 JSON {warnings, sensitiveHits}（无附件头、无
//     原文）；confirm=1 → 同一份 Markdown 全文完整无遮蔽 + 审计 Detail 追
//     加类型计数；警示分支零审计；
//   - jsonl：扫描在相对化改写链下游（命中后确认出域 = 改写后全文，仍不含
//     主机路径前缀）；无 confirm 同样回 JSON 警示；
//   - 无敏感路径由既有 TestGetClaudeSessionExportOK / ...JSONL 覆盖（零回归）。

type exportGateResp struct {
	Warnings      []string `json:"warnings"`
	SensitiveHits []struct {
		Type  string `json:"type"`
		Count int    `json:"count"`
	} `json:"sensitiveHits"`
}

func decodeGateResp(t *testing.T, body []byte) exportGateResp {
	t.Helper()
	var out exportGateResp
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("gate response not JSON: %v (%s)", err, body)
	}
	return out
}

func gateHitTypes(resp exportGateResp) map[string]int {
	m := make(map[string]int, len(resp.SensitiveHits))
	for _, h := range resp.SensitiveHits {
		m[h.Type] += h.Count
	}
	return m
}

func auditDetails(t *testing.T) []string {
	t.Helper()
	events, _, err := store.Get().Audit.List(50, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range events {
		if e.Action == store.AuditClaudeExport {
			out = append(out, e.Detail)
		}
	}
	return out
}

func TestGetClaudeSessionExport_SensitiveGateMD(t *testing.T) {
	r, root := setupExportTest(t)
	const secret = "ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"
	writeExportFixture(t, root, "sess-gate-md", "调试凭据 "+secret+" 与 .env 配置")

	// 第一跳：未确认 → JSON warnings + 类型计数，零附件头、零原文、零审计
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-gate-md/export", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("gated status = %d, want 200", w.Code)
	}
	if cd := w.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("gated response must not be an attachment, Content-Disposition = %q", cd)
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("gated Content-Type = %q, want JSON negotiation", ct)
	}
	resp := decodeGateResp(t, w.Body.Bytes())
	if len(resp.Warnings) != 1 || resp.Warnings[0] != "sensitive-content" {
		t.Fatalf("warnings = %v, want [sensitive-content]", resp.Warnings)
	}
	types := gateHitTypes(resp)
	if types["known-token"] < 1 || types["sensitive-file-name"] < 1 {
		t.Fatalf("sensitiveHits = %+v, want known-token + sensitive-file-name", resp.SensitiveHits)
	}
	if strings.Contains(w.Body.String(), secret) {
		t.Fatal("gate response leaked the credential value")
	}
	if got := auditDetails(t); len(got) != 0 {
		t.Fatalf("warning branch must not audit egress, got %v", got)
	}

	// 第二跳：confirm=1 → 全文原样保真（不遮蔽），审计 Detail 追加类型计数
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-gate-md/export?confirm=1", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("confirmed status = %d", w.Code)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Fatalf("confirmed Content-Disposition = %q", cd)
	}
	md := w.Body.String()
	if !strings.Contains(md, secret) {
		t.Fatal("confirmed export must keep the full content (no masking)")
	}
	if !strings.Contains(md, ".env") {
		t.Fatal("confirmed export lost filename-level content")
	}
	details := auditDetails(t)
	if len(details) != 1 || !strings.HasPrefix(details[0], "sess-gate-md sensitive:") {
		t.Fatalf("audit details = %v, want one with sensitive type suffix", details)
	}
	if !strings.Contains(details[0], "known-token") || !strings.Contains(details[0], "sensitive-file-name") {
		t.Fatalf("audit detail = %q, want hit types", details[0])
	}
	if strings.Contains(details[0], secret) {
		t.Fatal("audit detail leaked the credential value")
	}
}

func TestGetClaudeSessionExport_SensitiveGateJSONL(t *testing.T) {
	r, root := setupExportTest(t)
	const secret = "sk-proj-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"
	writeExportFixture(t, root, "sess-gate-jsonl", "原始导出凭据 "+secret)

	// 第一跳：JSON warnings，零附件、零原文
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-gate-jsonl/export?format=jsonl", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("gated status = %d", w.Code)
	}
	if cd := w.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("gated jsonl must not be an attachment, got %q", cd)
	}
	resp := decodeGateResp(t, w.Body.Bytes())
	if len(resp.Warnings) != 1 || resp.Warnings[0] != "sensitive-content" {
		t.Fatalf("warnings = %v", resp.Warnings)
	}
	if gateHitTypes(resp)["known-token"] < 1 {
		t.Fatalf("sensitiveHits = %+v, want known-token", resp.SensitiveHits)
	}
	if strings.Contains(w.Body.String(), secret) {
		t.Fatal("gate response leaked the credential value")
	}

	// 第二跳：confirm=1 → 相对化改写后的全文（下发字节 = 无闸路径同源改写，
	// 扫描没有改写出域内容），原文保留
	srcBytes, err := os.ReadFile(filepath.Join(root, "D--p", "sess-gate-jsonl.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(srcBytes)
	want := strings.ReplaceAll(src, `"cwd":"D:\\p"`, `"cwd":"."`)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions/sess-gate-jsonl/export?format=jsonl&confirm=1", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("confirmed status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/x-ndjson" {
		t.Fatalf("confirmed Content-Type = %q", ct)
	}
	if got := w.Body.String(); got != want {
		t.Fatalf("confirmed jsonl bytes != relativized source:\n got %q\nwant %q", got, want)
	}
	if !strings.Contains(w.Body.String(), secret) {
		t.Fatal("confirmed jsonl lost the original content")
	}
	details := auditDetails(t)
	if len(details) != 1 || !strings.HasPrefix(details[0], "sess-gate-jsonl sensitive:") {
		t.Fatalf("audit details = %v", details)
	}
}
