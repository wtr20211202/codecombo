package ai

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

// GetOpsManual 的 baseURL 三态（P-20261004-129）：baseURL 是全部 agent 调用的
// 起点（手册每个端点示例都拼它），判定收口在 shared.RequestBaseURL——本组测试
// 钉住「手册文本拿到的 base 与真实入口一致」这一契约，三态各断言到手册正文。

// setupManualTest ops-manual 路由测试装配（与 setupNotifyTest 同构；manual 无
// store 依赖，分节注册表为空也不影响 base 断言——头部 whoami 示例自带 {{BASE}}）
func setupManualTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/ops-manual", GetOpsManual)
	return r
}

// manualResponse GetOpsManual JSON 响应体（只取断言所需字段）
type manualResponse struct {
	Data struct {
		Manual  string `json:"manual"`
		BaseURL string `json:"baseURL"`
	} `json:"data"`
}

func getManual(r *gin.Engine, target string, headers map[string]string) (*httptest.ResponseRecorder, manualResponse) {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var resp manualResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		return w, resp
	}
	return w, resp
}

// trustManualTestPeer 把 httptest 缺省直连对端（192.0.2.1）列入可信代理：
// P-20261020-1 起 RequestBaseURL 仅在直连对端是可信代理时采信转发头
func trustManualTestPeer(t *testing.T) {
	t.Helper()
	if err := shared.SetTrustedProxies([]string{"192.0.2.1"}); err != nil {
		t.Fatalf("SetTrustedProxies: %v", err)
	}
	t.Cleanup(func() { _ = shared.SetTrustedProxies(nil) })
}

// TestGetOpsManual_BaseURL_ForwardedHTTPS 反代终止 TLS 形态：双转发头在场且
// 直连对端是可信代理 → 手册 base 用转发值——否则手册教 agent 用 http 入口，
// 撞重定向/混合内容失败
func TestGetOpsManual_BaseURL_ForwardedHTTPS(t *testing.T) {
	trustManualTestPeer(t)
	r := setupManualTest(t)
	w, resp := getManual(r, "http://127.0.0.1:3080/ops-manual", map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "sc.example.com",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if resp.Data.BaseURL != "https://sc.example.com" {
		t.Fatalf("baseURL expect forwarded https, got %q", resp.Data.BaseURL)
	}
	// 手册正文里的端点示例（whoami 引导第一步）拼的是 https base
	if !strings.Contains(resp.Data.Manual, "https://sc.example.com") {
		t.Fatalf("manual expect https base in examples, got %q", resp.Data.Manual)
	}
	if strings.Contains(resp.Data.Manual, "http://sc.example.com") || strings.Contains(resp.Data.Manual, "http://127.0.0.1:3080") {
		t.Fatalf("manual must not teach wrong-scheme base, got %q", resp.Data.Manual)
	}
}

// TestGetOpsManual_BaseURL_DirectTLS 直连 TLS 形态（--tls 自带证书，Request.TLS
// 非空）→ https base。经前置 handler 注入 TLS 态模拟 net/http 的注入行为
func TestGetOpsManual_BaseURL_DirectTLS(t *testing.T) {
	r := setupManualTest(t)
	r.GET("/ops-manual-tls", func(c *gin.Context) {
		c.Request.TLS = &tls.ConnectionState{}
		GetOpsManual(c)
	})

	req := httptest.NewRequest(http.MethodGet, "http://sc.local:3080/ops-manual-tls", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	var resp manualResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, w.Body.String())
	}
	if resp.Data.BaseURL != "https://sc.local:3080" {
		t.Fatalf("baseURL expect direct-TLS https, got %q", resp.Data.BaseURL)
	}
	if !strings.Contains(resp.Data.Manual, "https://sc.local:3080") {
		t.Fatalf("manual expect https base in examples, got %q", resp.Data.Manual)
	}
}

// TestGetOpsManual_BaseURL_Default 缺省回归：明文直连维持 http base（既有形态
// 零变化——本地优先产品的默认部署不受影响）
func TestGetOpsManual_BaseURL_Default(t *testing.T) {
	r := setupManualTest(t)
	w, resp := getManual(r, "http://127.0.0.1:3080/ops-manual", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if resp.Data.BaseURL != "http://127.0.0.1:3080" {
		t.Fatalf("baseURL expect default http, got %q", resp.Data.BaseURL)
	}
	if !strings.Contains(resp.Data.Manual, "http://127.0.0.1:3080/api/whoami") {
		t.Fatalf("manual expect http base in examples, got %q", resp.Data.Manual)
	}
}

// TestGetOpsManual_SkillFormat ?format=skill 形态照常工作（SKILL.md 首层约定走
// $CC_BASE_URL 环境变量、无 {{BASE}} 占位，base 形参经替换口自然为无操作——
// 反代形态不改变 skill 输出；钉住下载头与 200 不被 base 判定破坏）
func TestGetOpsManual_SkillFormat(t *testing.T) {
	trustManualTestPeer(t)
	r := setupManualTest(t)
	w, _ := getManual(r, "http://127.0.0.1:3080/ops-manual?format=skill", map[string]string{
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "sc.example.com",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if cd := w.Header().Get("Content-Disposition"); cd == "" {
		t.Fatalf("skill format expect Content-Disposition header, got none")
	}
	if w.Body.Len() == 0 {
		t.Fatalf("skill format expect non-empty body")
	}
}
