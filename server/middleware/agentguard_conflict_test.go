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

// 冲突解决域的 AgentGuard 强制面（P-20261004-30）：resolve / resolve-content
// 对 sca_ 智能体令牌必须 428 + approvalId（整文件 ours/theirs 一把梭会静默丢弃
// 另一侧全部改动，数据丢失级）；用户解锁令牌（冲突面板 UI 操作）豁免；读面
// （conflicts 列表 / parsed 逐块解析）不设防——agent 看到冲突清单正是按手册
// 规范先问用户偏好的前提。用真实表项路径注册桩路由，matchGuarded 按 FullPath
// 匹配——路径打错（表项与实际注册不一致）即测试红

// setupConflictGuard 构造 conflict 域桩路由 + guard 中间件 + store 装配
func setupConflictGuard(t *testing.T, guardOn bool) (*gin.Engine, store.AgentTokenStore) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	st := store.New(doc)
	store.SetDefault(st)
	t.Cleanup(func() { store.SetDefault(nil) })
	on := guardOn
	st.Settings.Get().Server.AgentGuard = &on

	r := gin.New()
	g := r.Group("/api")
	g.Use(AgentGuard())
	ok := func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) }
	g.POST("/projects/:id/conflicts/resolve", ok)
	g.POST("/projects/:id/conflicts/resolve-content", ok)
	g.GET("/projects/:id/conflicts", ok)
	g.GET("/projects/:id/conflicts/parsed", ok)
	return r, st.AgentToken
}

func TestAgentGuard_GuardsConflictResolveFamily(t *testing.T) {
	r, at := setupConflictGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/projects/p1/conflicts/resolve",
		"/api/projects/p1/conflicts/resolve-content",
	} {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("X-Lock-Token", tok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusPreconditionRequired {
			t.Fatalf("%s: status = %d, want 428, body=%s", path, w.Code, w.Body.String())
		}
		if !contains(w.Body.String(), "approvalId") {
			t.Fatalf("%s: expect approvalId in body: %s", path, w.Body.String())
		}
	}

	// 两条表项 op 均非空（审批卡展示与规则前缀匹配契约），且同以「冲突解决」
	// 为前缀——规则一条前缀即覆盖整个冲突解决族
	for _, entry := range []struct{ method, path string }{
		{http.MethodPost, "/api/projects/:id/conflicts/resolve"},
		{http.MethodPost, "/api/projects/:id/conflicts/resolve-content"},
	} {
		route, ok := matchGuarded(entry.method, entry.path)
		if !ok || route.op == "" {
			t.Fatalf("guardedRoutes missing %s %s or empty op", entry.method, entry.path)
		}
		if !strings.HasPrefix(route.op, "冲突解决") {
			t.Fatalf("op %q should share 冲突解决 prefix for family rule matching", route.op)
		}
	}
}

func TestAgentGuard_ConflictUserTokenExempt(t *testing.T) {
	r, _ := setupConflictGuard(t, true)

	// scl_ 解锁令牌 = 用户本人 UI 操作（冲突面板逐块解决走这条链），不受限
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/conflicts/resolve", nil)
	req.Header.Set("X-Lock-Token", "scl_user_token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("unlock token status = %d, want 200 (exempt), body=%s", w.Code, w.Body.String())
	}
}

func TestAgentGuard_ConflictApprovalPassThenReplay(t *testing.T) {
	r, at := setupConflictGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/projects/p1/conflicts/resolve"

	// 首次 → 428 + approvalId
	req := httptest.NewRequest(http.MethodPost, path, nil)
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
	req2 := httptest.NewRequest(http.MethodPost, path, nil)
	req2.Header.Set("X-Lock-Token", tok)
	req2.Header.Set("X-Approval-ID", approvalID)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}

	// 同 ID 二次重试 → 已消费，重新 428（一次性语义）
	req3 := httptest.NewRequest(http.MethodPost, path, nil)
	req3.Header.Set("X-Lock-Token", tok)
	req3.Header.Set("X-Approval-ID", approvalID)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusPreconditionRequired {
		t.Fatalf("replay status = %d, want 428", w3.Code)
	}
}

func TestAgentGuard_ConflictReadRoutesOpen(t *testing.T) {
	r, at := setupConflictGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	// 冲突清单与逐块解析是读面：agent 令牌直达（看到冲突才能按规范上报偏好）
	for _, path := range []string{
		"/api/projects/p1/conflicts",
		"/api/projects/p1/conflicts/parsed",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Lock-Token", tok)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (read side not guarded)", path, w.Code)
		}
	}
}
