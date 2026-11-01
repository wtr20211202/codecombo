package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// AgentGuard 统一审计切面（P-20261006-45）单测：强制面三出口各落一条
// agentguard.* 审计——allow 直放行（规则命中 rule= / 全局档位短路 tier=）、
// denyByRule（denied，与审批域记录双留）、审批通过重试（approval= 归属一次性
// 消费）；豁免面（用户令牌 / 总开关关闭）零记账；审计写失败不阻塞请求
// （Append 尽力而为语义的切面侧验证）。字段归属断言 Detail key=value 形态
// （actor/route/op/target/session/agent + 归属段），与 auditGuardDecision 组装同构。

// auditEventsByAction 取当前审计台账中指定动作的全部条目（setupGuard 装配的
// 独立 store，测试间互不污染）
func auditEventsByAction(t *testing.T, action string) []store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	var out []store.AuditEvent
	for _, e := range events {
		if e.Action == action {
			out = append(out, e)
		}
	}
	return out
}

// assertDetailSegments 断言 Detail 含全部 key=value 段（切面字段归属契约）
func assertDetailSegments(t *testing.T, detail string, segs ...string) {
	t.Helper()
	for _, seg := range segs {
		if !strings.Contains(detail, seg) {
			t.Errorf("audit detail %q missing segment %q", detail, seg)
		}
	}
}

func TestAgentGuardAudit_AllowRule(t *testing.T) {
	r, at := setupGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectAllow}})
	// 会话元数据在册：agent= 运行时归属可断言（RuntimeForSession 反查）
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "sess-a1", Runtime: "claude", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	req.Header.Set("X-Session-ID", "sess-a1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("allow rule status = %d, want 200, body=%s", w.Code, w.Body.String())
	}

	events := auditEventsByAction(t, store.AuditAgentGuardAllow)
	if len(events) != 1 {
		t.Fatalf("agentguard.allow events = %d, want 1", len(events))
	}
	e := events[0]
	if e.Result != store.AuditResultSuccess {
		t.Errorf("result = %q, want success", e.Result)
	}
	assertDetailSegments(t, e.Detail,
		"actor=agent",
		"route=/api/projects/:id/push",
		"op=git push",
		"target=/api/projects/p1/push",
		"session=sess-a1",
		"agent=claude",
		"rule=git push",
	)
	// 不建审批记录（allow 直放行语义不变，审计走台账不走审批域）
	list, _ := store.Get().AgentApproval.List("", 0)
	if len(list) != 0 {
		t.Fatalf("allow rule must not create approval, got %d", len(list))
	}
}

func TestAgentGuardAudit_GlobalTierShortCircuit(t *testing.T) {
	r, at := setupGuard(t, true)
	// deny 规则在表：全局 allow 档位短路优先（规则不评估）——审计记 tier= 而非 rule=
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectDeny}})
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentApprovalMode = config.ApprovalModeAllow
	t.Cleanup(func() { cfg.Server.AgentApprovalMode = "" })

	if w := agentAuth(r, at, "/api/projects/p1/push"); w == nil || w.Code != http.StatusOK {
		t.Fatalf("global allow short-circuit status = %+v, want 200", w)
	}
	events := auditEventsByAction(t, store.AuditAgentGuardAllow)
	if len(events) != 1 {
		t.Fatalf("agentguard.allow events = %d, want 1", len(events))
	}
	assertDetailSegments(t, events[0].Detail, "tier="+config.ApprovalModeAllow)
	if strings.Contains(events[0].Detail, "rule=") {
		t.Errorf("tier short-circuit must not claim rule attribution: %q", events[0].Detail)
	}
}

func TestAgentGuardAudit_DenyRule(t *testing.T) {
	r, at := setupGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectDeny}})

	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("deny rule status = %d, want 403", w.Code)
	}

	events := auditEventsByAction(t, store.AuditAgentGuardDeny)
	if len(events) != 1 {
		t.Fatalf("agentguard.deny events = %d, want 1", len(events))
	}
	e := events[0]
	if e.Result != store.AuditResultDenied {
		t.Errorf("result = %q, want denied", e.Result)
	}
	assertDetailSegments(t, e.Detail,
		"route=/api/projects/:id/push",
		"rule=git push",
	)
	// 双留分工：审批域 denied 记录仍在（既有语义），审计台账另有裁决维度一条
	list, _ := store.Get().AgentApproval.List("", 0)
	if len(list) != 1 || list[0].Status != store.ApprovalDenied {
		t.Fatalf("approval-domain denied record missing, got %d", len(list))
	}
}

