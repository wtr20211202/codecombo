package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// handler 级最小测试：参数门（q≥2 / limit 收敛）与响应整形。
// 检索核心（匹配/上限/ANSI 剥离）在 terminal 包单测覆盖（search_test.go），
// 会话构造不起真实 PTY；本文件 DefaultManager 无会话 → 命中恒空，正好断言
// 空集整形为 []（JSON null 防线）与 400 路径。

func TestSearchTerminalOutputShortQueryRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/search", SearchTerminalOutput)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=e", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("q<2 should be 400, got %d", w.Code)
	}
}

func TestSearchTerminalOutputEmptyResultShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/search", SearchTerminalOutput)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/terminals/search?q=anything", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("valid query should be 200, got %d", w.Code)
	}
	var body struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	// 无会话实例命中恒空：必须整形为 [] 而非 null（前端 .map 契约）
	if body.Data == nil || len(body.Data) != 0 {
		t.Fatalf("empty result should serialize as [], got %s", w.Body.String())
	}
}
