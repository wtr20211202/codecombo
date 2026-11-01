package terminal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupTerminalHistoryRouter 构造测试 router：独立 store + 预置一个项目 + 注册路由
func setupTerminalHistoryRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	if err := store.Get().Project.Create(config.ProjectConfig{
		ID: "proj-1", Name: "demo", Path: t.TempDir(),
	}); err != nil {
		t.Fatalf("create project: %v", err)
	}

	r := gin.New()
	api := r.Group("/api")
	api.POST("/projects/:id/terminal-history", RecordTerminalHistory)
	api.GET("/projects/:id/terminal-history", ListTerminalHistory)
	api.DELETE("/projects/:id/terminal-history", ClearTerminalHistory)
	api.DELETE("/projects/:id/terminal-history/:idx", DeleteTerminalHistoryEntry)
	api.GET("/terminal-history/search", SearchTerminalHistoryGlobal)
	return r
}

func doJSON(t *testing.T, r *gin.Engine, method, url, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, url, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, url, nil)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestTerminalHistoryHandlersCRUD(t *testing.T) {
	r := setupTerminalHistoryRouter(t)

	// 记录两条（一成功一失败）
	w := doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"go build ./...","exitCode":0,"durationMs":1200}`)
	if w.Code != 200 {
		t.Fatalf("POST ok cmd: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"go test ./...","exitCode":1,"durationMs":3400}`)
	if w.Code != 200 {
		t.Fatalf("POST failed cmd: expected 200, got %d", w.Code)
	}

	// 查询：倒序 + failedOnly 过滤
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history", "")
	if w.Code != 200 {
		t.Fatalf("GET: expected 200, got %d", w.Code)
	}
	var listRes struct {
		Data []store.HistoryEntry `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 2 || listRes.Data[0].Command != "go test ./..." {
		t.Fatalf("unexpected list: %+v", listRes.Data)
	}
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history?failedOnly=true", "")
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 1 || listRes.Data[0].Command != "go test ./..." {
		t.Fatalf("unexpected failedOnly list: %+v", listRes.Data)
	}

	// 删除单条（倒序 idx 0 = 最新）
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history/0", "")
	if w.Code != 200 {
		t.Fatalf("DELETE entry: expected 200, got %d", w.Code)
	}
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history/9", "")
	if w.Code != 404 {
		t.Fatalf("DELETE out-of-range: expected 404, got %d", w.Code)
	}

	// 清空
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history", "")
	if w.Code != 200 {
		t.Fatalf("DELETE clear: expected 200, got %d", w.Code)
	}
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history", "")
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 0 {
		t.Fatalf("expected empty after clear, got %+v", listRes.Data)
	}
}

// TestTerminalHistoryHandlersDeleteByAt 单条删除 at 形态（P-20261003-63 面板
// 条目删除走 ?at= 身份删除）：删一条其余保留、坏 at 400、未知 at 404、
// 全清仍可用且清后 at 删不复活
func TestTerminalHistoryHandlersDeleteByAt(t *testing.T) {
	r := setupTerminalHistoryRouter(t)

	for _, cmd := range []string{"alpha", "beta"} {
		w := doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
			fmt.Sprintf(`{"command":%q,"exitCode":0,"durationMs":1}`, cmd))
		if w.Code != 200 {
			t.Fatalf("POST %s: expected 200, got %d", cmd, w.Code)
		}
	}

	// 从 GET 取 alpha 的 at（与面板快照同一来源）
	w := doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history", "")
	var listRes struct {
		Data []store.HistoryEntry `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 2 {
		t.Fatalf("expected 2 entries, got %+v", listRes.Data)
	}
	var atAlpha string
	for _, e := range listRes.Data {
		if e.Command == "alpha" {
			atAlpha = e.At.Format(time.RFC3339Nano)
		}
	}
	if atAlpha == "" {
		t.Fatalf("alpha not in list: %+v", listRes.Data)
	}

	// at 身份删除（占位段 entry）：只少 alpha，beta 保留
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history/entry?at="+url.QueryEscape(atAlpha), "")
	if w.Code != 200 {
		t.Fatalf("DELETE by at: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history", "")
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 1 || listRes.Data[0].Command != "beta" {
		t.Fatalf("expected only beta retained, got %+v", listRes.Data)
	}

	// 坏 at → 400；未知 at → 404
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history/entry?at=not-a-time", "")
	if w.Code != 400 {
		t.Errorf("bad at: expected 400, got %d", w.Code)
	}
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history/entry?at=2000-01-01T00:00:00Z", "")
	if w.Code != 404 {
		t.Errorf("unknown at: expected 404, got %d", w.Code)
	}

	// 全清仍可用；清后按 at 删无残留可命中（不复活）
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history", "")
	if w.Code != 200 {
		t.Fatalf("clear: expected 200, got %d", w.Code)
	}
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history/entry?at="+url.QueryEscape(atAlpha), "")
	if w.Code != 404 {
		t.Errorf("at-delete after clear: expected 404, got %d", w.Code)
	}
}

func TestTerminalHistoryHandlersValidation(t *testing.T) {
	r := setupTerminalHistoryRouter(t)

	// 项目不存在 → 404
	w := doJSON(t, r, "POST", "/api/projects/nope/terminal-history",
		`{"command":"echo hi"}`)
	if w.Code != 404 {
		t.Errorf("unknown project: expected 404, got %d", w.Code)
	}
	w = doJSON(t, r, "GET", "/api/projects/nope/terminal-history", "")
	if w.Code != 404 {
		t.Errorf("unknown project GET: expected 404, got %d", w.Code)
	}

	// 空命令 → 400
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"   "}`)
	if w.Code != 400 {
		t.Errorf("empty command: expected 400, got %d", w.Code)
	}
	// 超 8KB → 400
	long := strings.Repeat("a", 8193)
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		fmt.Sprintf(`{"command":"%s"}`, long))
	if w.Code != 400 {
		t.Errorf("oversized command: expected 400, got %d", w.Code)
	}
	// 非法 JSON → 400
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history", `{invalid`)
	if w.Code != 400 {
		t.Errorf("invalid json: expected 400, got %d", w.Code)
	}
	// 非法 idx → 400
	w = doJSON(t, r, "DELETE", "/api/projects/proj-1/terminal-history/abc", "")
	if w.Code != 400 {
		t.Errorf("invalid idx: expected 400, got %d", w.Code)
	}
}

func TestTerminalHistoryDisabledSetting(t *testing.T) {
	r := setupTerminalHistoryRouter(t)

	// 默认开：记录成功
	w := doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"echo on"}`)
	if w.Code != 200 {
		t.Fatalf("default enabled POST: expected 200, got %d", w.Code)
	}

	// 显式关闭：静默丢弃（200 但不入库）
	off := false
	cfg := store.Get().Settings.Get()
	cfg.Server.TerminalHistoryEnabled = &off
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"echo off"}`)
	if w.Code != 200 {
		t.Fatalf("disabled POST: expected 200, got %d", w.Code)
	}

	entries, err := store.Get().TerminalHistory.Search("proj-1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(entries) != 1 || entries[0].Command != "echo on" {
		t.Fatalf("expected only enabled-period entry, got %+v", entries)
	}
}

// TestTerminalHistorySearchGlobal 跨项目聚合检索端点（P-20261004-2）：q 下限校验、
// 双项目命中带项目名、limit 生效、已删项目孤儿文档不进检索面
func TestTerminalHistorySearchGlobal(t *testing.T) {
	r := setupTerminalHistoryRouter(t)
	// 显式回正记录开关：TestTerminalHistoryDisabledSetting 会就地改写
	// config.Load() 的 once 单例（TerminalHistoryEnabled=false），套件内先跑
	// 它会让本测试的 POST 静默丢弃（200 但不入库）——新 store 的 settings
	// 无文档时回落到同一被污染的单例指针
	on := true
	store.Get().Settings.Get().Server.TerminalHistoryEnabled = &on

	// 第二个项目（双命中前提）
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID: "proj-2", Name: "beta", Path: t.TempDir(),
	}); err != nil {
		t.Fatalf("create project 2: %v", err)
	}

	// 双项目各记一条含 docker 的命令
	for _, tc := range []struct {
		proj, cmd string
		code      int
	}{
		{"proj-1", "docker compose up -d", 0},
		{"proj-2", "DOCKER ps -a", 125},
	} {
		w := doJSON(t, r, "POST", "/api/projects/"+tc.proj+"/terminal-history",
			fmt.Sprintf(`{"command":%q,"exitCode":%d,"durationMs":100}`, tc.cmd, tc.code))
		if w.Code != 200 {
			t.Fatalf("POST %s: expected 200, got %d", tc.proj, w.Code)
		}
	}
	// 孤儿文档：项目已删（无 proj-ghost 注册）但历史文档在
	w := doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history", `{"command":"seed-ghost"}`)
	if w.Code != 200 {
		t.Fatalf("POST seed: expected 200, got %d", w.Code)
	}
	if err := store.Get().TerminalHistory.Append("proj-ghost", store.HistoryEntry{Command: "ghost docker cmd"}); err != nil {
		t.Fatalf("Append orphan: %v", err)
	}

	// q 过短（1 字符）→ 400
	w = doJSON(t, r, "GET", "/api/terminal-history/search?q=d", "")
	if w.Code != 400 {
		t.Errorf("short q: expected 400, got %d body=%s", w.Code, w.Body.String())
	}
	// 缺 q → 400
	w = doJSON(t, r, "GET", "/api/terminal-history/search", "")
	if w.Code != 400 {
		t.Errorf("missing q: expected 400, got %d", w.Code)
	}

	// 正常检索：双项目命中，项目名补齐，孤儿项目被过滤
	w = doJSON(t, r, "GET", "/api/terminal-history/search?q=docker", "")
	if w.Code != 200 {
		t.Fatalf("search: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var res struct {
		Data []terminalHistorySearchHit `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(res.Data) != 2 {
		t.Fatalf("expected 2 hits (orphan filtered), got %d: %+v", len(res.Data), res.Data)
	}
	// 全局时间倒序：proj-2 后写入在前
	first, second := res.Data[0], res.Data[1]
	if first.ProjectID != "proj-2" || first.ProjectName != "beta" || first.Command != "DOCKER ps -a" || first.ExitCode != 125 {
		t.Errorf("unexpected first hit: %+v", first)
	}
	if second.ProjectID != "proj-1" || second.ProjectName != "demo" || second.Command != "docker compose up -d" {
		t.Errorf("unexpected second hit: %+v", second)
	}

	// limit=1：只返回最新一条
	w = doJSON(t, r, "GET", "/api/terminal-history/search?q=docker&limit=1", "")
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal limit: %v", err)
	}
	if len(res.Data) != 1 || res.Data[0].ProjectID != "proj-2" {
		t.Errorf("limit=1: expected only newest hit, got %+v", res.Data)
	}

	// 无命中：200 + 空数组（非 null）
	w = doJSON(t, r, "GET", "/api/terminal-history/search?q=zzz-nothing", "")
	if w.Code != 200 {
		t.Fatalf("no-hit search: expected 200, got %d", w.Code)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal no-hit: %v", err)
	}
	if res.Data == nil || len(res.Data) != 0 {
		t.Errorf("expected empty array, got %+v", res.Data)
	}
}

