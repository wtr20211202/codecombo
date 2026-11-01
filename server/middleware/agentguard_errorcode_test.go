package middleware

import (
	"encoding/json"
	"net/http"
	"testing"

	"codecombo/server/config"
)

// P-20261003-305 门禁：AgentGuard 428/403 的 code 稳定断言——agent 对高危拦截
// 的分支自纠依据（428 → 轮询后携 X-Approval-ID 重试；403 deny → 不可重试）。
// 复用 setupGuard / agentAuth / setGuardRules 既有装配。

func guardBodyCode(t *testing.T, body string) (code string) {
	t.Helper()
	var m struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("decode body: %v (%s)", err, body)
	}
	return m.Code
}

// TestAgentGuard_ErrorCode_ApprovalRequired 428 审批拦截携 ops.approval_required
func TestAgentGuard_ErrorCode_ApprovalRequired(t *testing.T) {
	r, at := setupGuard(t, true)
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	if got := guardBodyCode(t, w.Body.String()); got != "ops.approval_required" {
		t.Errorf("code = %q, want ops.approval_required", got)
	}
}

// TestAgentGuard_ErrorCode_ApprovalDenied 规则 deny 403 携 ops.approval_denied
func TestAgentGuard_ErrorCode_ApprovalDenied(t *testing.T) {
	r, at := setupGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectDeny}})

	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403, body=%s", w.Code, w.Body.String())
	}
	if got := guardBodyCode(t, w.Body.String()); got != "ops.approval_denied" {
		t.Errorf("code = %q, want ops.approval_denied", got)
	}
}
