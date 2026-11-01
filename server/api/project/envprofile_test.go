package project

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 环境画像端点单测（P-20261007-14）：fleet_test.go 同款最小引擎——store.SetDefault
// 落临时数据目录，逐源断言聚合/圈定/降级/脱敏。devports 源的会话归属反查不经
// DefaultManager 起真实 PTY，直接驱动纯聚合函数 devPortRows（fixture 条目 +
// 桩 lookup）；端到端（探测→画像页出现）由 e2e 覆盖——api/terminal/ports_test.go
// 同款分工注记

// envProfileRouter 装配 store + 画像路由的最小引擎（返回引擎供逐例自定义源）
func envProfileRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(filepath.Join(t.TempDir(), "data"))))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.GET("/api/projects/:id/env-profile", GetEnvProfile)
	return r
}

// envProfileSeed 注册一个项目并返回其 id
func envProfileSeed(t *testing.T, id, name string) {
	t.Helper()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: id, Name: name, Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
}

// TestGetEnvProfileEmpty 三源全空的诚实基线：devPorts 恒在（内存源）为空数组
// 而非 null（前端 .map 契约，ports_test.go 同防线）；无规则/无主机时两键以
// 空数组在场（读成功即在场——空是诚实值）
func TestGetEnvProfileEmpty(t *testing.T) {
	r := envProfileRouter(t)
	envProfileSeed(t, "p1", "demo")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/projects/p1/env-profile", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("should be 200, got %d: %s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			ProjectID     string           `json:"projectId"`
			DevPorts      []map[string]any `json:"devPorts"`
			Sentinels     []map[string]any `json:"sentinels"`
			DeployTargets []map[string]any `json:"deployTargets"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if body.Data.ProjectID != "p1" {
		t.Fatalf("projectId mismatch: %+v", body.Data)
	}
	if body.Data.DevPorts == nil || len(body.Data.DevPorts) != 0 {
		t.Fatalf("devPorts must be present empty array, got %+v", body.Data.DevPorts)
	}
	if body.Data.Sentinels == nil || len(body.Data.Sentinels) != 0 {
		t.Fatalf("sentinels must be present empty array, got %+v", body.Data.Sentinels)
	}
	if body.Data.DeployTargets == nil || len(body.Data.DeployTargets) != 0 {
		t.Fatalf("deployTargets must be present empty array, got %+v", body.Data.DeployTargets)
	}
}

// TestGetEnvProfileNotFound 未知项目 404（GetProjectFromContext 统一出口）
func TestGetEnvProfileNotFound(t *testing.T) {
	r := envProfileRouter(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/projects/ghost/env-profile", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("should be 404, got %d", w.Code)
	}
}

// TestGetEnvProfileSentinelScope 哨兵圈定：global 与本项目规则在场、他项目
// 规则不出（与 terminal 侧 appliesTo 同口径——空 scope 视作 global 的存量
// 兼容形态单列断言）
func TestGetEnvProfileSentinelScope(t *testing.T) {
	r := envProfileRouter(t)
	envProfileSeed(t, "p1", "demo")

	mk := func(name, scope, level string) {
		if _, err := store.Get().Sentinel.Create(store.SentinelRule{Name: name, Pattern: "OOM", Scope: scope, Level: level}); err != nil {
			t.Fatal(err)
		}
	}
	mk("全局盯 OOM", store.SentinelScopeGlobal, store.SentinelLevelError)
	mk("本项目盯死锁", "p1", store.SentinelLevelWarn)
	mk("别家项目规则", "other", store.SentinelLevelInfo)
	mk("存量空 scope", "", store.SentinelLevelWarn) // 旧数据面：空 scope = global

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/projects/p1/env-profile", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("should be 200, got %d", w.Code)
	}
	var body struct {
		Data struct {
			Sentinels []struct {
				ID    string `json:"id"`
				Name  string `json:"name"`
				Level string `json:"level"`
				Scope string `json:"scope"`
			} `json:"sentinels"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	names := make([]string, 0, len(body.Data.Sentinels))
	for _, s := range body.Data.Sentinels {
		if s.ID == "" || s.Level == "" {
			t.Fatalf("sentinel row missing id/level: %+v", s)
		}
		if s.Scope == "other" {
			t.Fatalf("foreign-project rule must not appear: %+v", body.Data.Sentinels)
		}
		names = append(names, s.Name)
	}
	if len(names) != 3 {
		t.Fatalf("want 3 visible rules (global+project+legacy-empty), got %d: %v", len(names), names)
	}
	for _, want := range []string{"全局盯 OOM", "本项目盯死锁", "存量空 scope"} {
		found := false
		for _, n := range names {
			if n == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("rule %q missing from profile: %v", want, names)
		}
	}
}