// TestTerminalHistoryHandlersSessionAttribution 会话归属（P-20261004-35）：
// POST body terminalId 可选落盘、GET ?terminalId= 会话过滤、无 terminalId 的
// 旧调用方请求不受影响（未归属组）
func TestTerminalHistoryHandlersSessionAttribution(t *testing.T) {
	r := setupTerminalHistoryRouter(t)

	// 带归属上报（新调用方形态）
	w := doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"echo from-a","exitCode":0,"durationMs":10,"terminalId":"term-A"}`)
	if w.Code != 200 {
		t.Fatalf("POST with terminalId: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	// 不带归属上报（旧调用方形态，零迁移兼容）
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"echo legacy","exitCode":0,"durationMs":10}`)
	if w.Code != 200 {
		t.Fatalf("POST without terminalId: expected 200, got %d", w.Code)
	}

	var listRes struct {
		Data []store.HistoryEntry `json:"data"`
	}
	// 全量：两条都在，归属字段只在带归属条目上
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history", "")
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 2 {
		t.Fatalf("expected 2 entries, got %+v", listRes.Data)
	}
	// 倒序最新在前：后上报的 legacy 条目在前
	if listRes.Data[0].TerminalID != "" || listRes.Data[1].TerminalID != "term-A" {
		t.Fatalf("attribution mismatch: %+v", listRes.Data)
	}

	// ?terminalId= 过滤：仅该会话条目
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history?terminalId=term-A", "")
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 1 || listRes.Data[0].Command != "echo from-a" {
		t.Fatalf("terminalId filter mismatch: %+v", listRes.Data)
	}

	// 超长 terminalId 静默截断而非 400（归属是附加信息，不让上报整条失败）
	longID := strings.Repeat("x", 300)
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		fmt.Sprintf(`{"command":"echo long","exitCode":0,"durationMs":10,"terminalId":%q}`, longID))
	if w.Code != 200 {
		t.Fatalf("POST long terminalId: expected 200, got %d", w.Code)
	}
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history?terminalId="+url.QueryEscape(longID), "")
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 0 {
		t.Fatalf("truncated id must not match full-length filter, got %+v", listRes.Data)
	}
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history?q=echo%20long", "")
	if err := json.Unmarshal(w.Body.Bytes(), &listRes); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(listRes.Data) != 1 || len(listRes.Data[0].TerminalID) != 128 {
		t.Fatalf("long terminalId should truncate to 128 bytes: %+v", listRes.Data)
	}
}