func TestAgentGuardAudit_ApprovalPass(t *testing.T) {
	r, at := setupGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	// 首次 → 428 + approvalId（建卡路径不入账，卡即记录）
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("first request status = %d, want 428", w.Code)
	}
	if events := auditEventsByAction(t, store.AuditAgentGuardPass); len(events) != 0 {
		t.Fatalf("428 path must not write approval_pass, got %d", len(events))
	}
	approvalID := extractApprovalID(w.Body.String())
	if approvalID == "" {
		t.Fatal("no approvalId in 428 body")
	}
	a, err := store.Get().AgentApproval.Get(approvalID)
	if err != nil || a == nil {
		t.Fatalf("approval not found: %v", err)
	}
	allowed := store.ApprovalAllowed
	now := time.Now()
	a.Status = allowed
	a.ResolvedAt = &now
	if err := store.Get().AgentApproval.Save(*a); err != nil {
		t.Fatal(err)
	}

	// 重试 → 放行 + agentguard.approval_pass（approval= 归属一次性消费的卡）
	req2 := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req2.Header.Set("X-Lock-Token", tok)
	req2.Header.Set("X-Approval-ID", approvalID)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}
	events := auditEventsByAction(t, store.AuditAgentGuardPass)
	if len(events) != 1 {
		t.Fatalf("agentguard.approval_pass events = %d, want 1", len(events))
	}
	assertDetailSegments(t, events[0].Detail,
		"route=/api/projects/:id/push",
		"approval="+approvalID,
	)

	// 同 ID 重放 → 记录已消费重新 428：不放行也不二次记账
	req3 := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req3.Header.Set("X-Lock-Token", tok)
	req3.Header.Set("X-Approval-ID", approvalID)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusPreconditionRequired {
		t.Fatalf("replay status = %d, want 428", w3.Code)
	}
	if events := auditEventsByAction(t, store.AuditAgentGuardPass); len(events) != 1 {
		t.Fatalf("replay must not double-book approval_pass, got %d", len(events))
	}
}

func TestAgentGuardAudit_ExemptFacesNoEvents(t *testing.T) {
	// 用户本人（scl_ 解锁令牌）不在强制面：豁免路径零记账
	r, _ := setupGuard(t, true)
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", "scl_user_token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unlock token status = %d, want 200", w.Code)
	}
	events, _, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("exempt face must not audit, got %d events", len(events))
	}

	// 总开关关闭：整个强制面（含切面）不生效
	r2, at2 := setupGuard(t, false)
	if w := agentAuth(r2, at2, "/api/projects/p1/push"); w == nil || w.Code != http.StatusOK {
		t.Fatalf("guard off status = %+v, want 200", w)
	}
	events2, _, err := store.Get().Audit.List(0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events2) != 0 {
		t.Fatalf("guard off must not audit, got %d events", len(events2))
	}
}

func TestAgentGuardAudit_SensitiveWriteFace(t *testing.T) {
	// 敏感写入路径面（agentguard_sensitivewrite.go）同切面口径：allow 规则
	// 直放行落 agentguard.allow，route= 为命中的窄表 glob
	r, at := setupPathGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "写入敏感路径", Effect: config.ApprovalEffectAllow}})
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	if w := writeWith(r, tok, ".git%2Fhooks%2Fpre-commit"); w.Code != http.StatusOK {
		t.Fatalf("sensitive allow status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	events := auditEventsByAction(t, store.AuditAgentGuardAllow)
	if len(events) != 1 {
		t.Fatalf("sensitive face allow events = %d, want 1", len(events))
	}
	assertDetailSegments(t, events[0].Detail,
		"route=**/.git/hooks/**",
		"op=写入敏感路径 .git/hooks/pre-commit",
		"target=.git/hooks/pre-commit",
		"rule=写入敏感路径",
	)

	// 审批通过重试放行同面同账（无规则走 428 → 裁决 → 重试）
	setGuardRules(t, nil)
	tok2, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	w := writeWith(r, tok2, ".git%2Fconfig")
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("sensitive 428 status = %d, want 428", w.Code)
	}
	approvalID := extractApprovalID(w.Body.String())
	if approvalID == "" {
		t.Fatal("no approvalId in 428 body")
	}
	a, err := store.Get().AgentApproval.Get(approvalID)
	if err != nil || a == nil {
		t.Fatalf("approval not found: %v", err)
	}
	allowed := store.ApprovalAllowed
	now := time.Now()
	a.Status = allowed
	a.ResolvedAt = &now
	if err := store.Get().AgentApproval.Save(*a); err != nil {
		t.Fatal(err)
	}
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/projects/p1/file?path=.git%2Fconfig", nil)
	req2.Header.Set("X-Lock-Token", tok2)
	req2.Header.Set("X-Approval-ID", approvalID)
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("sensitive retry status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}
	passEvents := auditEventsByAction(t, store.AuditAgentGuardPass)
	if len(passEvents) != 1 {
		t.Fatalf("sensitive face approval_pass events = %d, want 1", len(passEvents))
	}
	assertDetailSegments(t, passEvents[0].Detail,
		"route=**/.git/config",
		"approval="+approvalID,
	)
}

// failCreateDoc 仅 Create 恒败的 DocumentStore 假件（读路径走真实 filestore，
// store 包 failDocStore 同款）：模拟数据目录不可写——审计 Append 尽力而为
// 语义下切面不得阻塞请求
type failCreateDoc struct {
	store.DocumentStore
}

func (f failCreateDoc) Create(kind, key string, data []byte) error {
	return errors.New("disk full (injected)")
}

func TestAgentGuardAudit_WriteFailNotBlocking(t *testing.T) {
	r, at := setupGuard(t, true)
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectAllow}})
	// 换入仅落盘恒败的审计仓储（其余 repo 不受影响）——Append 失败只计数
	st := store.Get()
	st.Audit = store.NewAuditLogRepo(failCreateDoc{DocumentStore: filestore.New(t.TempDir())})

	if w := agentAuth(r, at, "/api/projects/p1/push"); w == nil || w.Code != http.StatusOK {
		t.Fatalf("allow rule with failing audit store: want 200, got %+v", w)
	}
	count, _ := st.Audit.WriteFailures()
	if count == 0 {
		t.Fatal("audit write failure not counted, want >=1")
	}
}
