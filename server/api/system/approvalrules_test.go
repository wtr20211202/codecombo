package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	filestore "codecombo/server/filestore"
	"codecombo/server/store"
)

// 审批分类规则（P-20261003-35）settings 面测试：PUT /settings 的
// agentApprovalRules 整体替换 + 校验拒绝 + GET 回读 + 命中测试端点

func setupApprovalRulesRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.GET("/api/settings", GetSettings)
	r.PUT("/api/settings", UpdateSettings)
	r.POST("/api/settings/approval-rules/test", TestApprovalRule)
	return r
}

func doSettingReq(t *testing.T, r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestUpdateSettings_ApprovalRules(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 整体替换保存 + GET 回读（nil 归一空数组的口径在保存后已非 nil）
	w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"agentApprovalRules":[{"opPattern":"git push","effect":"allow"},{"opPattern":"reset","effect":"deny"}]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			AgentApprovalRules []config.AgentApprovalRule `json:"agentApprovalRules"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Data.AgentApprovalRules) != 2 ||
		got.Data.AgentApprovalRules[0].OpPattern != "git push" ||
		got.Data.AgentApprovalRules[0].Effect != "allow" {
		t.Fatalf("roundtrip mismatch: %+v", got.Data.AgentApprovalRules)
	}

	// 省略字段 = 不动；显式空数组 = 全量清空
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"autoFetch":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d", w.Code)
	}
	cfg := store.Get().Settings.Get()
	if len(cfg.Server.AgentApprovalRules) != 2 {
		t.Fatalf("omit field must keep rules, got %d", len(cfg.Server.AgentApprovalRules))
	}
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"agentApprovalRules":[]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d", w.Code)
	}
	if cfg := store.Get().Settings.Get(); len(cfg.Server.AgentApprovalRules) != 0 {
		t.Fatalf("explicit empty must clear, got %d", len(cfg.Server.AgentApprovalRules))
	}
}

func TestUpdateSettings_ApprovalRulesValidation(t *testing.T) {
	r := setupApprovalRulesRouter(t)
	cases := []string{
		`{"agentApprovalRules":[{"opPattern":"","effect":"allow"}]}`,        // 空 pattern
		`{"agentApprovalRules":[{"opPattern":"x","effect":"maybe"}]}`,       // 非法 effect
		`{"agentApprovalRules":[{"opPattern":"  git  ","effect":"allow"}]}`, // 合法：首尾空白清洗
	}
	for i, body := range cases {
		w := doSettingReq(t, r, http.MethodPut, "/api/settings", body)
		shouldFail := i != 2
		if shouldFail && w.Code != http.StatusBadRequest {
			t.Fatalf("case %d expect 400, got %d body=%s", i, w.Code, w.Body.String())
		}
		if !shouldFail && w.Code != http.StatusOK {
			t.Fatalf("case %d expect 200, got %d body=%s", i, w.Code, w.Body.String())
		}
	}
	// 清洗后落盘：pattern 去首尾空白
	cfg := store.Get().Settings.Get()
	if len(cfg.Server.AgentApprovalRules) != 1 || cfg.Server.AgentApprovalRules[0].OpPattern != "git" {
		t.Fatalf("trim mismatch: %+v", cfg.Server.AgentApprovalRules)
	}
}

func TestTestApprovalRule(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 播种规则表
	if w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"agentApprovalRules":[{"opPattern":"git push","effect":"allow"},{"opPattern":"reset","effect":"deny"}]}`); w.Code != http.StatusOK {
		t.Fatalf("seed status = %d", w.Code)
	}

	// 命中 allow 规则
	w := doSettingReq(t, r, http.MethodPost, "/api/settings/approval-rules/test", `{"op":"git push origin main"}`)
	var got struct {
		Data struct {
			Effect  string `json:"effect"`
			RuleHit string `json:"ruleHit"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Data.Effect != "allow" || got.Data.RuleHit != "git push" {
		t.Fatalf("hit test expect allow + ruleHit, got %+v err=%v body=%s", got.Data, err, w.Body.String())
	}

	// 未命中 → 默认 ask
	w = doSettingReq(t, r, http.MethodPost, "/api/settings/approval-rules/test", `{"op":"status"}`)
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Data.Effect != "ask" || got.Data.RuleHit != "" {
		t.Fatalf("miss test expect ask, got %+v", got.Data)
	}

	// 空 op / 超长 op → 400（与真实入口同界）
	if w := doSettingReq(t, r, http.MethodPost, "/api/settings/approval-rules/test", `{"op":"  "}`); w.Code != http.StatusBadRequest {
		t.Fatalf("blank op expect 400, got %d", w.Code)
	}
	if w := doSettingReq(t, r, http.MethodPost, "/api/settings/approval-rules/test", `{"op":"`+strings.Repeat("a", 200)+`"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("long op expect 400, got %d", w.Code)
	}
}
