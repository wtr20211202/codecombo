package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 联邦会话派发（P-20261004-101）──
// 覆盖：转发形态（kind=agent + 令牌头）、成功响应/通知/审计三联动、
// 对端 400 预检稳定标记原文透传、网络层失败 502、本机实例拒绝、
// launchArgs 超限本地拦截。

// dispatchPeer 模拟从实例：记录收到的请求，按注入的 behavior 回答
type dispatchPeer struct {
	gotPath  string
	gotToken string
	gotBody  map[string]any
}

func dispatchRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(filepath.Join(t.TempDir(), "data"))))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/instances/:id/dispatch", DispatchSession)
	return r
}

func dispatchRequest(r *gin.Engine, instanceID string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/instances/"+instanceID+"/dispatch", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// registerRemote 注册一条远程实例配置，返回实例 id
func registerRemote(t *testing.T, name, url, token string) string {
	t.Helper()
	inst := store.Get().Instance.NewRemote(name, url, token)
	if err := store.Get().Instance.Save(inst); err != nil {
		t.Fatal(err)
	}
	return inst.ID
}

func dispatchAuditCount(t *testing.T, action string) int {
	t.Helper()
	events, _, err := store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range events {
		if e.Action == action {
			n++
		}
	}
	return n
}

func TestDispatchSessionForwardsCreate(t *testing.T) {
	peer := &dispatchPeer{}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer.gotPath = r.URL.Path
		peer.gotToken = r.Header.Get("Authorization")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		peer.gotBody = body
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"id":"term-remote-1","name":"remote session","kind":"agent","runtime":"claude","launched":true}}`))
	}))
	defer remote.Close()

	r := dispatchRouter(t)
	id := registerRemote(t, "worker-1", remote.URL, "sc_token123")

	w := dispatchRequest(r, id, `{"name":"build task","runtime":"claude","dir":"/tmp/x","launchArgs":"run tests"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	// 转发形态：路径/鉴权/载荷（kind 恒 agent）
	if peer.gotPath != "/api/terminals" {
		t.Fatalf("forwarded path = %q, want /api/terminals", peer.gotPath)
	}
	if peer.gotToken != "Bearer sc_token123" {
		t.Fatalf("forwarded authorization = %q", peer.gotToken)
	}
	if peer.gotBody["kind"] != "agent" || peer.gotBody["name"] != "build task" || peer.gotBody["dir"] != "/tmp/x" {
		t.Fatalf("forwarded body unexpected: %v", peer.gotBody)
	}
	// 响应回传远端会话标识 + 实例寻址信息
	var resp struct {
		Data struct {
			RemoteSessionID   string `json:"remoteSessionId"`
			RemoteSessionName string `json:"remoteSessionName"`
			InstanceID        string `json:"instanceId"`
			InstanceURL       string `json:"instanceUrl"`
			Runtime           string `json:"runtime"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data.RemoteSessionID != "term-remote-1" || resp.Data.RemoteSessionName != "remote session" {
		t.Fatalf("remote session fields = %+v", resp.Data)
	}
	if resp.Data.InstanceID != id || !strings.Contains(resp.Data.InstanceURL, "127.0.0.1") {
		t.Fatalf("instance addressing = %+v", resp.Data)
	}
	if resp.Data.Runtime != "claude" {
		t.Fatalf("runtime = %q", resp.Data.Runtime)
	}
	// 通知入账（中心侧）：switch-instance 动作携实例 id
	notifs := store.Get().Notification.List(10)
	if len(notifs) != 1 {
		t.Fatalf("notifications = %d, want 1", len(notifs))
	}
	if notifs[0].Action != "switch-instance" || notifs[0].ActionPayload != id {
		t.Fatalf("notification action = %q payload = %q", notifs[0].Action, notifs[0].ActionPayload)
	}
	if notifs[0].TitleKey != "instance.dispatch.notify.title" {
		t.Fatalf("titleKey = %q", notifs[0].TitleKey)
	}
	if dispatchAuditCount(t, store.AuditInstanceDispatch) != 1 {
		t.Fatal("audit instance.dispatch not recorded")
	}
}

func TestDispatchSessionPassthroughRemote400(t *testing.T) {
	// 对端预检失败（runtime 缺失稳定标记）：状态码与原文必须原样透传——
	// 前端 KNOWN_ERROR_I18N 跨实例同文案映射的契约面
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"runtime codex is not installed or not in the service process path"}`))
	}))
	defer remote.Close()

	r := dispatchRouter(t)
	id := registerRemote(t, "worker-1", remote.URL, "sc_t")

	w := dispatchRequest(r, id, `{"runtime":"codex"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (passthrough)", w.Code)
	}
	if !strings.Contains(w.Body.String(), "runtime codex is not installed or not in the service process path") {
		t.Fatalf("stable marker not passed through: %s", w.Body.String())
	}
	// 失败也要可溯：审计 failure 一条；成功通知不发
	if dispatchAuditCount(t, store.AuditInstanceDispatch) != 1 {
		t.Fatal("failure audit missing")
	}
	if n := len(store.Get().Notification.List(10)); n != 0 {
		t.Fatalf("failure should not notify, got %d", n)
	}
}

func TestDispatchSessionNetworkFailure(t *testing.T) {
	r := dispatchRouter(t)
	// 关停的真身地址：连接拒绝
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	remote.Close()

	id := registerRemote(t, "down", remote.URL, "")
	w := dispatchRequest(r, id, `{}`)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	// 稳定前缀 remote unreachable——KNOWN_ERROR_I18N 既有条目跨平台可达
	//（Windows 连接拒绝原文是 connectex 文案，不能断言平台专属字样）；
	// 平台原生诊断原文保留在前缀之后
	if !strings.Contains(w.Body.String(), "remote unreachable: ") {
		t.Fatalf("stable prefix missing: %s", w.Body.String())
	}
	if dispatchAuditCount(t, store.AuditInstanceDispatch) != 1 {
		t.Fatal("failure audit missing")
	}
}

func TestDispatchSessionRejects(t *testing.T) {
	r := dispatchRouter(t)

	// 本机实例：转发到自己是无意义绕行
	localID := registerRemote(t, "x", "http://192.0.2.9:1", "")
	instances, _ := store.Get().Instance.List()
	for _, inst := range instances {
		if inst.ID == localID {
			inst.IsLocal = true
			_ = store.Get().Instance.Save(inst)
		}
	}
	if w := dispatchRequest(r, localID, `{}`); w.Code != http.StatusBadRequest {
		t.Fatalf("local dispatch status = %d, want 400", w.Code)
	}

	// 未知实例
	if w := dispatchRequest(r, "no-such", `{}`); w.Code != http.StatusNotFound {
		t.Fatalf("unknown instance status = %d, want 404", w.Code)
	}

	// launchArgs 超限：本地先拦（对端同款契约），不发起跨机请求
	if w := dispatchRequest(r, localID, `{"launchArgs":"`+strings.Repeat("a", 501)+`"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("long launchArgs status = %d, want 400", w.Code)
	}
}

