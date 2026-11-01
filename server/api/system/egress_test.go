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
	"codecombo/server/notification"
	"codecombo/server/store"
)

// ── 数据出域面总览（P-20261003-20） ──
// 覆盖：聚合形状（五分区齐备）、URL 脱敏（query 剥除/凭据形状路径段打码/原文
// 绝不回显）、分享只出活跃项且 token 不回显、agent token 只出元信息、远程主机
// 只出数量、审计计数随埋点增长

func egressRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.GET("/api/system/egress-overview", EgressOverview)
	return r
}

func doGetEgress(t *testing.T, r *gin.Engine) (int, map[string]any, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/system/egress-overview", nil)
	r.ServeHTTP(w, req)
	body := w.Body.String()
	var data map[string]any
	if err := json.Unmarshal([]byte(body), &data); err != nil {
		t.Fatalf("response not json: %v body=%s", err, body)
	}
	return w.Code, data, body
}

func TestEgressOverview_EmptyState(t *testing.T) {
	r := egressRouter(t)
	code, data, _ := doGetEgress(t, r)
	if code != 200 {
		t.Fatalf("expected 200, got %d", code)
	}
	for _, key := range []string{"webhook", "shares", "agentToken", "remoteHosts", "audit"} {
		if _, ok := data[key]; !ok {
			t.Errorf("missing section %q in %v", key, data)
		}
	}
	wh := data["webhook"].(map[string]any)
	if wh["enabled"] != false || wh["endpoint"] != "" {
		t.Errorf("empty webhook expected disabled/blank endpoint, got %v", wh)
	}
	if data["shares"].(map[string]any)["count"].(float64) != 0 {
		t.Errorf("expected 0 shares, got %v", data["shares"])
	}
	if data["agentToken"].(map[string]any)["exists"] != false {
		t.Errorf("expected agent token absent, got %v", data["agentToken"])
	}
	if data["remoteHosts"].(map[string]any)["count"].(float64) != 0 {
		t.Errorf("expected 0 remote hosts, got %v", data["remoteHosts"])
	}
	if data["audit"].(map[string]any)["total"].(float64) != 0 {
		t.Errorf("expected 0 audit events, got %v", data["audit"])
	}
}

func TestEgressOverview_SeededAggregatesAndMasks(t *testing.T) {
	r := egressRouter(t)

	// webhook：URL 含 query 密钥 + Bark 式路径 key → 双脱敏
	prefs := notification.DefaultPrefs()
	prefs.Webhook.Enabled = true
	prefs.Webhook.URL = "https://api.day.app/AbCdEf1234567890123456/?tokens=secretXYZ"
	if err := store.Get().Notification.SavePrefs(prefs); err != nil {
		t.Fatalf("save prefs: %v", err)
	}

	// 活跃分享：文件分享 + 24h snippet
	if _, err := store.Get().Share.Create(store.Share{
		Kind: store.ShareKindFile, ProjectID: "p1", ProjectName: "demo",
		Path: "docs/report.md", Name: "report.md", Size: 10,
		CreatedAt: time.Now().Add(-time.Hour),
	}); err != nil {
		t.Fatalf("create file share: %v", err)
	}
	if _, err := store.Get().Share.Create(store.Share{
		Kind: store.ShareKindSnippet, Name: "panic log", Content: "boom",
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(store.SnippetTTL),
	}); err != nil {
		t.Fatalf("create snippet: %v", err)
	}

	// 远程主机 + agent token + 审计埋点
	if _, err := store.Get().RemoteHost.Create(config.RemoteHost{Name: "build-01", Host: "10.0.0.8"}); err != nil {
		t.Fatalf("create remote host: %v", err)
	}
	if err := store.Get().AgentToken.Ensure(); err != nil {
		t.Fatalf("ensure agent token: %v", err)
	}
	plainToken := store.Get().AgentToken.Plain()
	store.Get().Audit.Append(store.AuditEvent{Action: store.AuditShareCreate, Result: store.AuditResultSuccess})
	store.Get().Audit.Append(store.AuditEvent{Action: store.AuditShareCreate, Result: store.AuditResultSuccess})

	code, data, body := doGetEgress(t, r)
	if code != 200 {
		t.Fatalf("expected 200, got %d body=%s", code, body)
	}

	// webhook 脱敏：路径 key 打码 + query 剥除；原文零回显
	wh := data["webhook"].(map[string]any)
	if wh["endpoint"] != "https://api.day.app/***/?…" {
		t.Errorf("masked endpoint mismatch: %v", wh["endpoint"])
	}
	if wh["enabled"] != true || wh["mode"] != "post" || wh["scope"] != "important" {
		t.Errorf("webhook flags mismatch: %v", wh)
	}
	if strings.Contains(body, "AbCdEf1234567890123456") || strings.Contains(body, "secretXYZ") {
		t.Error("raw webhook URL material leaked into egress overview")
	}

	// 分享：两种活跃形态在列，token 字段绝不出现
	shares := data["shares"].(map[string]any)
	if shares["count"].(float64) != 2 {
		t.Errorf("expected 2 active shares, got %v", shares)
	}
	items := shares["items"].([]any)
	kinds := map[string]bool{}
	for _, it := range items {
		m := it.(map[string]any)
		kinds[m["kind"].(string)] = true
		if _, has := m["token"]; has {
			t.Error("share token must not appear in egress overview")
		}
		if m["createdAt"] == nil {
			t.Error("share entry missing createdAt")
		}
	}
	if !kinds["file"] || !kinds["snippet"] {
		t.Errorf("expected both share kinds, got %v", kinds)
	}

	// 远程主机只出数量
	if got := data["remoteHosts"].(map[string]any)["count"].(float64); got != 1 {
		t.Errorf("expected 1 remote host, got %v", got)
	}

	// agent token：存在性与签发时间在、值不在
	at := data["agentToken"].(map[string]any)
	if at["exists"] != true || at["createdAt"] == "" {
		t.Errorf("agent token meta mismatch: %v", at)
	}
	if plainToken != "" && strings.Contains(body, plainToken) {
		t.Error("agent token plaintext leaked into egress overview")
	}

	// 审计计数
	if got := data["audit"].(map[string]any)["total"].(float64); got != 2 {
		t.Errorf("expected 2 audit events, got %v", got)
	}
}

