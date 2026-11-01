package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// GET /api/terminals/ports handler 级最小测试（P-20261003-293）：与 search 端点
// 同款——只断言空表整形为 []（前端 .map 契约的 JSON null 防线）；注册表核心
// （登记/刷新/冲突/摘除）在 terminal 包单测（portregistry_test.go），会话名
// 读取时反查的端到端行为由 e2e（terminal-ports.spec.ts）覆盖——本包单测惯例
// 不起真实 PTY，DefaultManager 无会话可注。

func TestListDevPortsEmptyShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/ports", ListDevPorts)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/ports", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("should be 200, got %d", w.Code)
	}
	var body struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if body.Data == nil {
		t.Fatalf("empty registry should serialize as [], got %s", w.Body.String())
	}
}

// TestOnPortConflictWired 冲突通知装配冒烟（portdetect_broadcast_test.go 同款
// init 装配断言）：nil 时 RegisterDevPort 只登记不通知，装配缺失=冲突静默
func TestOnPortConflictWired(t *testing.T) {
	if terminal.OnPortConflict == nil {
		t.Fatalf("terminal.OnPortConflict must be wired in init (portConflictNotifier)")
	}
}
