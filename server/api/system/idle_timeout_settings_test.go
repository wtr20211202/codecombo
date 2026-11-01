package system

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

// 终端空闲超时自动分离（P-20261003-192）settings 面测试：PUT 有效档 +
// 0=关闭 + 越界 400 + GET 出参回读

func TestUpdateSettings_TerminalIdleTimeoutMin(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 有效档位（8 小时 = 480 分钟）保存 + GET 回读
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"terminalIdleTimeoutMin":480}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save 480 status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			Min int `json:"terminalIdleTimeoutMin"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.Min != 480 {
		t.Fatalf("terminalIdleTimeoutMin = %d, want 480", got.Data.Min)
	}

	// e2e 注入档（1 分钟，UI 档位之下的下限）合法
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"terminalIdleTimeoutMin":1}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save 1 status = %d", w.Code)
	}

	// 显式关闭（0）合法——存量行为零变化
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"terminalIdleTimeoutMin":0}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save 0 status = %d", w.Code)
	}

	// 越界拒绝：负数与超上限（43200 = 30 天封顶）
	for _, bad := range []int{-1, 43201} {
		w = doSettingReq(t, r, http.MethodPut, "/api/settings",
			`{"terminalIdleTimeoutMin":`+strconv.Itoa(bad)+`}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid %d status = %d, want 400", bad, w.Code)
		}
	}
}

// 未配置（零值）时 GET 出参为 0（关）——存量配置升级零变化
func TestGetSettings_TerminalIdleTimeoutDefault(t *testing.T) {
	r := setupApprovalRulesRouter(t)
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			Min int `json:"terminalIdleTimeoutMin"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.Min != 0 {
		t.Fatalf("default terminalIdleTimeoutMin = %d, want 0 (off)", got.Data.Min)
	}
}