// TestEgressShareEntries_ExpiredExcluded 过期分享不算敞口（store.Expired 语义的
// 消费端断言：直接以过期记录驱动过滤纯函数，不经文档存储造假数据）
func TestEgressShareEntries_ExpiredExcluded(t *testing.T) {
	now := time.Now()
	shares := []store.Share{
		{Kind: store.ShareKindFile, Name: "live", ProjectName: "p", CreatedAt: now},
		{Kind: store.ShareKindSnippet, Name: "dead", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)},
		{Kind: store.ShareKindSnippet, Name: "countdown", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
	}
	entries := egressShareEntries(shares, now)
	if len(entries) != 2 {
		t.Fatalf("expected 2 active entries, got %d: %v", len(entries), entries)
	}
	if entries[0]["name"] != "live" || entries[1]["name"] != "countdown" {
		t.Errorf("unexpected entries: %v", entries)
	}
	// 无过期时点（文件分享）不回 expiresAt；带过期时点的回
	if _, has := entries[0]["expiresAt"]; has {
		t.Errorf("file share should not carry expiresAt: %v", entries[0])
	}
	if entries[1]["expiresAt"] == nil {
		t.Errorf("snippet entry missing expiresAt: %v", entries[1])
	}
}

func TestMaskWebhookEndpoint(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"empty", "", ""},
		{"plain host only", "https://ntfy.sh", "https://ntfy.sh"},
		{"normal path kept", "https://ntfy.sh/my-topic", "https://ntfy.sh/my-topic"},
		{"query stripped", "https://example.com/push?key=SECRET123", "https://example.com/push?…"},
		{"bark key in path masked", "https://api.day.app/AbCdEf1234567890123456", "https://api.day.app/***"},
		{"keyed .send segment masked", "https://sctapi.ftqq.com/SENDKEY1234567890A.send", "https://sctapi.ftqq.com/***"},
		{"short filename kept", "https://hooks.example.com/cc/report.json", "https://hooks.example.com/cc/report.json"},
		{"get template query stripped", "https://hook.example.com/send?title={title}&body={body}", "https://hook.example.com/send?…"},
		{"unparsable no echo", "not a url", "<unparsable>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := maskWebhookEndpoint(tc.in); got != tc.want {
				t.Errorf("maskWebhookEndpoint(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
