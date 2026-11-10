package system

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
)

// updateProxy 设置面（P-20261109-12）：PUT 校验/默认端口归一/空串清除/
// 省略不动，GET 回读同一存盘形态（默认空串 = 走环境变量感知，存量配置零变化）

func updateProxyFromSettings(t *testing.T, r *gin.Engine) string {
	t.Helper()
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			Proxy string `json:"updateProxy"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.Data.Proxy
}

func TestUpdateSettings_UpdateProxy(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 默认空串（未配置 = 环境变量感知，存量行为零变化）
	if got := updateProxyFromSettings(t, r); got != "" {
		t.Fatalf("default updateProxy = %q, want empty", got)
	}

	// 保存 + GET 回读：回环代理地址合法（本地 clash 端口正是目标场景）
	w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"updateProxy":"http://127.0.0.1:7890"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := updateProxyFromSettings(t, r); got != "http://127.0.0.1:7890" {
		t.Fatalf("updateProxy = %q, want saved value", got)
	}

	// 缺端口补默认（socks5→1080）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"updateProxy":"socks5://clash.example"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save socks5 status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := updateProxyFromSettings(t, r); got != "socks5://clash.example:1080" {
		t.Fatalf("updateProxy = %q, want default port normalized", got)
	}

	// 省略字段 = 不动（设置页整体提交不带该键时不被清掉）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"autoFetch":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("omit save status = %d", w.Code)
	}
	if got := updateProxyFromSettings(t, r); got != "socks5://clash.example:1080" {
		t.Fatalf("omitted field must keep value, got %q", got)
	}

	// 非法形态一律 400 且不落盘
	for _, bad := range []string{
		"ftp://proxy.example",
		"proxy.example:8080",        // 无 scheme
		"http://",                   // 无 host
		"http://proxy.example/path", // 代理地址无路径
	} {
		w := doSettingReq(t, r, http.MethodPut, "/api/settings",
			`{"updateProxy":"`+bad+`"}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid updateProxy %q status = %d, want 400", bad, w.Code)
		}
		if got := updateProxyFromSettings(t, r); got != "socks5://clash.example:1080" {
			t.Fatalf("invalid updateProxy %q must not be stored, got %q", bad, got)
		}
	}

	// 空串 = 清除
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"updateProxy":""}`)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d", w.Code)
	}
	if got := updateProxyFromSettings(t, r); got != "" {
		t.Fatalf("updateProxy = %q, want cleared", got)
	}
}
