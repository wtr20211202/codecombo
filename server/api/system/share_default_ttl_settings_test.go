package system

// 新建分享默认有效期设置（P-20261020-5）：GET 缺省 permanent；PUT 合法档
// permanent/1d/7d/30d + 空串等价 permanent；1h/未知值 400。

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestShareDefaultTTLSettings(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	read := func() string {
		t.Helper()
		w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
		var got struct {
			Data struct {
				TTL string `json:"shareDefaultTTL"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Data.TTL
	}

	// 未配置 = permanent（存量行为零变化）
	if v := read(); v != "permanent" {
		t.Fatalf("default shareDefaultTTL = %q, want permanent", v)
	}

	// 合法档位落盘 + 回读
	for _, v := range []string{"1d", "7d", "30d", "permanent", ""} {
		w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"shareDefaultTTL":"`+v+`"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("save %q status = %d, body=%s", v, w.Code, w.Body.String())
		}
		want := v
		if want == "" {
			want = "permanent"
		}
		if got := read(); got != want {
			t.Fatalf("after save %q got %q, want %q", v, got, want)
		}
	}

	// 1h 只允许单次创建选择，不可作为全局默认；未知值同样 400
	for _, bad := range []string{"1h", "2d", "forever"} {
		w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"shareDefaultTTL":"`+bad+`"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid %q status = %d, want 400", bad, w.Code)
		}
	}
}
