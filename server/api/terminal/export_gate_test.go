package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/sensitive"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 导出族内容敏感闸的三面共用 helper（P-20261004-113）：响应形态（warnings +
// 类型计数 / 零附件头）、confirm=1 二段确认、与会话标记闸的合并、审计后缀。
// 终端 txt 面的真实 PTY 链路另见 TestTerminalExport_ContentGate。

func gateContext(t *testing.T, target string) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, target, nil)
	return c, w
}

func TestExportSensitiveGate_ShapeAndConfirm(t *testing.T) {
	hits := []sensitive.Hit{{Type: sensitive.HitKnownToken, Count: 2}, {Type: sensitive.HitPrivateKey, Count: 1}}

	// 未确认：JSON warnings + 类型计数，零附件头（原文本就未进 hits，结构上无原文）
	c, w := gateContext(t, "/api/terminals/x/export")
	if !exportSensitiveGate(c, hits) {
		t.Fatal("unconfirmed content hits must be gated")
	}
	resp := decodeGateResp(t, w.Body.Bytes())
	if len(resp.Warnings) != 1 || resp.Warnings[0] != shared.SensitiveContentWarning {
		t.Fatalf("warnings = %v", resp.Warnings)
	}
	if len(resp.SensitiveHits) != 2 || resp.SensitiveHits[0].Type != sensitive.HitKnownToken || resp.SensitiveHits[1].Count != 1 {
		t.Fatalf("sensitiveHits = %+v", resp.SensitiveHits)
	}
	if cd := w.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("gate response must not be an attachment, got %q", cd)
	}

	// confirm=1 且无其他闸门：放行（不写响应体）
	c, w = gateContext(t, "/api/terminals/x/export?confirm=1")
	if exportSensitiveGate(c, hits) {
		t.Fatal("confirm=1 must release the content gate")
	}
	if w.Body.Len() != 0 {
		t.Fatalf("released gate wrote a body: %s", w.Body.String())
	}

	// 与会话标记闸合并：两个 token 同响应，一次确认覆盖两条闸
	c, w = gateContext(t, "/api/terminals/x/export")
	if !exportSensitiveGate(c, hits, shared.SensitiveSessionWarning) {
		t.Fatal("session warning must gate")
	}
	resp = decodeGateResp(t, w.Body.Bytes())
	if len(resp.Warnings) != 2 || resp.Warnings[0] != shared.SensitiveSessionWarning ||
		resp.Warnings[1] != shared.SensitiveContentWarning {
		t.Fatalf("merged warnings = %v", resp.Warnings)
	}

	// 内容已确认但标记闸未确认：仍拦，warnings 只剩会话 token（命中明细仍回告）
	c, w = gateContext(t, "/api/terminals/x/export?confirm=1")
	if !exportSensitiveGate(c, hits, shared.SensitiveSessionWarning) {
		t.Fatal("unconfirmed session marker must still gate")
	}
	resp = decodeGateResp(t, w.Body.Bytes())
	if len(resp.Warnings) != 1 || resp.Warnings[0] != shared.SensitiveSessionWarning {
		t.Fatalf("warnings = %v", resp.Warnings)
	}
	if len(resp.SensitiveHits) != 2 {
		t.Fatalf("sensitiveHits = %+v, want hit metadata on merged response", resp.SensitiveHits)
	}

	// 无命中零打扰：不写响应体
	c, w = gateContext(t, "/api/terminals/x/export")
	if exportSensitiveGate(c, nil) {
		t.Fatal("no hits must not gate")
	}
	if w.Body.Len() != 0 {
		t.Fatalf("no-hit gate wrote a body: %s", w.Body.String())
	}

	// 审计后缀：无命中为空串（既有 Detail 逐字节不变）；有命中只含类型/计数
	if got := sensitiveAuditSuffix(nil); got != "" {
		t.Fatalf("empty suffix = %q", got)
	}
	if got := sensitiveAuditSuffix(hits); got != " sensitive:known-token×2, private-key×1" {
		t.Fatalf("suffix = %q", got)
	}
}

// TestTerminalExport_ContentGate 终端输出导出的真实链路：scrollback 命中
// 凭据形态 → 首跳 JSON warnings；confirm=1 → 附件全文；与会话标记闸并存时
// 两条 token 合并、双参数一次放行。PTY 不可用/回显超时按环境跳过（既有
// terminal_sensitive_test 同惯例）
func TestTerminalExport_ContentGate(t *testing.T) {
	r := setupSensitiveTest(t)
	s, err := terminal.DefaultManager.CreateSession("exp-content-1", "exp-content", t.TempDir(), "", false)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(s.ID) })
	id := s.ID

	const secret = "ghp_z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2"
	if err := s.WriteInput([]byte("echo " + secret + "\r")); err != nil {
		t.Skipf("pty write unavailable: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var echoed string
	for time.Now().Before(deadline) {
		if b, err := s.ExportText(); err == nil {
			echoed = string(b)
			if strings.Contains(echoed, secret) {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !strings.Contains(echoed, secret) {
		t.Skip("shell did not echo the test token in time")
	}

	// 首跳：JSON warnings（类型计数，不含原文）
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") != "" {
		t.Fatalf("gated export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	var resp struct {
		Warnings      []string `json:"warnings"`
		SensitiveHits []struct {
			Type  string `json:"type"`
			Count int    `json:"count"`
		} `json:"sensitiveHits"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("gate body not JSON: %v (%s)", err, w.Body.String())
	}
	if len(resp.Warnings) != 1 || resp.Warnings[0] != shared.SensitiveContentWarning {
		t.Fatalf("warnings = %v", resp.Warnings)
	}
	found := false
	for _, h := range resp.SensitiveHits {
		if h.Type == sensitive.HitKnownToken && h.Count >= 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("sensitiveHits = %+v, want known-token", resp.SensitiveHits)
	}
	if strings.Contains(w.Body.String(), secret) {
		t.Fatal("gate response leaked the credential value")
	}

	// confirm=1：附件全文（原文保留）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export?confirm=1", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("confirmed export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	if !strings.Contains(w.Body.String(), secret) {
		t.Fatal("confirmed export lost the original output")
	}

	// 标记敏感后：两条闸合并 warnings；override=1&confirm=1 一次放行
	if code, body := postSensitive(t, r, id, `{"sensitive":true}`); code != http.StatusOK {
		t.Fatalf("mark status = %d, body = %s", code, body)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") != "" {
		t.Fatalf("merged gate: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	var merged struct {
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &merged); err != nil {
		t.Fatalf("merged gate body not JSON: %v", err)
	}
	if len(merged.Warnings) != 2 || merged.Warnings[0] != shared.SensitiveSessionWarning ||
		merged.Warnings[1] != shared.SensitiveContentWarning {
		t.Fatalf("merged warnings = %v", merged.Warnings)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/"+id+"/export?override=1&confirm=1", nil))
	if w.Code != http.StatusOK || w.Header().Get("Content-Disposition") == "" {
		t.Fatalf("double-confirmed export: status=%d disp=%q", w.Code, w.Header().Get("Content-Disposition"))
	}
	if !strings.Contains(w.Body.String(), secret) {
		t.Fatal("double-confirmed export lost the original output")
	}
}
