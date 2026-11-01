package terminal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/store"
)

// 会话批量导出内容敏感闸（P-20261003-225）handler 级单测：批量此前完全绕过
// 单导的出域闸（P-20261004-113），本组用例锁定同族接入后的契约——
//   - md/jsonl：命中且未确认 → 200 JSON {warnings, sensitiveHits}（无附件头、
//     无原文、无会话归因、零审计）；
//   - confirm=1 → 同一 zip 完整无遮蔽 + 审计 Detail 追加类型计数；
//   - 零命中直出与无命中时审计 Detail 逐字节不变由既有
//     TestBatchExportClaudeSessions* 全绿覆盖（存量断言零回归）。

const batchGateSecret = "ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"

func postBatchExportQuery(r interface {
	ServeHTTP(http.ResponseWriter, *http.Request)
}, body, query string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	url := "/api/claude/sessions/export-archive"
	if query != "" {
		url += "?" + query
	}
	req := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func batchGateAuditDetails(t *testing.T) []string {
	t.Helper()
	events, _, err := store.Get().Audit.List(50, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range events {
		if e.Action == store.AuditClaudeBatchZip {
			out = append(out, e.Detail)
		}
	}
	return out
}

func TestBatchExportClaudeSessions_SensitiveGateMD(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "bgate-clean", "干净的普通会话")
	writeBatchFixture(t, root, "bgate-hot", "调试凭据 "+batchGateSecret)

	// 第一跳：未确认 → 200 JSON 警示（跨会话聚合成同一份类型计数），
	// 零附件头、零原文、零审计
	w := postBatchExportQuery(r, `{"ids":["bgate-clean","bgate-hot"]}`, "")
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
	if gateHitTypes(resp)["known-token"] == 0 {
		t.Fatalf("sensitiveHits missing known-token: %v", resp.SensitiveHits)
	}
	if strings.Contains(w.Body.String(), batchGateSecret) {
		t.Fatal("gate response must never contain the secret value")
	}
	if n := len(batchGateAuditDetails(t)); n != 0 {
		t.Fatalf("gated hop must not audit, got %d events", n)
	}

	// 第二跳：confirm=1（查询串，单导同参数位）→ 同一批 zip 完整无遮蔽
	w2 := postBatchExportQuery(r, `{"ids":["bgate-clean","bgate-hot"]}`, "confirm=1")
	if w2.Code != http.StatusOK {
		t.Fatalf("confirmed status = %d, want 200", w2.Code)
	}
	if cd := w2.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Fatalf("confirmed Content-Disposition = %q, want attachment", cd)
	}
	entries := readZipEntries(t, w2.Body.Bytes())
	if len(entries) != 3 { // 2 md + MANIFEST
		t.Fatalf("zip entries = %d, want 3", len(entries))
	}
	hotMd := ""
	for name, content := range entries {
		// 只对 md 正文断言原文在场（MANIFEST 的标题列合法携带标题——fixture 的
		// secret 在首条 user 消息里即成标题；闸响应不含原文的断言在上面已锁）
		if strings.HasSuffix(name, ".md") && strings.Contains(content, batchGateSecret) {
			hotMd = content
		}
	}
	if hotMd == "" {
		t.Fatal("confirmed zip must contain the secret verbatim (原样保真)")
	}
	details := batchGateAuditDetails(t)
	if len(details) != 1 {
		t.Fatalf("release audit events = %d, want 1", len(details))
	}
	if !strings.Contains(details[0], "batch md 2/2") || !strings.Contains(details[0], "sensitive:known-token") {
		t.Fatalf("release audit detail = %q, want batch md 2/2 + sensitive suffix", details[0])
	}
}

func TestBatchExportClaudeSessions_SensitiveGateJSONL(t *testing.T) {
	r, root := setupBatchExportTest(t)
	writeBatchFixture(t, root, "bgate-raw", "原始导出 "+batchGateSecret)

	// jsonl 预扫挂点在相对化改写链下游（与单导 scanJSONLExport 同一实现）：
	// 命中且未确认回 JSON 警示；确认后出相对化改写后的全文
	w := postBatchExportQuery(r, `{"ids":["bgate-raw"],"format":"jsonl"}`, "")
	if w.Code != http.StatusOK {
		t.Fatalf("gated status = %d, want 200", w.Code)
	}
	resp := decodeGateResp(t, w.Body.Bytes())
	if len(resp.Warnings) != 1 || resp.Warnings[0] != "sensitive-content" {
		t.Fatalf("warnings = %v, want [sensitive-content]", resp.Warnings)
	}
	if strings.Contains(w.Body.String(), batchGateSecret) {
		t.Fatal("gate response must never contain the secret value")
	}

	w2 := postBatchExportQuery(r, `{"ids":["bgate-raw"],"format":"jsonl"}`, "confirm=1")
	if w2.Code != http.StatusOK {
		t.Fatalf("confirmed status = %d, want 200", w2.Code)
	}
	entries := readZipEntries(t, w2.Body.Bytes())
	if len(entries) != 2 { // 1 jsonl + MANIFEST
		t.Fatalf("zip entries = %d, want 2", len(entries))
	}
	raw := ""
	for name, content := range entries {
		if strings.HasSuffix(name, ".jsonl") {
			raw = content
		}
	}
	if !strings.Contains(raw, batchGateSecret) {
		t.Fatal("confirmed jsonl must contain the secret verbatim")
	}
	// 扫描在改写下游，出域字节仍相对化（主机布局不出域）
	if !strings.Contains(raw, `"cwd":"."`) || strings.Contains(raw, "D:\\\\p") {
		t.Fatalf("confirmed jsonl must stay relativized, got: %s", raw)
	}
	if d := batchGateAuditDetails(t); len(d) != 1 || !strings.Contains(d[0], "batch jsonl 1/1") {
		t.Fatalf("release audit details = %v, want batch jsonl 1/1 + suffix", d)
	}
}