// TestTerminalHistoryHandlersSourceHost 来源与主机键透传（P-20261005-188）：
// POST body source/host 可选落盘并经全局检索透传；source 白名单外取值回落
// osc 缺省（增量扩展不开自由文本口子）；旧调用方（无 source/host 键）零感知
func TestTerminalHistoryHandlersSourceHost(t *testing.T) {
	r := setupTerminalHistoryRouter(t)

	// 输入域条目：source=input + host=主机键
	w := doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"kubectl get pods","exitCode":0,"durationMs":0,"source":"input","host":"host-9","terminalId":"rterm-1"}`)
	if w.Code != 200 {
		t.Fatalf("POST input entry: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	// 白名单外 source：回落 osc 缺省（落盘无 source 键）
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history",
		`{"command":"make all","source":"hacked","host":"host-x"}`)
	if w.Code != 200 {
		t.Fatalf("POST unknown source: expected 200, got %d", w.Code)
	}
	// 旧形态调用方：无 source/host 键零感知
	w = doJSON(t, r, "POST", "/api/projects/proj-1/terminal-history", `{"command":"git status","exitCode":0,"durationMs":50}`)
	if w.Code != 200 {
		t.Fatalf("POST legacy shape: expected 200, got %d", w.Code)
	}

	// 项目 GET：source/host 原样读回
	w = doJSON(t, r, "GET", "/api/projects/proj-1/terminal-history", "")
	if w.Code != 200 {
		t.Fatalf("GET: expected 200, got %d", w.Code)
	}
	var list struct {
		Data []store.HistoryEntry `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	if len(list.Data) != 3 {
		t.Fatalf("expected 3 entries, got %d: %+v", len(list.Data), list.Data)
	}
	byCmd := map[string]store.HistoryEntry{}
	for _, e := range list.Data {
		byCmd[e.Command] = e
	}
	input := byCmd["kubectl get pods"]
	if input.Source != store.HistorySourceInput || input.Host != "host-9" {
		t.Errorf("input entry source/host mismatch: %+v", input)
	}
	if byCmd["make all"].Source != "" || byCmd["make all"].Host != "" {
		t.Errorf("unknown source must fall back to osc default: %+v", byCmd["make all"])
	}
	if byCmd["git status"].Source != "" || byCmd["git status"].Host != "" {
		t.Errorf("legacy shape must stay osc/local: %+v", byCmd["git status"])
	}

	// 全局检索透传 source/host；本地条目两键缺省
	w = doJSON(t, r, "GET", "/api/terminal-history/search?q=get+pods", "")
	if w.Code != 200 {
		t.Fatalf("search: expected 200, got %d", w.Code)
	}
	var res struct {
		Data []terminalHistorySearchHit `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal search: %v", err)
	}
	if len(res.Data) != 1 || res.Data[0].Source != store.HistorySourceInput || res.Data[0].Host != "host-9" {
		t.Errorf("search hit source/host mismatch: %+v", res.Data)
	}
}
