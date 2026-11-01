package system

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 会话启动上下文（P-20261006-47）settings 面测试：未配置默认（存量配置升级零
// 变化）+ PUT 白名单多选 + 空串归一默认 + none 全关 + 非法 token 400 + GET 回读。
//
// 注意：默认值用例必须在写侧用例**之前**跑（Go 按文件内源码序执行）——
// config.Load() 是 sync.Once 缓存且返回共享指针，settingsRepo 无文档时回落它，
// 先跑的 PUT 会把落盘值泄进后续用例（uidensity 的默认用例靠「最后保存值恰好
// 等于默认值」幸存，此处显式排序不赌运气）。

// 未配置（零值）时 GET 出参收敛默认 git——存量配置升级零变化（P-176 现状语义）
func TestGetSettings_SessionContextDefault(t *testing.T) {
	r := setupApprovalRulesRouter(t)
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			SessionContext string `json:"sessionContext"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.SessionContext != "git" {
		t.Fatalf("default sessionContext = %q, want git（若此处非 git，说明本包内有先行用例写过 sessionContext——本文件的写侧用例须保持排在其后）", got.Data.SessionContext)
	}
}

func TestUpdateSettings_SessionContext(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	getSessionContext := func(t *testing.T) string {
		t.Helper()
		w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
		var got struct {
			Data struct {
				SessionContext string `json:"sessionContext"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Data.SessionContext
	}

	// 多选保存 + GET 回读（规范序：写侧输入乱序也归一 git,todos,env——
	// env = 项目环境画像注入源，P-20261007-14 增量追加在规范序尾部）
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"sessionContext":"env,todos,git"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save multi status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := getSessionContext(t); got != "git,todos,env" {
		t.Fatalf("sessionContext = %q, want canonical git,todos,env", got)
	}

	// 空串归一默认 git（P-176 既有行为零变化）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"sessionContext":""}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save empty status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := getSessionContext(t); got != "git" {
		t.Fatalf("sessionContext = %q, want git (empty normalizes to default)", got)
	}

	// none 全关（显式单值）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"sessionContext":"none"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save none status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := getSessionContext(t); got != "none" {
		t.Fatalf("sessionContext = %q, want none", got)
	}

	// 非法 token 400（白名单拒绝，防止脏值进配置让前端装配面失控）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"sessionContext":"git,wiki"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid token status = %d, want 400", w.Code)
	}

	// none 与多选组合同样 400（无意义的取值形态，保存期早反馈）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"sessionContext":"none,git"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("none combined status = %d, want 400", w.Code)
	}
}
