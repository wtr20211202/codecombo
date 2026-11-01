package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 审批分类规则接线（P-20261003-35）：agentguard 中间件按规则裁决高危请求——
// allow 命中直放行（不建审批）、deny 命中 403 + denied 审计记录（带 ruleHit）+
// 终态广播、ask 命中/无规则走现行 428 审批流；全局 allow 模式短路优先。
// 注：终态广播经 ApprovalResolvedNotifier 桥观测（opschannel import middleware，
// 测试文件不能反向引入——广播载荷形态在 api/ai 包 BroadcastApprovalResolved 处覆盖）

// setGuardRules 写规则表 + 还原（复用 setupGuard 的 store 装配）
func setGuardRules(t *testing.T, rules []config.AgentApprovalRule) {
	t.Helper()
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentApprovalRules = rules
	t.Cleanup(func() { cfg.Server.AgentApprovalRules = nil })
}

func TestAgentGuardRules_Deny(t *testing.T) {
	r, at := setupGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectDeny}})

	// 终态广播经组合根桥观测（广播载荷形态在 api/ai 包覆盖）
	var notified store.AgentApproval
	ApprovalResolvedNotifier = func(a store.AgentApproval) { notified = a }
	t.Cleanup(func() { ApprovalResolvedNotifier = nil })

	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("deny rule status = %d, want 403, body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Error      string `json:"error"`
		ApprovalID string `json:"approvalId"`
		RuleHit    string `json:"ruleHit"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.RuleHit != "git push" || body.ApprovalID == "" {
		t.Fatalf("403 body expect approvalId + ruleHit, got %+v", body)
	}

	// denied 审计记录落库（带 ruleHit），无 pending 可放行
	a, err := store.Get().AgentApproval.Get(body.ApprovalID)
	if err != nil || a == nil {
		t.Fatalf("deny record missing: %v", err)
	}
	if a.Status != store.ApprovalDenied || a.RuleHit != "git push" || a.ResolvedAt == nil {
		t.Fatalf("deny record expect denied + ruleHit + resolvedAt, got %+v", a)
	}
	// 桥被调用且携带同一记录（广播终态）
	if notified.ID != a.ID || notified.Status != store.ApprovalDenied || notified.RuleHit != "git push" {
		t.Fatalf("resolved notifier expect denied + ruleHit, got %+v", notified)
	}
}

func TestAgentGuardRules_Allow(t *testing.T) {
	r, at := setupGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectAllow}})

	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("allow rule status = %d, want 200 (direct pass), body=%s", w.Code, w.Body.String())
	}
	// 不建审批记录（与 allow 模式一致——直放行走 agentguard.allow 审计切面，
	// 不落审批域记录，P-20261006-45）
	list, _ := store.Get().AgentApproval.List("", 0)
	if len(list) != 0 {
		t.Fatalf("allow rule must not create approval, got %d", len(list))
	}
}

func TestAgentGuardRules_AskAndNoRuleKeepFlow(t *testing.T) {
	r, at := setupGuard(t, true)

	// 显式 ask 规则命中：现行 428 审批流不变（push 桩路由的 op 摘要为 "git push"）
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectAsk}})
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("ask rule status = %d, want 428", w.Code)
	}

	// 无规则：默认现行 428 审批流（行为与历史版本零差异）
	setGuardRules(t, nil)
	w2 := agentAuth(r, at, "/api/projects/p1/push")
	if w2 == nil {
		t.Fatal("token rotate failed")
	}
	if w2.Code != http.StatusPreconditionRequired {
		t.Fatalf("no rule status = %d, want 428", w2.Code)
	}
}

func TestAgentGuardRules_GlobalAllowShortCircuit(t *testing.T) {
	r, at := setupGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectDeny}})
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentApprovalMode = "allow"
	t.Cleanup(func() { cfg.Server.AgentApprovalMode = "" })

	// 全局优先：模式 = allow 时 deny 规则不评估
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("global allow short-circuit status = %d, want 200", w.Code)
	}
}

func TestAgentGuardRules_GuardOffNoRuleEval(t *testing.T) {
	r, at := setupGuard(t, false)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectDeny}})

	// AgentGuard 总开关关闭：整个强制面（含规则）不生效——规则只是强制审批
	// 粒度的细分，不是独立防线
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("guard off status = %d, want 200", w.Code)
	}
}
