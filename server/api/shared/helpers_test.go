package shared

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// P-20261007-24 门禁：bind 失败 message 基线形态断言——400 + "invalid request
// body" 恒定（dev 模式也不被 errText 解析器原文覆盖，helper 传 nil err 是契约
// 的一部分）；迁移域出 code 字段、未迁移域无 code 字段。

func bindTestContext(body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/bind-test", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	return c, w
}

type bindTestPayload struct {
	Name string `json:"name" binding:"required"`
}

func TestBindJSON(t *testing.T) {
	old := devMode
	SetDevMode(true) // 本地实例缺省形态；message 基线断言在 dev 模式下才有判别力
	t.Cleanup(func() { SetDevMode(old) })

	t.Run("成功解析返回 true 且不写响应", func(t *testing.T) {
		c, w := bindTestContext(`{"name":"x"}`)
		var req bindTestPayload
		if !BindJSON(c, &req, CodeTerminalPayloadInvalid) {
			t.Fatalf("合法载荷应返回 true")
		}
		if req.Name != "x" {
			t.Fatalf("载荷未解析进结构体: %+v", req)
		}
		if w.Body.Len() != 0 {
			t.Fatalf("成功路径不应写响应体，got %q", w.Body.String())
		}
	})

	t.Run("迁移域 bind 失败 400 基线 message 携 code", func(t *testing.T) {
		c, w := bindTestContext(`{"name":1}`)
		var req bindTestPayload
		if BindJSON(c, &req, CodeTerminalPayloadInvalid) {
			t.Fatalf("非法载荷应返回 false")
		}
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
		body := w.Body.String()
		// dev 模式 errText 会以 err 原文覆盖 publicMsg——helper 内传 nil err，
		// 基线文案恒定是本 helper 的核心契约（解析器原文随输入漂移无基线可言）
		if !strings.Contains(body, "invalid request body") {
			t.Fatalf("message 应为基线 %q，got %s", "invalid request body", body)
		}
		if !strings.Contains(body, `"code":"terminal.payload_invalid"`) {
			t.Fatalf("迁移域响应应携稳定 code，got %s", body)
		}
	})

	t.Run("未迁移域空码保持无 code 旧形态", func(t *testing.T) {
		c, w := bindTestContext(`nope`)
		var req bindTestPayload
		if BindJSON(c, &req, "") {
			t.Fatalf("非法载荷应返回 false")
		}
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
		body := w.Body.String()
		if !strings.Contains(body, "invalid request body") {
			t.Fatalf("message 应为基线 %q，got %s", "invalid request body", body)
		}
		if strings.Contains(body, `"code"`) {
			t.Fatalf("未迁移域响应不应有 code 字段（增量不破坏），got %s", body)
		}
	})
}