// TestGetEnvProfileDeployTargetsRedacted 部署目标摘要：名称/协议/认证形态在场，
// Host 地址明文与凭据字段绝不出现在响应体（fleet「只出摘要」纪律的对账断言——
// 结构体字段缺席 + 全响应体字面量扫描双保险）
func TestGetEnvProfileDeployTargetsRedacted(t *testing.T) {
	r := envProfileRouter(t)
	envProfileSeed(t, "p1", "demo")

	if _, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "build-host", Host: "192.168.7.42", Port: 22,
		User: "deploy", AuthType: "password", Password: "sup3rsecret",
	}); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/projects/p1/env-profile", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("should be 200, got %d", w.Code)
	}
	raw := w.Body.String()
	// 地址/用户名/口令任何形态都不出域（host 字段名与明文值双层扫描）
	for _, leaked := range []string{"192.168.7.42", "sup3rsecret", `"user"`, `"host"`, `"port"`} { // logsafe: 脱敏断言夹具——本行是「不得出现在响应里」的禁词清单字面量，非日志输出
		if strings.Contains(raw, leaked) {
			t.Fatalf("deploy target summary leaked %q: %s", leaked, raw)
		}
	}
	var body struct {
		Data struct {
			DeployTargets []struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				Protocol string `json:"protocol"`
				AuthType string `json:"authType"`
			} `json:"deployTargets"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if len(body.Data.DeployTargets) != 1 {
		t.Fatalf("want 1 target, got %+v", body.Data.DeployTargets)
	}
	row := body.Data.DeployTargets[0]
	if row.Name != "build-host" || row.Protocol != "sftp" || row.AuthType != "password" || row.ID == "" {
		t.Fatalf("summary fields wrong: %+v", row)
	}
}

// TestDevPortRowsProjectScope devports 会话归属反查（纯聚合函数直测，免起
// 真实 PTY）：本项目会话条目在场并带会话名、他项目/无主（幽灵反查不中）
// 条目跳过、输出保持端口升序
func TestDevPortRowsProjectScope(t *testing.T) {
	sessions := map[string]*terminal.Session{
		"s-a":   {ID: "s-a", Name: "vite 会话", ProjectID: "p1"},
		"s-b":   {ID: "s-b", Name: "别家", ProjectID: "p2"},
		"s-nil": {ID: "s-nil", Name: "无主", ProjectID: ""},
	}
	lookup := func(id string) *terminal.Session { return sessions[id] }
	now := time.Now()
	entries := []terminal.PortEntry{
		{Port: 3000, SessionID: "s-b", Label: "next", Source: terminal.PortSourceReported, FirstSeen: now, LastSeen: now},
		{Port: 5173, SessionID: "s-a", Label: "vite", Source: terminal.PortSourceDetected, FirstSeen: now, LastSeen: now},
		{Port: 8080, SessionID: "s-nil", Label: "orphan", Source: terminal.PortSourceDetected, FirstSeen: now, LastSeen: now},
		{Port: 9999, SessionID: "s-ghost", Label: "gone", Source: terminal.PortSourceDetected, FirstSeen: now, LastSeen: now},
	}

	rows := devPortRows(entries, lookup, "p1")
	if len(rows) != 1 {
		t.Fatalf("want 1 project-owned row, got %+v", rows)
	}
	if rows[0].Port != 5173 || rows[0].Label != "vite" || rows[0].SessionName != "vite 会话" {
		t.Fatalf("row fields wrong: %+v", rows[0])
	}
	if rows[0].FirstSeen == "" || rows[0].LastSeen == "" {
		t.Fatalf("timestamps must serialize RFC3339: %+v", rows[0])
	}
	if _, err := time.Parse(time.RFC3339, rows[0].LastSeen); err != nil {
		t.Fatalf("lastSeen not RFC3339: %v", err)
	}
}

// TestSentinelAppliesToProject 可见性判定与 terminal 侧 appliesTo 同口径
func TestSentinelAppliesToProject(t *testing.T) {
	cases := []struct {
		scope, project string
		want           bool
	}{
		{store.SentinelScopeGlobal, "p1", true},
		{"", "p1", true}, // 存量空 scope = global
		{"p1", "p1", true},
		{"p2", "p1", false},
	}
	for _, tc := range cases {
		if got := sentinelAppliesToProject(tc.scope, tc.project); got != tc.want {
			t.Fatalf("scope=%q project=%q: want %v got %v", tc.scope, tc.project, tc.want, got)
		}
	}
}
