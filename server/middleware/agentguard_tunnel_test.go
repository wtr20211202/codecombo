package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 远程接入隧道的 AgentGuard 面（P-20261020-1）：start（含切换）必须审批，
// stop 是降险动作直过；body 读后回填，下游 handler 仍能拿到 action。用真实
// 表项路径注册桩路由（matchGuarded 按 FullPath 匹配，路径漂移即红）。

func setupTunnelGuard(t *testing.T) (*gin.Engine, store.AgentTokenStore) {
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
	g.POST("/remoteaccess/tunnel", func(c *gin.Context) {
		var req struct {
			Action string `json:"action"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad body"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"action": req.Action})
	})
	return r, st.AgentToken
}

func tunnelReq(t *testing.T, r *gin.Engine, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/remoteaccess/tunnel", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lock-Token", token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestAgentGuard_TunnelStartRequiresApproval(t *testing.T) {
	r, at := setupTunnelGuard(t)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	w := tunnelReq(t, r, tok, `{"action":"start"}`)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("start status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	approvalID := extractApprovalID(w.Body.String())
	if approvalID == "" {
		t.Fatalf("expect approvalId in body: %s", w.Body.String())
	}
	a, err := store.Get().AgentApproval.Get(approvalID)
	if err != nil || a == nil {
		t.Fatalf("approval not found: %v", err)
	}
	if a.Op != "远程接入隧道（公网暴露）" {
		t.Fatalf("approval op = %q", a.Op)
	}
	// 表项契约：op 非空且审批规则可按该前缀匹配
	route, ok := matchGuarded(http.MethodPost, "/api/remoteaccess/tunnel")
	if !ok || route.op == "" {
		t.Fatalf("guardedRoutes missing tunnel entry or empty op: %+v ok=%v", route, ok)
	}
}

func TestAgentGuard_TunnelStopExempt(t *testing.T) {
	r, at := setupTunnelGuard(t)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	// stop 是降险动作：不建审批卡，直过 handler；body 必须已被回填（handler
	// ShouldBindJSON 成功 = 读体恢复契约成立）
	w := tunnelReq(t, r, tok, `{"action":"stop"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("stop status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"action":"stop"`) {
		t.Fatalf("stop handler did not receive body: %s", w.Body.String())
	}
	cards, err := store.Get().AgentApproval.List("", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range cards {
		if a.Status == store.ApprovalPending {
			t.Fatalf("stop must not create pending approval: %+v", a)
		}
	}
}

func TestAgentGuard_TunnelUnknownActionFailsClosed(t *testing.T) {
	r, at := setupTunnelGuard(t)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`{"action":"explode"}`,
		``, // 空体 = action 未知
		`not-json`,
	} {
		w := tunnelReq(t, r, tok, body)
		if w.Code != http.StatusPreconditionRequired {
			t.Fatalf("body %q: status = %d, want 428 (fail closed), body=%s", body, w.Code, w.Body.String())
		}
	}
}

func TestAgentGuard_TunnelStartApprovalPass(t *testing.T) {
	r, at := setupTunnelGuard(t)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	w := tunnelReq(t, r, tok, `{"action":"start"}`)
	approvalID := extractApprovalID(w.Body.String())
	if approvalID == "" {
		t.Fatalf("no approvalId: %s", w.Body.String())
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

	req := httptest.NewRequest(http.MethodPost, "/api/remoteaccess/tunnel", strings.NewReader(`{"action":"start"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lock-Token", tok)
	req.Header.Set("X-Approval-ID", approvalID)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	if w2.Code != http.StatusOK {
		t.Fatalf("approval retry status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}
	if !strings.Contains(w2.Body.String(), `"action":"start"`) {
		t.Fatalf("handler did not receive body after guard read: %s", w2.Body.String())
	}
}

func TestAgentGuard_TunnelUserTokenExempt(t *testing.T) {
	r, _ := setupTunnelGuard(t)
	req := httptest.NewRequest(http.MethodPost, "/api/remoteaccess/tunnel", strings.NewReader(`{"action":"start"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lock-Token", "scl_user_token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("user token status = %d, want 200 (exempt), body=%s", w.Code, w.Body.String())
	}
}
