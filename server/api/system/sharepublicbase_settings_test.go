package system

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
)

// sharePublicBaseUrl 设置面（P-20261020-2）：PUT 校验/尾斜杠归一/空串清除/
// 省略不动，GET 回读同一存盘形态（默认空串 = 自动选址，存量配置零变化）

func sharePublicBaseURLFromSettings(t *testing.T, r *gin.Engine) string {
	t.Helper()
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			URL string `json:"sharePublicBaseUrl"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.Data.URL
}

func TestUpdateSettings_SharePublicBaseURL(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 默认空串（未配置 = 自动选址）
	if got := sharePublicBaseURLFromSettings(t, r); got != "" {
		t.Fatalf("default sharePublicBaseUrl = %q, want empty", got)
	}

	// 尾斜杠归一 + GET 回读
	w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"sharePublicBaseUrl":"https://share.example.com:8443/"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := sharePublicBaseURLFromSettings(t, r); got != "https://share.example.com:8443" {
		t.Fatalf("sharePublicBaseUrl = %q, want normalized origin", got)
	}

	// 省略字段 = 不动（设置页整体提交不带该键时不被清掉）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"autoFetch":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("omit save status = %d", w.Code)
	}
	if got := sharePublicBaseURLFromSettings(t, r); got != "https://share.example.com:8443" {
		t.Fatalf("omitted field must keep value, got %q", got)
	}

	// 非法形态一律 400 且不落盘
	for _, bad := range []string{
		"https://user:pass@share.example.com",
		"https://share.example.com/sub",
		"https://share.example.com/?token=x",
		"https://share.example.com/#frag",
		"ftp://share.example.com",
	} {
		w = doSettingReq(t, r, http.MethodPut, "/api/settings",
			`{"sharePublicBaseUrl":`+jsonQuote(bad)+`}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid %q status = %d, want 400", bad, w.Code)
		}
		if got := sharePublicBaseURLFromSettings(t, r); got != "https://share.example.com:8443" {
			t.Fatalf("rejected write leaked: %q", got)
		}
	}

	// 空串 = 清除（回落自动选址）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"sharePublicBaseUrl":""}`)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d", w.Code)
	}
	if got := sharePublicBaseURLFromSettings(t, r); got != "" {
		t.Fatalf("after clear = %q, want empty", got)
	}
}
