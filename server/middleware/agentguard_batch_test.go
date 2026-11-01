package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 批量文件操作端点的 AgentGuard 接入（P-20261006-39）：op 文案按请求体
// action/条目数细化——delete 形态保「删除文件」前缀（规则前缀匹配下存量
// 规则零失效）、一次审批覆盖整批；读体后原样回填（下游 handler 还要读体）。

// setupBatchGuard 构造挂批量文件端点桩的 AgentGuard 测试引擎（setupGuard 同
// 装配 + 本端点桩；桩须挂在带 AgentGuard 的 group 下——setupGuard 的中间件
// 只作用其自身 group 的路由）
func setupBatchGuard(t *testing.T, guardOn bool) (*gin.Engine, store.AgentTokenStore) {
	t.Helper()
	r, at := setupGuard(t, guardOn)
	g := r.Group("/api")
	g.Use(AgentGuard())
	g.POST("/projects/:id/files/batch", func(c *gin.Context) {
		// 桩 handler 走 ShouldBindJSON：证明中间件读体后回填无损（审批重试
		// 放行路径的下游读体是本设计的关键约束）
		var req struct {
			Action  string `json:"action"`
			Entries []any  `json:"entries"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "action": req.Action, "entries": len(req.Entries)})
	})
	return r, at
}

func postBatch(r *gin.Engine, tok, approvalID, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/files/batch", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if tok != "" {
		req.Header.Set("X-Lock-Token", tok)
	}
	if approvalID != "" {
		req.Header.Set("X-Approval-ID", approvalID)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func approvalOpByID(t *testing.T, id string) string {
	t.Helper()
	a, err := store.Get().AgentApproval.Get(id)
	if err != nil || a == nil {
		t.Fatalf("approval missing: %v", err)
	}
	return a.Op
}

// TestAgentGuardBatch_DeleteOpPrefix agent 批量删除 → 428 建卡，审批 op =
// 「删除文件（批量 3 个）」——既有「删除文件」规则前缀命中（allow 不建卡
// 直通、deny 403），存量规则零失效
func TestAgentGuardBatch_DeleteOpPrefix(t *testing.T) {
	r, at := setupBatchGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	body := `{"action":"delete","entries":["a.txt","b.txt","c.txt"]}`

	// 无规则：428 建卡，op 细化为「删除文件（批量 N 个）」
	w := postBatch(r, tok, "", body)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	var guard struct {
		ApprovalID string `json:"approvalId"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &guard); err != nil || guard.ApprovalID == "" {
		t.Fatalf("428 body expect approvalId, got %s", w.Body.String())
	}
	if op := approvalOpByID(t, guard.ApprovalID); op != "删除文件（批量 3 个）" {
		t.Fatalf("op = %q, want 删除文件（批量 3 个）", op)
	}
	// 清掉阶段一建的卡，阶段二的「不建卡」断言才有干净基线
	if err := store.Get().AgentApproval.Delete(guard.ApprovalID); err != nil {
		t.Fatal(err)
	}

	// 既有「删除文件」前缀规则 allow → 细化 op 前缀命中，不建卡直通
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "删除文件", Effect: config.ApprovalEffectAllow}})
	w2 := postBatch(r, tok, "", body)
	if w2.Code != http.StatusOK {
		t.Fatalf("allow rule status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}
	pending, _ := store.Get().AgentApproval.List(store.ApprovalPending, 0)
	for _, pa := range pending {
		if pa.Op == "删除文件（批量 3 个）" {
			t.Fatalf("allow 命中不应新建审批卡")
		}
	}

	// deny 规则命中细化 op → 403（审计记录 op 同细化形态）
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "删除文件", Effect: config.ApprovalEffectDeny}})
	w3 := postBatch(r, tok, "", body)
	if w3.Code != http.StatusForbidden {
		t.Fatalf("deny rule status = %d, want 403", w3.Code)
	}
	var deny struct {
		ApprovalID string `json:"approvalId"`
	}
	_ = json.Unmarshal(w3.Body.Bytes(), &deny)
	if deny.ApprovalID == "" {
		t.Fatalf("403 body expect approvalId, got %s", w3.Body.String())
	}
	if op := approvalOpByID(t, deny.ApprovalID); op != "删除文件（批量 3 个）" {
		t.Fatalf("deny record op = %q", op)
	}
}

// TestAgentGuardBatch_OpForms move/rename 形态 op 文案与计数、未知形态回落
// 静态 op；读体回填后桩 handler 正常解析 body（放行重试路径）
func TestAgentGuardBatch_OpForms(t *testing.T) {
	r, at := setupBatchGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		body, wantOp string
	}{
		{`{"action":"move","entries":["a","b"],"destDir":"d"}`, "批量移动文件（2 个）"},
		{`{"action":"rename","renames":[{"oldPath":"a","newPath":"b"}]}`, "批量改名文件（1 个）"},
		{`{"action":"copy","entries":["a","b"],"destDir":"d"}`, "批量复制文件（2 个）"},
		{`{"action":"whatever","entries":["a"]}`, "批量文件操作"}, // 未知形态回落静态 op
		{`{not-json`, "批量文件操作"},                             // 非 JSON 回落静态 op
	}
	for _, tc := range cases {
		w := postBatch(r, tok, "", tc.body)
		if w.Code != http.StatusPreconditionRequired {
			t.Fatalf("body=%s status = %d, want 428", tc.body, w.Code)
		}
		var guard struct {
			ApprovalID string `json:"approvalId"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &guard); err != nil || guard.ApprovalID == "" {
			t.Fatalf("428 body expect approvalId, got %s", w.Body.String())
		}
		if op := approvalOpByID(t, guard.ApprovalID); op != tc.wantOp {
			t.Fatalf("body=%s op = %q, want %q", tc.body, op, tc.wantOp)
		}
	}

	// 读体回填无损：allow 规则放行后桩 handler 正常解析（action/条目数对得上）
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "批量移动文件", Effect: config.ApprovalEffectAllow}})
	w := postBatch(r, tok, "", `{"action":"move","entries":["a","b"],"destDir":"d"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("allow status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	var done struct {
		OK      bool   `json:"ok"`
		Action  string `json:"action"`
		Entries int    `json:"entries"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &done); err != nil {
		t.Fatalf("stub response unmarshal: %v (body=%s)", err, w.Body.String())
	}
	if !done.OK || done.Action != "move" || done.Entries != 2 {
		t.Fatalf("stub parsed = %+v, want move:2（读体回填破坏下游解析）", done)
	}
}
