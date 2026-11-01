package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// GET /api/terminals/running-count handler 级最小测试（P-20261004-63）：与
// ports/search 端点同款——本包单测惯例不起真实 PTY，DefaultManager 无会话可注，
// 这里只钉整形契约（空态 count=0 / total=0 / running 序列化为 [] 非 null，
// 前端 .length 与 agent 遍历消费的 JSON 形态防线）与 kind 参数校验；
// 计数核心（kind 过滤/清理随动）在 terminal 包单测（oscstate_test.go），
// 警示行端到端由 e2e（token-rotate-confirm.spec.ts）覆盖。

func TestGetRunningCountEmptyShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/running-count", GetRunningCount)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/running-count?kind=agent", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("should be 200, got %d", w.Code)
	}
	var body struct {
		Data struct {
			Kind    string   `json:"kind"`
			Count   int      `json:"count"`
			Total   int      `json:"total"`
			Running []string `json:"running"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if body.Data.Kind != "agent" || body.Data.Count != 0 || body.Data.Total != 0 {
		t.Fatalf("empty state mismatch: %+v", body.Data)
	}
	if body.Data.Running == nil {
		t.Fatalf("running must serialize as [] not null, got %s", w.Body.String())
	}
}

func TestGetRunningCountInvalidKind(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/running-count", GetRunningCount)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/running-count?kind=bogus", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bogus kind should be 400, got %d", w.Code)
	}
}
