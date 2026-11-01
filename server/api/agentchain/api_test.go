package agentchain

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// CRUD 端点单测：gin 测试上下文直驱 handler（不经路由表，鉴权由中间件层另行
// 负责，agentcron api_test 同款）；存储用真实 filestore，源会话存活判定换桩。

func newAPIEnv(t *testing.T) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	gin.SetMode(gin.TestMode)
	orig := defaultAliveFn
	defaultAliveFn = func(sessionID string) bool { return sessionID == "agent-live" }
	t.Cleanup(func() { defaultAliveFn = orig })
}

// call 以 JSON 体直驱单个 handler；id 非空时注入 :id 参数
func call(t *testing.T, handler gin.HandlerFunc, method, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	if body != "" {
		c.Request = httptest.NewRequest(method, "/api/agent-chains", strings.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
	} else {
		c.Request = httptest.NewRequest(method, "/api/agent-chains", nil)
	}
	if id != "" {
		c.Params = gin.Params{{Key: "id", Value: id}}
	}
	handler(c)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode response: %v\nbody: %s", err, w.Body.String())
	}
	return m
}

// TestCreateChain_Validation 校验面：必填/超限/未知运行时/源会话不在册一律
// 400 且不落库（创建时点校验 = 防打错目标的死链）
func TestCreateChain_Validation(t *testing.T) {
	newAPIEnv(t)
	for _, tc := range []struct{ body, wantMsg string }{
		{`{"promptTemplate":"p"}`, "sourceTerminalId is required"},
		{`{"sourceTerminalId":"agent-live"}`, "promptTemplate is required"},
		{`{"sourceTerminalId":"agent-live","promptTemplate":"` + strings.Repeat("x", 501) + `"}`, "promptTemplate too long (max 500 bytes)"},
		{`{"sourceTerminalId":"agent-live","promptTemplate":"p","runtime":"bogus"}`, "unknown runtime"},
		{`{"sourceTerminalId":"agent-live","promptTemplate":"p","dir":"Z:/definitely/not/exist"}`, "dir does not exist"},
		// 源会话不在册：400（死链不进库，列表侧的运行态失效与此分工不同）
		{`{"sourceTerminalId":"agent-ghost","promptTemplate":"p"}`, "source session not found"},
	} {
		w := call(t, CreateChain, http.MethodPost, "", tc.body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", tc.body, w.Code)
		}
		if msg, _ := decode(t, w)["error"].(string); msg != tc.wantMsg {
			t.Fatalf("body %s: error = %q, want %q", tc.body, msg, tc.wantMsg)
		}
	}
	if items, _ := store.Get().AgentChain.List(); len(items) != 0 {
		t.Fatalf("rejected payloads must not persist, got %d", len(items))
	}
}

// TestCreateChain_HappyPath 创建成功：201 + 服务端计算的存活态/源会话名；
// 恶意传入运行期事实不采信
func TestCreateChain_HappyPath(t *testing.T) {
	newAPIEnv(t)
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "agent-live", Name: "跑测试的会话"}); err != nil {
		t.Fatal(err)
	}
	w := call(t, CreateChain, http.MethodPost, "",
		`{"sourceTerminalId":"agent-live","promptTemplate":"p","runtime":"shell","onFailure":true,"triggerCount":42,"lastStatus":"launched"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	data, _ := decode(t, w)["data"].(map[string]any)
	if data["id"] == "" || data["sourceAlive"] != true || data["sourceName"] != "跑测试的会话" {
		t.Fatalf("create payload mismatch: %v", data)
	}
	if n, _ := data["triggerCount"].(float64); n != 0 {
		t.Fatalf("forged runtime facts must be dropped: %v", data)
	}
	if v, _ := data["onFailure"].(bool); !v {
		t.Fatalf("onFailure=true must persist: %v", data)
	}
}

// TestListChains_DeathMarking 列表存活态：源会话在册 true / 关闭后 false
// （死链置灰的服务端权威位）
func TestListChains_DeathMarking(t *testing.T) {
	newAPIEnv(t)
	w := call(t, CreateChain, http.MethodPost, "", `{"sourceTerminalId":"agent-live","promptTemplate":"p"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d", w.Code)
	}

	lw := call(t, ListChains, http.MethodGet, "", "")
	if lw.Code != http.StatusOK {
		t.Fatalf("list: %d", lw.Code)
	}
	items, _ := decode(t, lw)["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("list len = %d, want 1", len(items))
	}
	first, _ := items[0].(map[string]any)
	if first["sourceAlive"] != true {
		t.Fatalf("live source must be marked alive: %v", first)
	}

	// 源会话关闭（桩翻 false）→ 列表置灰位翻转，链记录本体保留
	defaultAliveFn = func(string) bool { return false }
	lw = call(t, ListChains, http.MethodGet, "", "")
	items, _ = decode(t, lw)["data"].([]any)
	first, _ = items[0].(map[string]any)
	if first["sourceAlive"] != false {
		t.Fatalf("dead source must be marked inert: %v", first)
	}
	if first["promptTemplate"] != "p" {
		t.Fatalf("chain definition must survive: %v", first)
	}
}

// TestDeleteChain 删除面：非法 ID 400 / 不存在 404 / 成功 200 后不可再删
func TestDeleteChain(t *testing.T) {
	newAPIEnv(t)
	if got := call(t, DeleteChain, http.MethodDelete, "not-a-chain-id", "").Code; got != http.StatusBadRequest {
		t.Fatalf("invalid id: %d, want 400", got)
	}
	if got := call(t, DeleteChain, http.MethodDelete, "chain-123", "").Code; got != http.StatusNotFound {
		t.Fatalf("missing id: %d, want 404", got)
	}
	w := call(t, CreateChain, http.MethodPost, "", `{"sourceTerminalId":"agent-live","promptTemplate":"p"}`)
	id, _ := decode(t, w)["data"].(map[string]any)["id"].(string)
	if got := call(t, DeleteChain, http.MethodDelete, id, "").Code; got != http.StatusOK {
		t.Fatalf("delete: %d, want 200", got)
	}
	if got := call(t, DeleteChain, http.MethodDelete, id, "").Code; got != http.StatusNotFound {
		t.Fatalf("double delete: %d, want 404", got)
	}
}
