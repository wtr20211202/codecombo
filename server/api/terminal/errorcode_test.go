package terminal

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/errmarkers"
	"codecombo/server/store"
)

// P-20261005-160 门禁：terminal 域（广播/编队/排队指令）校验错误面的 code 稳定
// 断言——agent 按 code 分支自纠（ids_too_many→分批 / queue_full→等消费再入队 /
// prompt_required→补指令），码值或绑定 status 漂移在此翻红。message 原文保留
//（部分原文即 errmarkers 稳定标记，前端 KNOWN_ERROR_I18N 映射契约不回退）。

// postBroadcastC / postBulkC 复用同文件既有独立引擎（setupBroadcastRouter /
// bulkTestRouter——broadcast_test.go、bulk_agent_test.go 持有，本文件只新增断言）

// TestBroadcastWrite_ErrorCodes 广播校验族逐码：400/413 形态与迁移前一致，响应体
// 增 code 字段（agent 分支依据），message 关键字原样
func TestBroadcastWrite_ErrorCodes(t *testing.T) {
	r := setupBroadcastRouter()

	// ids 上限 = 本地+远程两会话上限之和（P-20261005-11）：50+20=70，越界 71
	manyIDs := make([]string, 71)
	for i := range manyIDs {
		manyIDs[i] = fmt.Sprintf(`"ghost-%d"`, i)
	}
	cases := []struct {
		name string
		body string
		want int
		code string
	}{
		{"empty ids", `{"ids":[],"data":"x"}`, http.StatusBadRequest, "terminal.ids_empty"},
		{"too many ids", `{"ids":[` + strings.Join(manyIDs, ",") + `],"data":"x"}`, http.StatusBadRequest, "terminal.ids_too_many"},
		{"empty data", `{"ids":["a"],"data":""}`, http.StatusBadRequest, "terminal.data_required"},
		{"data too large", `{"ids":["a"],"data":"` + strings.Repeat("x", 64*1024+1) + `"}`, http.StatusBadRequest, "terminal.data_too_large"},
		{"not json", `nope`, http.StatusBadRequest, "terminal.payload_invalid"},
		{"body over limit", `{"ids":["a"],"data":"` + strings.Repeat("x", 128*1024+2) + `"}`, http.StatusRequestEntityTooLarge, "terminal.body_too_large"},
	}
	for _, tc := range cases {
		w := postBroadcast(r, tc.body)
		if w.Code != tc.want {
			t.Errorf("%s: status = %d, want %d, body=%s", tc.name, w.Code, tc.want, w.Body.String())
			continue
		}
		var m struct {
			Code    string `json:"code"`
			Message string `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatalf("%s: decode body: %v (%s)", tc.name, err, w.Body.String())
		}
		if m.Code != tc.code {
			t.Errorf("%s: code = %q, want %q", tc.name, m.Code, tc.code)
		}
		if m.Message == "" {
			t.Errorf("%s: message must survive migration（原文即前端映射契约）", tc.name)
		}
	}
}

// TestBulkAgent_ErrorCodes 编队校验族逐码：400 与迁移前一致
func TestBulkAgent_ErrorCodes(t *testing.T) {
	cases := []struct {
		name string
		body string
		code string
	}{
		{"empty projectIds", `{"projectIds":[],"prompt":"do it"}`, "terminal.project_ids_empty"},
		{"too many projects", `{"projectIds":[` + strings.TrimSuffix(strings.Repeat(`"p",`, 21), ",") + `],"prompt":"do it"}`, "terminal.project_ids_too_many"},
		{"blank prompt", `{"projectIds":["proj-a"],"prompt":"   "}`, "terminal.prompt_required"},
		{"bad body", `{`, "terminal.payload_invalid"},
	}
	for _, tc := range cases {
		w := postBulk(tc.body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400, body=%s", tc.name, w.Code, w.Body.String())
			continue
		}
		var m struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
			t.Fatalf("%s: decode body: %v (%s)", tc.name, err, w.Body.String())
		}
		if m.Code != tc.code {
			t.Errorf("%s: code = %q, want %q", tc.name, m.Code, tc.code)
		}
	}
}

// TestRespondQueueError_Codes 排队校验错误映射附码：满队 409 + terminal.queue_full
// （原文即 errmarkers.QueueFull 稳定标记，保留）、非法指令 400 + terminal.queue_invalid
func TestRespondQueueError_Codes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/q", func(c *gin.Context) {
		respondQueueError(c, store.ErrQueueFull)
	})
	r.POST("/q-invalid", func(c *gin.Context) {
		respondQueueError(c, store.ErrQueueInvalid)
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/q", nil))
	if w.Code != http.StatusConflict {
		t.Fatalf("queue-full status = %d, want 409", w.Code)
	}
	assertCodeAndText(t, w.Body.Bytes(), "terminal.queue_full", errmarkers.QueueFull)

	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, httptest.NewRequest(http.MethodPost, "/q-invalid", nil))
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("queue-invalid status = %d, want 400", w2.Code)
	}
	assertCodeAndText(t, w2.Body.Bytes(), "terminal.queue_invalid", errmarkers.QueueInvalid)
}

// assertCodeAndText 响应体 code 与 error 原文共存断言（双轨契约：code 分支 +
// 文本映射互不替代）
func assertCodeAndText(t *testing.T, body []byte, wantCode, wantTextPart string) {
	t.Helper()
	var m struct {
		Code    string `json:"code"`
		Message string `json:"error"`
	}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode body: %v (%s)", err, body)
	}
	if m.Code != wantCode {
		t.Errorf("code = %q, want %q", m.Code, wantCode)
	}
	if !strings.Contains(m.Message, wantTextPart) {
		t.Errorf("error text %q must keep stable marker %q", m.Message, wantTextPart)
	}
}
