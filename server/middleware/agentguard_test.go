package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupGuard 构造带 guard 中间件 + store 装配 + sca_ 令牌的测试环境
func setupGuard(t *testing.T, guardOn bool) (*gin.Engine, store.AgentTokenStore) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	st := store.New(doc)
	store.SetDefault(st)
	t.Cleanup(func() { store.SetDefault(nil) })

	// 全局开关
	off := guardOn
	st.Settings.Get().Server.AgentGuard = &off

	r := gin.New()
	// 测试路由桩：模拟高危端点与豁免端点
	g := r.Group("/api")
	g.Use(AgentGuard())
	g.POST("/projects/:id/push", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	g.GET("/projects/:id/status", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	return r, st.AgentToken
}

// agentAuth 注入模拟的 sca_ 令牌（AgentToken.Validate 只认 sca_ 前缀 + 注册表，
// 测试直接用真实 store：Generate 一个）
func agentAuth(r *gin.Engine, at store.AgentTokenStore, path string) *httptest.ResponseRecorder {
	tok, err := at.Rotate()
	if err != nil {
		return nil
	}
	req := httptest.NewRequest(http.MethodPost, path, nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestAgentGuard_BlocksAgentTokenOnGuardedRoute(t *testing.T) {
	r, at := setupGuard(t, true)
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	if !contains(w.Body.String(), "approvalId") {
		t.Fatalf("expect approvalId in body: %s", w.Body.String())
	}
}

func TestAgentGuard_ExemptsUnlockTokenAndReadRoutes(t *testing.T) {
	r, _ := setupGuard(t, true)

	// scl_ 解锁令牌（用户本人）不受限——锁中间件层已校验，此处仅桩
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", "scl_user_token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unlock token status = %d, want 200 (exempt)", w.Code)
	}

	// 读路由不受限
	req2 := httptest.NewRequest(http.MethodGet, "/api/projects/p1/status", nil)
	req2.Header.Set("X-Lock-Token", "sca_whatever")
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("read route status = %d, want 200 (not guarded)", w2.Code)
	}
}

func TestAgentGuard_AllowOncePass(t *testing.T) {
	r, at := setupGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	// 首次 → 428 + approvalId
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("first request status = %d, want 428", w.Code)
	}
	approvalID := extractApprovalID(w.Body.String())
	if approvalID == "" {
		t.Fatal("no approvalId in 428 body")
	}

	// 用户裁决允许
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

	// 带 X-Approval-ID 重试 → 放行（一次性消费）
	req2 := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req2.Header.Set("X-Lock-Token", tok)
	req2.Header.Set("X-Approval-ID", approvalID)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}

	// 同 ID 二次重试 → 记录已消费，重新 428（一次性语义）
	req3 := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req3.Header.Set("X-Lock-Token", tok)
	req3.Header.Set("X-Approval-ID", approvalID)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusPreconditionRequired {
		t.Fatalf("replay status = %d, want 428", w3.Code)
	}
}

func TestAgentGuard_SwitchOff(t *testing.T) {
	r, at := setupGuard(t, false) // 总开关关闭
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusOK {
		t.Fatalf("guard off status = %d, want 200", w.Code)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func extractApprovalID(body string) string {
	marker := `"approvalId":"`
	i := indexOfStr(body, marker)
	if i < 0 {
		return ""
	}
	rest := body[i+len(marker):]
	j := indexOfStr(rest, `"`)
	if j < 0 {
		return ""
	}
	return rest[:j]
}

func indexOfStr(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
