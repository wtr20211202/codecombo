package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// TestAgentGuard_GuardsBroadcastWrite 广播输入端点（P-20261003-288）在高危
// 路由表内：持 sca_ 智能体令牌调用必须被 428 + approvalId 拦截（向终端写入
// = 任意命令执行面，与 git push 同级强制面）。用真实表项路径注册桩路由，
// matchGuarded 按 FullPath 匹配——路径打错（表项与实际注册不一致）即测试红
func TestAgentGuard_GuardsBroadcastWrite(t *testing.T) {
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
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	tok, err := st.AgentToken.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/terminals/broadcast-write", nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	if !contains(w.Body.String(), "approvalId") {
		t.Fatalf("expect approvalId in body: %s", w.Body.String())
	}

	// 表项 op 用于审批卡展示与规则前缀匹配：非空即契约（具体文案不锁死）
	route, ok := matchGuarded(http.MethodPost, "/api/terminals/broadcast-write")
	if !ok || route.op == "" {
		t.Fatalf("guardedRoutes missing broadcast-write entry or empty op: %+v ok=%v", route, ok)
	}
}
