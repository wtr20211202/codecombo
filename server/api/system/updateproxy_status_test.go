package system

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/update"
)

// 系统代理自动探测开关 + 出站档位状态端点（P-20261110-1 S6）：
//   - PUT /settings updateProxyAutoDetect 指针三态（默认关 / 保存 / 省略不动）；
//   - GET /updates/proxy-status 载荷形态（字段齐备 / 档位四值 / userinfo 脱敏 /
//     ?refresh=1 挂点语义）。探测与 env 经 update.SetProxyProbeHooksForTest 注入
//     假实现——断言不依赖、不读取宿主真实代理态

func autoDetectFromSettings(t *testing.T, r *gin.Engine) bool {
	t.Helper()
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			AutoDetect *bool `json:"updateProxyAutoDetect"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.AutoDetect == nil {
		t.Fatal("GET /settings must echo updateProxyAutoDetect")
	}
	return *got.Data.AutoDetect
}

func setupProxyStatusRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/updates/proxy-status", GetUpdateProxyStatus)
	t.Cleanup(func() {
		// 端点测试注入的出站态/钩子一并还原，不泄给包内其他测试
		_ = update.SetOutbound("", "github.com", false)
	})
	return r
}

func TestUpdateSettings_UpdateProxyAutoDetect(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 默认关（存量配置缺字段 = false，行为零变化）
	if got := autoDetectFromSettings(t, r); got {
		t.Fatal("default updateProxyAutoDetect must be false")
	}

	// 开：保存 + GET 回读 true
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"updateProxyAutoDetect":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save on status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := autoDetectFromSettings(t, r); !got {
		t.Fatal("saved updateProxyAutoDetect must be true")
	}

	// 省略字段 = 不动（设置页整体提交不带该键时不被清掉）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"autoFetch":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("omit save status = %d", w.Code)
	}
	if got := autoDetectFromSettings(t, r); !got {
		t.Fatal("omitted updateProxyAutoDetect must keep previous value")
	}

	// 关：显式 false 落盘
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"updateProxyAutoDetect":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save off status = %d", w.Code)
	}
	if got := autoDetectFromSettings(t, r); got {
		t.Fatal("explicit false must be saved")
	}
}

func proxyStatusFromAPI(t *testing.T, r *gin.Engine, query string) (int, map[string]any) {
	t.Helper()
	w := httptestGet(t, r, "/api/updates/proxy-status"+query)
	if w.Code != http.StatusOK {
		return w.Code, nil
	}
	var got struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode proxy-status: %v (body=%s)", err, w.Body.String())
	}
	return w.Code, got.Data
}

func httptestGet(t *testing.T, r *gin.Engine, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestGetUpdateProxyStatusShape 出站档位端点：字段齐备（恒在场，空值即显式无）、
// 档位四值、代理地址回显脱敏、开关态与探测元数据齐备
func TestGetUpdateProxyStatusShape(t *testing.T) {
	r := setupProxyStatusRouter(t)

	// 注入：探测到带凭据的系统代理、无显式无 env（探测档生效）
	restore := update.SetProxyProbeHooksForTest(
		func(context.Context) (string, string, error) {
			return "http://u:p@127.0.0.1:7890", "windows-registry", nil
		},
		func(*url.URL) (*url.URL, error) { return nil, nil },
		"",
	)
	t.Cleanup(restore)
	if err := update.SetOutbound("", "github.com", true); err != nil {
		t.Fatal(err)
	}
	// 挂点语义探测一次（装配点探测不经过本端点；此处等价于一次更新尝试边界）
	update.CurrentProxyStatus(context.Background(), true)

	code, data := proxyStatusFromAPI(t, r, "")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	// 字段齐备（agent 编程消费免判缺键）
	for _, key := range []string{"tier", "target", "proxy", "autoDetect", "detectedProxy",
		"detectedSource", "detectedAt", "detectError", "noProxyMatch"} {
		if _, ok := data[key]; !ok {
			t.Errorf("proxy-status response lacks field %q (got keys %v)", key, len(data))
		}
	}
	if data["tier"] != "sysdetect" {
		t.Errorf("tier = %v, want sysdetect", data["tier"])
	}
	if data["target"] != "github.com" {
		t.Errorf("target = %v, want github.com", data["target"])
	}
	if data["proxy"] != "http://***@127.0.0.1:7890" {
		t.Errorf("proxy echo = %v, want redacted userinfo", data["proxy"])
	}
	if data["autoDetect"] != true {
		t.Errorf("autoDetect = %v, want true", data["autoDetect"])
	}
	if data["detectedAt"] == "" {
		t.Error("detectedAt must be present after a probe")
	}
	if data["detectError"] != "" {
		t.Errorf("detectError = %v, want empty on success", data["detectError"])
	}

	// 显式档带凭据：生效地址同样脱敏
	if err := update.SetOutbound("socks5://user:pass@proxy.example:3128", "github.com", true); err != nil {
		t.Fatal(err)
	}
	_, data = proxyStatusFromAPI(t, r, "")
	if data["tier"] != "explicit" {
		t.Errorf("tier = %v, want explicit", data["tier"])
	}
	if data["proxy"] != "socks5://***@proxy.example:3128" {
		t.Errorf("proxy echo = %v, want redacted userinfo", data["proxy"])
	}

	// 开关关：refresh=1 仍零探测（挂点语义），档位按注入的 env 裁决
	probeCalls := 0
	restore2 := update.SetProxyProbeHooksForTest(
		func(context.Context) (string, string, error) {
			probeCalls++
			return "", "", nil
		},
		func(*url.URL) (*url.URL, error) { return nil, nil },
		"",
	)
	t.Cleanup(restore2)
	if err := update.SetOutbound("", "github.com", false); err != nil {
		t.Fatal(err)
	}
	_, data = proxyStatusFromAPI(t, r, "?refresh=1")
	if probeCalls != 0 {
		t.Errorf("refresh=1 with switch off probed %d times, want 0", probeCalls)
	}
	if data["tier"] != "direct" || data["autoDetect"] != false {
		t.Errorf("switch-off status = tier %v autoDetect %v, want direct/false", data["tier"], data["autoDetect"])
	}

	// 开关开：refresh=1 触发一次即时探测（探测结果随写快照）
	if err := update.SetOutbound("", "github.com", true); err != nil {
		t.Fatal(err)
	}
	_, data = proxyStatusFromAPI(t, r, "?refresh=1")
	if probeCalls != 1 {
		t.Errorf("refresh=1 with switch on probed %d times, want 1", probeCalls)
	}
	if data["tier"] != "direct" || data["detectedProxy"] != "" {
		t.Errorf("empty probe must report direct with empty detectedProxy, got %v / %v",
			data["tier"], data["detectedProxy"])
	}
	if data["detectError"] != "" {
		t.Errorf("clean empty probe must not set detectError, got %v", data["detectError"])
	}
}

// TestGetUpdateProxyStatusDetectionFailure 探测失败经 detectError 透出诊断（不冒泡
// 为请求失败），代理地址仍空
func TestGetUpdateProxyStatusDetectionFailure(t *testing.T) {
	r := setupProxyStatusRouter(t)
	restore := update.SetProxyProbeHooksForTest(
		func(context.Context) (string, string, error) {
			return "", "", errors.New("registry read failed")
		},
		func(*url.URL) (*url.URL, error) { return nil, nil },
		"",
	)
	t.Cleanup(restore)
	if err := update.SetOutbound("", "github.com", true); err != nil {
		t.Fatal(err)
	}

	code, data := proxyStatusFromAPI(t, r, "?refresh=1")
	if code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (detection failure must not fail the endpoint)", code)
	}
	if data["tier"] != "direct" {
		t.Errorf("tier = %v, want direct on failed probe", data["tier"])
	}
	if data["detectError"] == "" {
		t.Error("detectError must carry the diagnose reason")
	}
}
