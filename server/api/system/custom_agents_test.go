package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/agentops"
	"codecombo/server/config"
	filestore "codecombo/server/filestore"
	"codecombo/server/store"
)

// 自定义智能体 CRUD 测试：settings handler → 持久化 → agentops 注册表同步。
// 注册表是全局的，用例结束同步空列表摘除自定义段（内置不受影响）
func setupCustomAgentRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
	t.Cleanup(func() { agentops.SyncCustomAgents(nil) })

	r := gin.New()
	r.POST("/api/settings/custom-agents", CreateCustomAgent)
	r.PUT("/api/settings/custom-agents/:name", UpdateCustomAgent)
	r.DELETE("/api/settings/custom-agents/:name", DeleteCustomAgent)
	return r
}

func doCustomAgentReq(t *testing.T, r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

type customAgentsResp struct {
	Data struct {
		CustomAgents []config.CustomAgent `json:"customAgents"`
	} `json:"data"`
}

func TestCreateCustomAgent(t *testing.T) {
	r := setupCustomAgentRouter(t)

	w := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"gemini","displayName":"Gemini CLI","command":"gemini --yolo"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", w.Code, w.Body.String())
	}
	if !agentops.IsRegisteredProvider("gemini") {
		t.Fatal("创建后应即时注册进 Provider 注册表")
	}

	// 持久化：重新从 store 读回仍在
	cfg := store.Get().Settings.Get()
	if a := cfg.Server.FindCustomAgent("gemini"); a == nil || a.Command != "gemini --yolo" {
		t.Fatalf("自定义智能体未落库: %+v", cfg.Server.CustomAgents)
	}

	// 撞内置运行时名拒绝
	if w := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"claude","command":"claude-x"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("撞内置名应 400，实际 %d", w.Code)
	}
	// 保留名拒绝
	if w := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"shell","command":"sh"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("保留名 shell 应 400，实际 %d", w.Code)
	}
	// 非法字符拒绝
	if w := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"Has Space","command":"x"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("非法注册名应 400，实际 %d", w.Code)
	}
	// 空命令拒绝
	if w := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"okname","command":"   "}`); w.Code != http.StatusBadRequest {
		t.Fatalf("空命令应 400，实际 %d", w.Code)
	}

	var resp customAgentsResp
	_ = json.Unmarshal(w.Body.Bytes(), &resp) // 最后一个失败响应也应是 JSON 错误体
	wOK := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"aider","command":"aider --model x"}`)
	_ = json.Unmarshal(wOK.Body.Bytes(), &resp)
	if len(resp.Data.CustomAgents) != 2 {
		t.Fatalf("响应应返回全量自定义列表，实际 %+v", resp.Data.CustomAgents)
	}
}

func TestUpdateCustomAgentRenameMigratesConfig(t *testing.T) {
	r := setupCustomAgentRouter(t)

	if w := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"gemini","displayName":"Gemini","command":"gemini"}`); w.Code != http.StatusOK {
		t.Fatalf("seed create failed: %s", w.Body.String())
	}
	// 预置：启动命令覆盖 + 默认智能体都指向旧名（改名应跟着迁移）
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentLaunchCommands = map[string]string{"gemini": "gemini --flash"}
	cfg.Server.AgentProvider = "gemini"
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatal(err)
	}

	// 改名撞其他运行时拒绝
	if w := doCustomAgentReq(t, r, "PUT", "/api/settings/custom-agents/gemini",
		`{"name":"codex","command":"codex"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("改名撞内置运行时应 400，实际 %d", w.Code)
	}

	w := doCustomAgentReq(t, r, "PUT", "/api/settings/custom-agents/gemini",
		`{"name":"gemini-cli","displayName":"Gemini CLI","command":"gemini --yolo"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("rename failed: %d %s", w.Code, w.Body.String())
	}
	if agentops.IsRegisteredProvider("gemini") || !agentops.IsRegisteredProvider("gemini-cli") {
		t.Fatal("改名后注册表应换新名")
	}
	cfg = store.Get().Settings.Get()
	if cfg.Server.FindCustomAgent("gemini") != nil || cfg.Server.FindCustomAgent("gemini-cli") == nil {
		t.Fatalf("改名未落库: %+v", cfg.Server.CustomAgents)
	}
	if cfg.Server.AgentLaunchCommands["gemini-cli"] != "gemini --flash" {
		t.Fatalf("启动命令覆盖应随改名迁移: %v", cfg.Server.AgentLaunchCommands)
	}
	if cfg.Server.AgentProvider != "gemini-cli" {
		t.Fatalf("默认智能体选型应随改名迁移: %s", cfg.Server.AgentProvider)
	}

	// 只改命令不传 name = 沿用旧名
	if w := doCustomAgentReq(t, r, "PUT", "/api/settings/custom-agents/gemini-cli",
		`{"displayName":"Gemini CLI 2","command":"gemini --flash"}`); w.Code != http.StatusOK {
		t.Fatalf("update failed: %s", w.Body.String())
	}
	if a := store.Get().Settings.Get().Server.FindCustomAgent("gemini-cli"); a == nil || a.Command != "gemini --flash" {
		t.Fatalf("未传 name 应沿用旧名更新: %+v", store.Get().Settings.Get().Server.CustomAgents)
	}

	// 更新不存在的项 404
	if w := doCustomAgentReq(t, r, "PUT", "/api/settings/custom-agents/ghost",
		`{"command":"x"}`); w.Code != http.StatusNotFound {
		t.Fatalf("更新不存在的项应 404，实际 %d", w.Code)
	}
}

func TestDeleteCustomAgentCascades(t *testing.T) {
	r := setupCustomAgentRouter(t)

	if w := doCustomAgentReq(t, r, "POST", "/api/settings/custom-agents",
		`{"name":"gemini","command":"gemini"}`); w.Code != http.StatusOK {
		t.Fatalf("seed create failed: %s", w.Body.String())
	}
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentLaunchCommands = map[string]string{"gemini": "gemini --yolo"}
	cfg.Server.AgentProvider = "gemini"
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatal(err)
	}

	w := doCustomAgentReq(t, r, "DELETE", "/api/settings/custom-agents/gemini", "")
	if w.Code != http.StatusOK {
		t.Fatalf("delete failed: %d %s", w.Code, w.Body.String())
	}
	if agentops.IsRegisteredProvider("gemini") {
		t.Fatal("删除后应从注册表摘除")
	}
	cfg = store.Get().Settings.Get()
	if cfg.Server.FindCustomAgent("gemini") != nil {
		t.Fatal("删除未落库")
	}
	if _, hit := cfg.Server.AgentLaunchCommands["gemini"]; hit {
		t.Fatal("该运行时的启动命令覆盖应级联清理")
	}
	if cfg.Server.AgentProvider != "auto" {
		t.Fatalf("指向已删运行时的默认选型应回落 auto，实际 %s", cfg.Server.AgentProvider)
	}

	// 重复删除 404
	if w := doCustomAgentReq(t, r, "DELETE", "/api/settings/custom-agents/gemini", ""); w.Code != http.StatusNotFound {
		t.Fatalf("删除不存在的项应 404，实际 %d", w.Code)
	}
}
