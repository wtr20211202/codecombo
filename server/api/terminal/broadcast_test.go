package terminal

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// setupBroadcastRouter 独立引擎只挂广播端点（不经全局中间件——锁/令牌校验
// 在组合根，此处单测 handler 本体的参数校验与响应契约）
func setupBroadcastRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/terminals/broadcast-write", BroadcastWrite)
	return r
}

func postBroadcast(r *gin.Engine, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/terminals/broadcast-write", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

// TestBroadcastWriteValidation 参数校验：空 ids / 空 data / 超 ids 上限 / 超
// data 上限 / 非 JSON 体，一律 400 且不打到会话层
func TestBroadcastWriteValidation(t *testing.T) {
	r := setupBroadcastRouter()

	// ids 上限 = 本地+远程两会话上限之和（P-20261005-11）：50+20=70，越界 71
	manyIDs := make([]string, 71)
	for i := range manyIDs {
		manyIDs[i] = fmt.Sprintf(`"ghost-%d"`, i)
	}
	cases := []struct {
		name string
		body string
	}{
		{"empty ids", `{"ids":[],"data":"x"}`},
		{"missing ids", `{"data":"x"}`},
		{"empty data", `{"ids":["a"],"data":""}`},
		{"too many ids", `{"ids":[` + strings.Join(manyIDs, ",") + `],"data":"x"}`},
		{"data too large", `{"ids":["a"],"data":"` + strings.Repeat("x", 64*1024+1) + `"}`},
		{"not json", `nope`},
	}
	for _, tc := range cases {
		w := postBroadcast(r, tc.body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400, body=%s", tc.name, w.Code, w.Body.String())
		}
	}

	// 请求体超 LimitBody 上限（128KB）：413（与 file/notes 端点同约定，
	// BodyTooLarge 判别优先于 400）
	w := postBroadcast(r, `{"ids":["a"],"data":"`+strings.Repeat("x", 128*1024+2)+`"}`)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("body over limit: status = %d, want 413", w.Code)
	}
}

// broadcastResp 广播响应 data 段（与 BroadcastResult JSON 契约对齐）
type broadcastResp struct {
	Written int      `json:"written"`
	Missing []string `json:"missing"`
	Failed  []string `json:"failed"`
}

// TestBroadcastWriteResponseShape 单测进程 DefaultManager 无会话：全量 id
// 走 missing 回告（「不存在 id 404 跳过并计数回告」的 HTTP 契约面），
// missing/failed 恒为数组（序列化成 [] 而非 null，前端解构安全）
func TestBroadcastWriteResponseShape(t *testing.T) {
	r := setupBroadcastRouter()

	w := postBroadcast(r, `{"ids":["ghost-a","ghost-b"],"data":"echo hi\r"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	var parsed struct {
		Data broadcastResp `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("response not json: %v body=%s", err, w.Body.String())
	}
	if parsed.Data.Written != 0 {
		t.Fatalf("written = %d, want 0", parsed.Data.Written)
	}
	if len(parsed.Data.Missing) != 2 || parsed.Data.Missing[0] != "ghost-a" {
		t.Fatalf("missing not reported: %+v", parsed.Data)
	}
	if parsed.Data.Failed == nil {
		t.Fatalf("failed must serialize as [] not null")
	}
}
