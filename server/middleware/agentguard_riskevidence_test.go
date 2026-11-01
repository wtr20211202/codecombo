package middleware

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 高危命令影响面证据增强（P-20261005-191）：终端输入类高危路由（broadcast-write
// / queue）建审批时，把请求体命令串过 server/terminal 高危模式表，命中把模式
// 摘要附进审批卡 detail。证据是增强面：命中才附、读体失败静默、请求体回填
//（审批重试路径的下游 handler 还要读体）

func riskEvidenceEnv(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	st := store.New(doc)
	store.SetDefault(st)
	t.Cleanup(func() { store.SetDefault(nil) })
	on := true
	st.Settings.Get().Server.AgentGuard = &on

	r := gin.New()
	g := r.Group("/api")
	g.Use(AgentGuard())
	g.POST("/terminals/broadcast-write", func(c *gin.Context) {
		// 下游 handler 真实读体：证据提取若不回填请求体，此处读到空即红
		body, _ := io.ReadAll(c.Request.Body)
		c.JSON(http.StatusOK, gin.H{"echo": string(body)})
	})
	g.POST("/terminals/:id/queue", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	return r
}

func postJSON(t *testing.T, r *gin.Engine, token, url, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("X-Lock-Token", token)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func lastPendingApproval(t *testing.T) store.AgentApproval {
	t.Helper()
	list, err := store.Get().AgentApproval.List("", 10)
	if err != nil || len(list) == 0 {
		t.Fatalf("期望有审批记录: %v", err)
	}
	return list[0]
}

func TestAgentGuard_RiskEvidenceAttached(t *testing.T) {
	r := riskEvidenceEnv(t)
	st := store.Get()
	tok, err := st.AgentToken.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	// 命中高危模式：审批 detail 附模式摘要（含命中片段）
	w := postJSON(t, r, tok, "/api/terminals/broadcast-write", `{"ids":["a"],"data":"rm -rf build\r"}`)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	a := lastPendingApproval(t)
	if !strings.Contains(a.Detail, "rm-recursive") {
		t.Fatalf("审批 detail 应附风险摘要: %q", a.Detail)
	}

	// 无命中：detail 不附摘要（保持既有文案）
	w = postJSON(t, r, tok, "/api/terminals/broadcast-write", `{"ids":["a"],"data":"echo hi\r"}`)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	a = lastPendingApproval(t)
	if strings.Contains(a.Detail, "risk patterns") {
		t.Fatalf("无命中不应附摘要: %q", a.Detail)
	}
}

func TestAgentGuard_RiskEvidenceBodyPreserved(t *testing.T) {
	r := riskEvidenceEnv(t)
	st := store.Get()
	tok, _ := st.AgentToken.Rotate()

	// 预检（428）读体后须回填：审批放行后的重试请求体仍完整到达下游 handler。
	// 直接验证回填语义：同一请求对象上先过中间件（428），再读 Body 应还原原文
	body := `{"ids":["a"],"data":"git clean -fd"}`
	req := httptest.NewRequest(http.MethodPost, "/api/terminals/broadcast-write", strings.NewReader(body))
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}

	// 重试路径（带 X-Approval-ID 放行）：下游 handler 的 echo 应收完整原文。
	// 审批放行走 CreateAgentApproval 侧门建 allowed 记录再消费（放行记录须
	// 携 ResolvedAt——中间件按「已裁决且窗口内」判一次性消费资格）
	now := time.Now()
	a := store.AgentApproval{
		ID: "approval-e2e", Status: store.ApprovalAllowed,
		Op: "终端广播输入", Target: "/api/terminals/broadcast-write",
		CreatedAt:  now,
		ResolvedAt: &now,
	}
	if err := store.Get().AgentApproval.Save(a); err != nil {
		t.Fatal(err)
	}
	req2 := httptest.NewRequest(http.MethodPost, "/api/terminals/broadcast-write", strings.NewReader(body))
	req2.Header.Set("X-Lock-Token", tok)
	req2.Header.Set("X-Approval-ID", "approval-e2e")
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("放行重试 status = %d, want 200: %s", w2.Code, w2.Body.String())
	}
	var out struct {
		Echo string `json:"echo"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Echo != body {
		t.Fatalf("下游读体应收到完整原文, got %q", out.Echo)
	}
}

func TestAgentGuard_RiskEvidenceQueueRoute(t *testing.T) {
	r := riskEvidenceEnv(t)
	st := store.Get()
	tok, _ := st.AgentToken.Rotate()

	// queue 入队（text 形态）同样附证据
	w := postJSON(t, r, tok, "/api/terminals/t1/queue", `{"text":"git reset --hard"}`)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	a := lastPendingApproval(t)
	if !strings.Contains(a.Detail, "git-reset-hard") {
		t.Fatalf("queue 审批 detail 应附风险摘要: %q", a.Detail)
	}
}
