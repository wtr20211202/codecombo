package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"codecombo/server/store"
)

// TestAgentGuard_FullyAllowedMode 完全允许模式：高危操作不再建审批直接放行，
// 且不留审批记录（改回每次询问在设置页）
func TestAgentGuard_FullyAllowedMode(t *testing.T) {
	r, at := setupGuard(t, true)
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentApprovalMode = "allow"
	// Settings.Get() 在文档缺失时回落 config.Load() 包级单例——不恢复会把
	// allow 模式泄漏给同包后续用例
	t.Cleanup(func() { cfg.Server.AgentApprovalMode = "" })

	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("allow mode status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	list, _ := store.Get().AgentApproval.List("", 0)
	if len(list) != 0 {
		t.Fatalf("expect no approval records, got %d", len(list))
	}
}

// TestAgentApproval_CarriesAgentRuntime 审批记录回填发起方智能体类型
// （X-Session-ID 反查会话运行时，审批卡片展示用）
func TestAgentApproval_CarriesAgentRuntime(t *testing.T) {
	r, at := setupGuard(t, true)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "sc-rt-1", Runtime: "codex", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	req.Header.Set("X-Session-ID", "sc-rt-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	a, err := store.Get().AgentApproval.Get(extractApprovalID(w.Body.String()))
	if err != nil || a == nil {
		t.Fatalf("approval not found: %v", err)
	}
	if a.Agent != "codex" {
		t.Fatalf("agent = %q, want codex", a.Agent)
	}
}
