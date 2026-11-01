package system

import (
	"encoding/json"
	"net/http"
	"testing"
)

// 界面密度档（P-20261003-322）settings 面测试：PUT 白名单两档 + 空串归一默认 +
// 非法值 400 + GET 出参回读

func TestUpdateSettings_UIDensity(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 紧凑档保存 + GET 回读
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"uidensity":"compact"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save compact status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			UIDensity string `json:"uidensity"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UIDensity != "compact" {
		t.Fatalf("uidensity = %q, want compact", got.Data.UIDensity)
	}

	// 空串归一默认 comfortable（读取侧 UIDensityOrDefault 同口径）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"uidensity":""}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save empty status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UIDensity != "comfortable" {
		t.Fatalf("uidensity = %q, want comfortable (empty normalizes to default)", got.Data.UIDensity)
	}

	// 舒适档显式保存
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"uidensity":"comfortable"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save comfortable status = %d, body=%s", w.Code, w.Body.String())
	}

	// 非法值 400（白名单拒绝，防止脏值进配置让前端档位判定失控）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"uidensity":"cozy"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid uidensity status = %d, want 400", w.Code)
	}
}

// 未配置（零值）时 GET 出参收敛默认 comfortable——存量配置升级零变化
func TestGetSettings_UIDensityDefault(t *testing.T) {
	r := setupApprovalRulesRouter(t)
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			UIDensity string `json:"uidensity"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UIDensity != "comfortable" {
		t.Fatalf("default uidensity = %q, want comfortable", got.Data.UIDensity)
	}
}
