package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 全局档位三档化的 AgentGuard 接线（P-20261003-316）：判定收敛在
// config.Server.ResolveApprovalDecision（单测在 config 包），此处覆盖中间件
// 路径的端到端行为——24h 未过期放行/到期回 428、会话级仅映射内会话放行。
// 模式是包级单例配置，用例改后必须恢复（同 agentguard_mode_test 纪律）

func withMode(t *testing.T, mutate func(s *config.ServerConfig)) {
	t.Helper()
	cfg := store.Get().Settings.Get()
	savedMode := cfg.Server.AgentApprovalMode
	savedExp := cfg.Server.AgentApprovalExpiresAt
	savedMap := cfg.Server.AgentSessionAllows
	mutate(&cfg.Server)
	t.Cleanup(func() {
		cfg.Server.AgentApprovalMode = savedMode
		cfg.Server.AgentApprovalExpiresAt = savedExp
		cfg.Server.AgentSessionAllows = savedMap
	})
}

// guardWithSession 携 X-Session-ID 的高危请求（会话级档位的归属来源）
func guardWithSession(t *testing.T, r *gin.Engine, at store.AgentTokenStore, path, session string) *httptest.ResponseRecorder {
	t.Helper()
	tok, err := at.Rotate()
	if err != nil {
		return nil
	}
	req := httptest.NewRequest(http.MethodPost, path, nil)
	req.Header.Set("X-Lock-Token", tok)
	if session != "" {
		req.Header.Set("X-Session-ID", session)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestAgentGuard_Allow24hPasses(t *testing.T) {
	r, at := setupGuard(t, true)
	withMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = config.ApprovalModeAllow24h
		s.AgentApprovalExpiresAt = time.Now().Add(time.Hour)
	})
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil || w.Code != http.StatusOK {
		t.Fatalf("unexpired 24h status = %v, want 200", w)
	}
	list, _ := store.Get().AgentApproval.List("", 0)
	if len(list) != 0 {
		t.Fatalf("expect no approval records, got %d", len(list))
	}
}

func TestAgentGuard_Allow24hExpiredAsks(t *testing.T) {
	r, at := setupGuard(t, true)
	withMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = config.ApprovalModeAllow24h
		s.AgentApprovalExpiresAt = time.Now().Add(-time.Minute) // 已过期
	})
	w := agentAuth(r, at, "/api/projects/p1/push")
	if w == nil {
		t.Fatal("token rotate failed")
	}
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("expired 24h status = %d, want 428 (back to ask)", w.Code)
	}
}

func TestAgentGuard_SessionScoped(t *testing.T) {
	r, at := setupGuard(t, true)
	withMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = config.ApprovalModeAllowSession
		s.GrantSessionAllow("sc-live-1", time.Now())
	})

	// 映射内会话：直放行，不留审批记录
	if w := guardWithSession(t, r, at, "/api/projects/p1/push", "sc-live-1"); w == nil || w.Code != http.StatusOK {
		t.Fatalf("granted session status = %v, want 200", w)
	}
	if list, _ := store.Get().AgentApproval.List("", 0); len(list) != 0 {
		t.Fatalf("expect no approval records for granted session, got %d", len(list))
	}

	// 映射外会话：仍 428 走审批卡流
	if w := guardWithSession(t, r, at, "/api/projects/p1/push", "sc-other"); w == nil || w.Code != http.StatusPreconditionRequired {
		t.Fatalf("other session status = %v, want 428", w)
	}

	// 无会话标识：退 ask（428），会话级档位不外溢到可归属性不明的请求
	if w := guardWithSession(t, r, at, "/api/projects/p1/push", ""); w == nil || w.Code != http.StatusPreconditionRequired {
		t.Fatalf("no session id status = %v, want 428", w)
	}
}
