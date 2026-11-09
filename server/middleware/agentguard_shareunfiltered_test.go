package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 终端输出分享关闭遮蔽的 AgentGuard 面（P-20261106-9）：agent 令牌带
// unfiltered=true 必须审批（原样出域与公网隧道同级）；遮蔽（缺省/false）是
// 既有安全基线直放行（agent 代开直播/冻快照求援存量语义零变化）；超限/不可
// 解析体失败闭合；body 读后回填，下游 handler 仍能绑定。用真实表项路径注册
// 桩路由（matchGuarded 按 FullPath 匹配，路径漂移即红）

func setupShareUnfilteredGuard(t *testing.T) (*gin.Engine, store.AgentTokenStore) {
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
	echo := func(c *gin.Context) {
		var req struct {
			SessionID  string `json:"sessionId"`
			Unfiltered bool   `json:"unfiltered"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad body"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"sessionId": req.SessionID, "unfiltered": req.Unfiltered})
	}
	g.POST("/share/terminal", echo)
	g.POST("/share/terminal-frozen", echo)
	return r, st.AgentToken
}

func pendingApprovals(t *testing.T) []store.AgentApproval {
	t.Helper()
	cards, err := store.Get().AgentApproval.List("", 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []store.AgentApproval
	for _, a := range cards {
		if a.Status == store.ApprovalPending {
			out = append(out, a)
		}
	}
	return out
}

func TestAgentGuard_ShareUnfilteredRequiresApproval(t *testing.T) {
	r, at := setupShareUnfilteredGuard(t)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{"/api/share/terminal", "/api/share/terminal-frozen"} {
		w := postJSON(t, r, tok, url, `{"sessionId":"s1","unfiltered":true}`)
		if w.Code != http.StatusPreconditionRequired {
			t.Fatalf("%s unfiltered status = %d, want 428, body=%s", url, w.Code, w.Body.String())
		}
		id := extractApprovalID(w.Body.String())
		a, err := store.Get().AgentApproval.Get(id)
		if err != nil || a == nil {
			t.Fatalf("%s approval not found: %v", url, err)
		}
		if a.Op != "终端分享关闭敏感值遮蔽（原样出域）" {
			t.Fatalf("%s approval op = %q", url, a.Op)
		}
		route, ok := matchGuarded(http.MethodPost, url)
		if !ok || route.op == "" {
			t.Fatalf("guardedRoutes missing %s entry or empty op: %+v ok=%v", url, route, ok)
		}
	}
}

func TestAgentGuard_ShareMaskedExempt(t *testing.T) {
	r, at := setupShareUnfilteredGuard(t)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	// 遮蔽缺省/显式 false：直过 handler 且 body 已回填（handler 绑定成功）
	for _, body := range []string{`{"sessionId":"s1"}`, `{"sessionId":"s1","unfiltered":false}`} {
		w := postJSON(t, r, tok, "/api/share/terminal", body)
		if w.Code != http.StatusOK {
			t.Fatalf("masked %s status = %d, want 200, body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), `"sessionId":"s1"`) || !strings.Contains(w.Body.String(), `"unfiltered":false`) {
			t.Fatalf("handler did not receive restored body: %s", w.Body.String())
		}
	}
	// 空体判 masked：handler 自身 400（不可能产出分享），守卫不建卡
	if w := postJSON(t, r, tok, "/api/share/terminal-frozen", ``); w.Code != http.StatusBadRequest {
		t.Fatalf("empty body status = %d, want handler 400", w.Code)
	}
	if p := pendingApprovals(t); len(p) != 0 {
		t.Fatalf("masked requests must not create approvals: %+v", p)
	}
}

func TestAgentGuard_ShareUnfilteredFailsClosed(t *testing.T) {
	r, at := setupShareUnfilteredGuard(t)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{
		`not-json`,
		`{"sessionId":"s1","unfiltered":"yes"}`, // 类型不符：方向未知
		`{"sessionId":"s1","unfiltered":true}` + strings.Repeat(" ", 5000), // 超限：读不全即未知
	} {
		w := postJSON(t, r, tok, "/api/share/terminal", body)
		if w.Code != http.StatusPreconditionRequired {
			t.Fatalf("body %.40q status = %d, want 428 (fail closed)", body, w.Code)
		}
	}
	// 与 gin 绑定同语义：合法 JSON + 尾随垃圾，handler 能解出 unfiltered=true，
	// 守卫必须同判 unfiltered（若用 Unmarshal 会判未知——此处同样 428，但更要紧的是
	// 「遮蔽 + 尾随垃圾」不得因解码分歧被误判为 unfiltered 以外的方向而放过原样出域）
	if w := postJSON(t, r, tok, "/api/share/terminal", `{"sessionId":"s1","unfiltered":true} trailing`); w.Code != http.StatusPreconditionRequired {
		t.Fatalf("trailing-garbage unfiltered status = %d, want 428", w.Code)
	}
	if w := postJSON(t, r, tok, "/api/share/terminal", `{"sessionId":"s1","UNFILTERED":true}`); w.Code != http.StatusPreconditionRequired {
		t.Fatalf("case-insensitive key status = %d, want 428 (json binding is case-insensitive)", w.Code)
	}
}

func TestAgentGuard_ShareUnfilteredUserTokenUnaffected(t *testing.T) {
	r, _ := setupShareUnfilteredGuard(t)
	// 非 agent 令牌（用户本人 / 无令牌豁免链路）：守卫不介入，UI 侧另有出域确认
	req := httptest.NewRequest(http.MethodPost, "/api/share/terminal", strings.NewReader(`{"sessionId":"s1","unfiltered":true}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"unfiltered":true`) {
		t.Fatalf("user request status = %d body=%s, want 200 passthrough", w.Code, w.Body.String())
	}
}
