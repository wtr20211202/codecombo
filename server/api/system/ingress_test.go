package system

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/middleware"
	"codecombo/server/store"
)

// ── 入口面总览（P-20261004-11） ──
// 覆盖：聚合形状（五分区齐备）、只读聚合口径（失败计数只出聚合/分享只出计数/
// 远程主机只出数量/agent token 只出 Meta）、敏感值零回显（IP 明细/分享 token/
// 令牌明文绝不出现）、失败计数的内存态聚合（含封禁计数）

func ingressRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.GET("/api/system/ingress-overview", IngressOverview)
	return r
}

func doGetIngress(t *testing.T, r *gin.Engine) (int, map[string]any, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/system/ingress-overview", nil)
	r.ServeHTTP(w, req)
	body := w.Body.String()
	var data map[string]any
	if err := json.Unmarshal([]byte(body), &data); err != nil {
		t.Fatalf("response not json: %v body=%s", err, body)
	}
	return w.Code, data, body
}

func TestIngressOverview_EmptyState(t *testing.T) {
	r := ingressRouter(t)
	code, data, _ := doGetIngress(t, r)
	if code != 200 {
		t.Fatalf("expected 200, got %d", code)
	}
	for _, key := range []string{"lock", "agentToken", "tls", "shares", "remoteHosts"} {
		if _, ok := data[key]; !ok {
			t.Errorf("missing section %q in %v", key, data)
		}
	}
	lock := data["lock"].(map[string]any)
	if lock["enabled"] != false || lock["needsSetup"] != true {
		t.Errorf("empty lock state expected disabled/needsSetup, got %v", lock)
	}
	failures := lock["failures"].(map[string]any)
	if failures["total"].(float64) != 0 || failures["ips"].(float64) != 0 || failures["blocked"].(float64) != 0 {
		t.Errorf("expected zero unlock failures, got %v", failures)
	}
	if data["agentToken"].(map[string]any)["exists"] != false {
		t.Errorf("expected agent token absent, got %v", data["agentToken"])
	}
	tlsState := data["tls"].(map[string]any)
	if tlsState["enabled"] != false || tlsState["loopbackPort"].(float64) != 0 {
		t.Errorf("expected TLS off/loopback port 0, got %v", tlsState)
	}
	if data["shares"].(map[string]any)["count"].(float64) != 0 {
		t.Errorf("expected 0 shares, got %v", data["shares"])
	}
	if data["remoteHosts"].(map[string]any)["count"].(float64) != 0 {
		t.Errorf("expected 0 remote hosts, got %v", data["remoteHosts"])
	}
}

func TestIngressOverview_SeededAggregatesAndZeroEcho(t *testing.T) {
	r := ingressRouter(t)

	// TLS 全局态（app 启动序列的写入面）本用例内显式置位 + 还原
	config.SetTLSEnabled(true)
	config.SetLoopbackPort(21001)
	t.Cleanup(func() {
		config.SetTLSEnabled(false)
		config.SetLoopbackPort(0)
	})
	// 失败计数为进程内存态：用例前置复位 + 用例后清理，不污染其他用例
	middleware.ResetLockUnlockRateLimitForTesting()
	t.Cleanup(middleware.ResetLockUnlockRateLimitForTesting)

	// 活跃分享 + 过期 snippet（不算敞口）+ 远程主机
	if _, err := store.Get().Share.Create(store.Share{
		Kind: store.ShareKindFile, ProjectID: "p1", ProjectName: "demo",
		Path: "docs/secret.md", Name: "secret.md", Size: 10,
		CreatedAt: time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create file share: %v", err)
	}
	if _, err := store.Get().Share.Create(store.Share{
		Kind: store.ShareKindSnippet, Name: "expired", Content: "boom",
		CreatedAt: time.Now().Add(-2 * store.SnippetTTL), ExpiresAt: time.Now().Add(-store.SnippetTTL),
	}); err != nil {
		t.Fatalf("create expired snippet: %v", err)
	}
	if _, err := store.Get().RemoteHost.Create(config.RemoteHost{Name: "build-01", Host: "10.0.0.8"}); err != nil {
		t.Fatalf("create remote host: %v", err)
	}
	if err := store.Get().AgentToken.Ensure(); err != nil {
		t.Fatalf("ensure agent token: %v", err)
	}
	plainToken := store.Get().AgentToken.Plain()

	// 解锁失败：两个来源 IP 共 11 次（其一连发 10 次达阈值进封禁态），走
	// Unlock 既有计数面（lockUnlockMaxFails=10 触发 60s 封禁）
	for i := 0; i < 10; i++ {
		middleware.RecordLockUnlockFailure("203.0.113.7")
	}
	if got := middleware.RecordLockUnlockFailure("203.0.113.99"); got != 1 {
		t.Fatalf("expected first failure count 1 for second ip, got %d", got)
	}

	code, data, body := doGetIngress(t, r)
	if code != 200 {
		t.Fatalf("expected 200, got %d body=%s", code, body)
	}

	// 失败计数：只出聚合（2 IP / 11 次 / 1 个被封禁），无任何 IP 明细字段
	failures := data["lock"].(map[string]any)["failures"].(map[string]any)
	if failures["total"].(float64) != 11 || failures["ips"].(float64) != 2 || failures["blocked"].(float64) != 1 {
		t.Errorf("failure aggregate mismatch: %v", failures)
	}
	if strings.Contains(body, "203.0.113.7") || strings.Contains(body, "203.0.113.99") {
		t.Error("source IP detail leaked into ingress overview")
	}

	// 分享只出计数：活跃 1（过期 snippet 不计），token/路径明细零回显
	shares := data["shares"].(map[string]any)
	if shares["count"].(float64) != 1 {
		t.Errorf("expected 1 active share, got %v", shares)
	}
	for _, leak := range []string{"docs/secret.md", "secret.md", "token"} {
		if _, has := shares[leak]; has {
			t.Errorf("share detail field %q must not appear in ingress overview", leak)
		}
	}

	// 远程主机只出数量
	if got := data["remoteHosts"].(map[string]any)["count"].(float64); got != 1 {
		t.Errorf("expected 1 remote host, got %v", got)
	}

	// agent token：Meta 形态（存在性/前 4 位/签发与轮换时点），明文零回显
	at := data["agentToken"].(map[string]any)
	if at["exists"] != true || at["createdAt"] == "" || at["rotatedAt"] == "" {
		t.Errorf("agent token meta mismatch: %v", at)
	}
	if plainToken != "" && strings.Contains(body, plainToken) {
		t.Error("agent token plaintext leaked into ingress overview")
	}

	// TLS 与回环辅助端口状态
	tlsState := data["tls"].(map[string]any)
	if tlsState["enabled"] != true || tlsState["loopbackPort"].(float64) != 21001 {
		t.Errorf("tls state mismatch: %v", tlsState)
	}
}

func TestIngressOverview_LockEnabledState(t *testing.T) {
	r := ingressRouter(t)
	if err := store.Get().Lock.SetupPassword("correct horse"); err != nil {
		t.Fatalf("setup lock: %v", err)
	}
	cfg := store.Get().Lock.GetConfig()
	cfg.Enabled = true
	if err := store.Get().Lock.SaveConfig(cfg); err != nil {
		t.Fatalf("save lock config: %v", err)
	}

	_, data, _ := doGetIngress(t, r)
	lock := data["lock"].(map[string]any)
	if lock["enabled"] != true || lock["needsSetup"] != false {
		t.Errorf("lock state mismatch: %v", lock)
	}
}
