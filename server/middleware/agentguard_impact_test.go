package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// guarded 审批卡服务端 impact 自动填充（P-20261006-35）：requireApproval428
// 建审批时经 ImpactFiller（组合根装配，测试换桩）按守卫模式自动填充结构化
// 影响面；装配缺失/无数据/panic 一律降级 nil 老卡形态——impact 是知情增强
// 面，不阻塞审批创建（428 流程与卡片广播照旧）

// impactGuardEnv 删除项目高危路由的 guard 测试环境（真实 guardedRoutes 表项
// DELETE /api/projects/:id），并恢复包级 ImpactFiller 防止泄漏进兄弟用例
func impactGuardEnv(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	st := store.New(doc)
	store.SetDefault(st)
	t.Cleanup(func() { store.SetDefault(nil) })
	t.Cleanup(func() { ImpactFiller = nil })
	on := true
	st.Settings.Get().Server.AgentGuard = &on

	r := gin.New()
	g := r.Group("/api")
	g.Use(AgentGuard())
	g.DELETE("/projects/:id", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	return r
}

func deleteWithToken(t *testing.T, r *gin.Engine, token, url string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete, url, nil)
	req.Header.Set("X-Lock-Token", token)
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestAgentGuard_ImpactFilled(t *testing.T) {
	r := impactGuardEnv(t)
	st := store.Get()
	tok, err := st.AgentToken.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	// 广播卡与落盘记录同源读到同一份 impact：装配桩捕获广播载荷一并断言
	var broadcast store.AgentApproval
	ApprovalNotifier = func(a store.AgentApproval) { broadcast = a }
	t.Cleanup(func() { ApprovalNotifier = nil })

	var gotPattern, gotOp, gotLang string
	ImpactFiller = func(pattern, op, target, lang string) *store.ApprovalImpact {
		gotPattern, gotOp, gotLang = pattern, op, lang
		return &store.ApprovalImpact{Kind: "delete", Summary: "将终止该项目 3 个终端会话"}
	}

	h := http.Header{}
	h.Set("Accept-Language", "zh-CN")
	w := deleteWithToken(t, r, tok, "/api/projects/p1", h)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	// 回调收到守卫模式 / op / Accept-Language（语言档由组合根函数翻译，此处
	// 只验中间件把头值原样传到位）
	if gotPattern != "/api/projects/:id" || gotOp != "删除项目" || gotLang != "zh-CN" {
		t.Fatalf("filler 参数 = (%q, %q, %q)", gotPattern, gotOp, gotLang)
	}
	a := lastPendingApproval(t)
	if a.Impact == nil || a.Impact.Kind != "delete" || a.Impact.Summary != "将终止该项目 3 个终端会话" {
		t.Fatalf("审批应带填充的 impact: %+v", a.Impact)
	}
	if broadcast.ID != a.ID || broadcast.Impact == nil || broadcast.Impact.Kind != "delete" {
		t.Fatalf("广播卡应携同一份 impact: %+v", broadcast.Impact)
	}
}

func TestAgentGuard_ImpactDegradeNil(t *testing.T) {
	r := impactGuardEnv(t)
	tok, err := store.Get().AgentToken.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	// 无可靠数据的路由：填充回调返回 nil → 老卡形态（impact 缺席），428 照旧
	ImpactFiller = func(pattern, op, target, lang string) *store.ApprovalImpact {
		return nil
	}
	w := deleteWithToken(t, r, tok, "/api/projects/p1", nil)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	if a := lastPendingApproval(t); a.Impact != nil {
		t.Fatalf("nil 降级应不落 impact: %+v", a.Impact)
	}

	// 未装配（组合根未注入）：同降级形态
	ImpactFiller = nil
	w = deleteWithToken(t, r, tok, "/api/projects/p2", nil)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	if a := lastPendingApproval(t); a.Impact != nil {
		t.Fatalf("未装配应不落 impact: %+v", a.Impact)
	}
}

func TestAgentGuard_ImpactPanicDegrade(t *testing.T) {
	r := impactGuardEnv(t)
	tok, err := store.Get().AgentToken.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	// 计算函数 panic：降级 nil 老卡形态，审批创建不被阻塞（428 + approvalId 照常）
	ImpactFiller = func(pattern, op, target, lang string) *store.ApprovalImpact {
		panic("impact compute exploded")
	}
	w := deleteWithToken(t, r, tok, "/api/projects/p1", nil)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("panic 兜底后 status = %d, want 428", w.Code)
	}
	if id := extractApprovalID(w.Body.String()); id == "" {
		t.Fatalf("panic 兜底后响应应仍带 approvalId: %s", w.Body.String())
	}
	if a := lastPendingApproval(t); a.Impact != nil {
		t.Fatalf("panic 应降级不落 impact: %+v", a.Impact)
	}
}

// TestAgentGuard_ImpactPersistedForPoll 428 响应携 approvalId，落盘记录带
// impact——轮询 GET /api/ops-confirm/:id 与列表读的就是这份记录（响应形状
// 断言归 api/ai 包 opsconfirm_impact_test.go）
func TestAgentGuard_ImpactPersistedForPoll(t *testing.T) {
	r := impactGuardEnv(t)
	tok, err := store.Get().AgentToken.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	ImpactFiller = func(pattern, op, target, lang string) *store.ApprovalImpact {
		return &store.ApprovalImpact{Kind: "delete", Summary: "Will terminate 1 terminal session(s) of this project"}
	}
	w := deleteWithToken(t, r, tok, "/api/projects/p1", nil)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	var resp struct {
		ApprovalID string `json:"approvalId"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.ApprovalID == "" {
		t.Fatalf("428 响应应带 approvalId: %s", w.Body.String())
	}
	a, err := store.Get().AgentApproval.Get(resp.ApprovalID)
	if err != nil || a == nil {
		t.Fatalf("审批应可按 id 反查（轮询数据源）: %v", err)
	}
	if a.Impact == nil || a.Impact.Kind != "delete" || a.Impact.Summary == "" {
		t.Fatalf("落盘记录应带 impact: %+v", a)
	}
}