// ── 派发寻址账（P-20261004-131）──
// 覆盖：成功派发落账（寻址元数据完整）、失败派发不落账、清单端点形态、
// 移除端点幂等。

// dispatchedRouter 全三路由（dispatch + 清单 + 移除）
func dispatchedRouter(t *testing.T) *gin.Engine {
	t.Helper()
	r := dispatchRouter(t)
	r.GET("/api/instances/dispatched", ListDispatched)
	r.DELETE("/api/instances/dispatched/:recordId", DeleteDispatched)
	return r
}

func TestDispatchRecordCreatedOnSuccess(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"id":"term-backflow-1","name":"回 流 会 话","kind":"agent","runtime":"claude","launched":true}}`))
	}))
	defer remote.Close()

	r := dispatchedRouter(t)
	id := registerRemote(t, "worker-bf", remote.URL, "sc_token123")

	if w := dispatchRequest(r, id, `{"name":"bf task","runtime":"claude"}`); w.Code != http.StatusOK {
		t.Fatalf("dispatch status = %d body=%s", w.Code, w.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/instances/dispatched", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d", w.Code)
	}
	var resp struct {
		Data []store.DispatchRecord `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Data) != 1 {
		t.Fatalf("records = %d, want 1", len(resp.Data))
	}
	rec := resp.Data[0]
	if rec.InstanceID != id || rec.InstanceName != "worker-bf" {
		t.Fatalf("instance fields = %+v", rec)
	}
	if rec.RemoteSessionID != "term-backflow-1" || rec.RemoteSessionName != "回 流 会 话" {
		t.Fatalf("remote session fields = %+v", rec)
	}
	if rec.Runtime != "claude" || rec.ID == "" || rec.At.IsZero() {
		t.Fatalf("meta fields = %+v", rec)
	}

	// 移除：先未知 id 幂等 200，再真删
	req2 := httptest.NewRequest(http.MethodDelete, "/api/instances/dispatched/no-such-id", nil)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("idempotent delete status = %d", w2.Code)
	}
	req3 := httptest.NewRequest(http.MethodDelete, "/api/instances/dispatched/"+rec.ID, nil)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusOK {
		t.Fatalf("delete status = %d", w3.Code)
	}
	req4 := httptest.NewRequest(http.MethodGet, "/api/instances/dispatched", nil)
	w4 := httptest.NewRecorder()
	r.ServeHTTP(w4, req4)
	var after struct {
		Data []store.DispatchRecord `json:"data"`
	}
	_ = json.Unmarshal(w4.Body.Bytes(), &after)
	if len(after.Data) != 0 {
		t.Fatalf("records after delete = %d, want 0", len(after.Data))
	}
}

func TestDispatchRecordNotCreatedOnFailure(t *testing.T) {
	// 对端 4xx：派发失败不落账（回流只跟踪真实派出的会话）
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"runtime not installed"}`))
	}))
	defer remote.Close()

	r := dispatchedRouter(t)
	id := registerRemote(t, "worker-fail", remote.URL, "sc_token123")
	if w := dispatchRequest(r, id, `{"runtime":"codex"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("dispatch status = %d", w.Code)
	}
	list, err := store.Get().DispatchRecord.List()
	if err != nil || len(list) != 0 {
		t.Fatalf("failed dispatch must not record: n=%d err=%v", len(list), err)
	}
}
