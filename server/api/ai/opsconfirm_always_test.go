package ai

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// TestAgentApproval_AlwaysSetsAllowMode 「完全允许」裁决链路：
// resolve allow+always → 本次 allowed，且审批模式持久化为 allow
// （后续高危操作不再询问；改回每次询问在设置页）
func TestAgentApproval_AlwaysSetsAllowMode(t *testing.T) {
	r := setupApprovalTest(t)
	// resolve always 会改包级单例配置（config.Load sync.Once）——恢复默认，
	// 不泄漏给同包后续用例
	t.Cleanup(func() { store.Get().Settings.Get().Server.AgentApprovalMode = "" })

	// 预置 claude 运行时的会话：创建审批时应反查回填 agent
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "sc-always-1", Runtime: "claude", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"sc-always-1","op":"git push","target":"main"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve",
		`{"allow":true,"always":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := store.Get().Settings.Get().Server.AgentApprovalModeStored(); got != config.ApprovalModeAllow {
		t.Fatalf("approval mode = %q, want allow", got)
	}

	// 轮询响应带 agent 类型（展示智能体请求方）
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+created.Data.ID, "")
	if !bytes.Contains(w.Body.Bytes(), []byte(`"agent":"claude"`)) {
		t.Fatalf("expect agent=claude in poll body: %s", w.Body.String())
	}
}

// TestAgentApproval_AllowModeAutoApproves 完全允许模式下约定式创建不弹卡：
// 直接以 allowed 落库（留审计记录、带裁决时间），Agent 轮询立即看到放行——
// 与 agentguard 中间件路径同一开关语义
func TestAgentApproval_AllowModeAutoApproves(t *testing.T) {
	r := setupApprovalTest(t)
	// 改包级单例配置（config.Load sync.Once）——恢复默认，不泄漏给同包后续用例
	t.Cleanup(func() { store.Get().Settings.Get().Server.AgentApprovalMode = "" })
	store.Get().Settings.Get().Server.AgentApprovalMode = "allow"

	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "sc-allow-auto-1", Runtime: "codex", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"sc-allow-auto-1","op":"git push -f","target":"main"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.ApprovalAllowed {
		t.Fatalf("create status = %q, want allowed（allow 模式不弹卡直接放行）", created.Data.Status)
	}

	a, err := store.Get().AgentApproval.Get(created.Data.ID)
	if err != nil || a == nil {
		t.Fatalf("approval record missing: %v", err)
	}
	if a.Status != store.ApprovalAllowed || a.ResolvedAt == nil {
		t.Fatalf("record status=%q resolvedAt=%v, want allowed + resolvedAt", a.Status, a.ResolvedAt)
	}
}
