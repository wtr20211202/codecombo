package terminal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/agentops"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// precheckTestStore 装配独立 store（LaunchAgentSession 读 settings 默认值；
// activity_test setupMetaTest 同款手法）
func precheckTestStore(t *testing.T) {
	t.Helper()
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// 创建前预检（P-20261003-79）：预检目标判定（纯函数）+ HTTP 400 映射 +
// 放行路径不重复起子进程。claude 是内置注册名（注册表进程级恒定），判定
// 用例不依赖真实可用性探测

func TestTargetPrecheckName(t *testing.T) {
	cases := []struct {
		name       string
		reqRuntime string
		customs    map[string]string
		want       string
	}{
		{"显式内置运行时→预检", "claude", nil, "claude"},
		{"显式 auto→选型后补检", "auto", nil, ""},
		{"shell 一等选项→不检", "shell", nil, ""},
		{"空串（设置默认链）→选型后补检", "", nil, ""},
		{"未注册名→选型回落 auto", "no-such-rt", nil, ""},
		{"自定义命令覆盖→原样启动承诺豁免", "claude", map[string]string{"claude": "/opt/launcher claude"}, ""},
	}
	for _, tc := range cases {
		if got := targetPrecheckName(tc.reqRuntime, tc.customs); got != tc.want {
			t.Fatalf("%s: targetPrecheckName(%q) = %q, want %q", tc.name, tc.reqRuntime, got, tc.want)
		}
	}
}

func TestAutoPrecheckName(t *testing.T) {
	cases := []struct {
		name        string
		runtimeName string
		prechecked  string
		customs     map[string]string
		want        string
	}{
		{"auto 选定未预检过→补检", "claude", "", nil, "claude"},
		{"选型前已检同名→跳过（一次创建至多一检）", "claude", "claude", nil, ""},
		{"shell→不检", "shell", "", nil, ""},
		{"空（选型失败降级）→不检", "", "", nil, ""},
		{"自定义命令覆盖→豁免", "claude", "", map[string]string{"claude": "my-wrapper"}, ""},
	}
	for _, tc := range cases {
		if got := autoPrecheckName(tc.runtimeName, tc.prechecked, tc.customs); got != tc.want {
			t.Fatalf("%s: autoPrecheckName(%q, %q) = %q, want %q", tc.name, tc.runtimeName, tc.prechecked, got, tc.want)
		}
	}
}

// precheckTestRouter 独立 gin 引擎挂 CreateTerminal（不依赖主路由装配）
func precheckTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/terminals", CreateTerminal)
	return r
}

// TestCreateAgentTerminalPrecheck400 显式运行时预检失败 → 400 + 稳定标记原文
// （生产模式响应 body 取 publicMsg，原文须落在 publicMsg 才能被前端
// KNOWN_ERROR_I18N 映射——见 createAgentTerminal 注释），且会话不创建。
// 放行路径不在此真实建会话（PTY 不进单测是本包既有边界）：预检判定与放行
// 不拦由上方纯函数用例 + agentops 包 PrecheckCommand 真实二进制用例覆盖，
// 端到端由 e2e runtime-precheck.spec 守门
func TestCreateAgentTerminalPrecheck400(t *testing.T) {
	precheckTestStore(t)
	old := precheckRuntimeFn
	calls := 0
	precheckRuntimeFn = func(name string) (string, error) {
		calls++
		return "", &agentops.PrecheckError{Runtime: name, Missing: true}
	}
	t.Cleanup(func() { precheckRuntimeFn = old })

	before := len(terminal.DefaultManager.ListSessions())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/terminals",
		strings.NewReader(`{"name":"p","kind":"agent","runtime":"claude"}`))
	req.Header.Set("Content-Type", "application/json")
	precheckTestRouter().ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400（body=%s）", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "runtime claude is not installed or not in the service process PATH") {
		t.Fatalf("body 应含稳定标记原文，got %s", w.Body.String())
	}
	if calls != 1 {
		t.Fatalf("预检失败应止于第一段，calls = %d", calls)
	}
	if after := len(terminal.DefaultManager.ListSessions()); after != before {
		t.Fatalf("预检失败不得创建会话：before=%d after=%d", before, after)
	}
}
