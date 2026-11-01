package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 删除项目审批卡级联影响证据（P-20261006-36）：文案组装表驱动（计数入参注入，
// 不向 DefaultManager 注活会话——单测惯例不起真实 PTY，驻留匹配本体已在
// server/terminal/residency_test.go 覆盖）+ gin 链路接线（detail 拼装点）。
func TestProjectDeleteImpactText(t *testing.T) {
	cases := []struct {
		name            string
		bound, resident int
		closeRequested  bool
		want            string
		wantContains    []string
	}{
		{"零影响空串（证据增强不造句）", 0, 0, false, "", nil},
		{"仅绑定会话", 2, 0, false, "", []string{"将终止 2 个项目绑定会话", "驻留智能体会话 0 个", "默认保留"}},
		{"仅驻留智能体会话", 0, 3, false, "", []string{"驻留智能体会话 3 个", "默认保留"}},
		{"勾选一并关闭档", 1, 2, true, "", []string{"驻留智能体会话 2 个", "已请求一并关闭"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := projectDeleteImpactText("影响面项目", tc.bound, tc.resident, tc.closeRequested)
			if tc.want == "" && tc.wantContains == nil {
				if got != "" {
					t.Fatalf("projectDeleteImpactText = %q, want empty", got)
				}
				return
			}
			if !strings.Contains(got, "项目 影响面项目") {
				t.Fatalf("missing project name: %q", got)
			}
			for _, want := range tc.wantContains {
				if !strings.Contains(got, want) {
					t.Fatalf("missing %q in %q", want, got)
				}
			}
		})
	}
}

// gin 链路接线：删除项目命中高危路由时 detail 拼装不因证据函数入列而破坏
// （零影响走既有基线 detail；非删除项目路由证据函数必须让路）
func TestAgentGuard_ProjectDeleteImpactWiring(t *testing.T) {
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	st := store.New(doc)
	store.SetDefault(st)
	t.Cleanup(func() { store.SetDefault(nil) })
	on := true
	st.Settings.Get().Server.AgentGuard = &on
	if err := st.Project.Create(config.ProjectConfig{ID: "p-wiring", Name: "接线项目", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	g := r.Group("/api")
	g.Use(AgentGuard())
	g.DELETE("/projects/:id", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	tok, err := st.AgentToken.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodDelete, "/api/projects/p-wiring", nil)
	req.Header.Set("X-Lock-Token", tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	pending, err := st.AgentApproval.List(store.ApprovalPending, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 {
		t.Fatalf("pending approvals = %d, want 1", len(pending))
	}
	detail := pending[0].Detail
	if !strings.Contains(detail, "服务端强制：智能体令牌请求高危端点 /api/projects/:id") {
		t.Fatalf("baseline detail broken: %s", detail)
	}
	// 单测进程 DefaultManager 无会话（零影响）→ 证据子句不出现（不造空句）
	if strings.Contains(detail, "级联影响") {
		t.Fatalf("empty-impact detail must not contain impact clause: %s", detail)
	}
}
