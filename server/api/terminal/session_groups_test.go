package terminal

// 终端会话自定义分组 agent 操作面单测（P-20261111-1-S3）：CRUD + 会话归组移动
// 的 HTTP 契约（status/响应形状/稳定错误原文）与 uiState 落盘形态（只动 groups、
// 同命名空间其余键与其他命名空间原样）。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

func setupGroupsRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/terminals/session-groups", ListSessionGroups)
	r.POST("/api/terminals/session-groups", CreateSessionGroup)
	r.PUT("/api/terminals/session-groups/:id", RenameSessionGroup)
	r.DELETE("/api/terminals/session-groups/:id", DeleteSessionGroup)
	r.PUT("/api/terminals/session-groups/:id/sessions", MoveSessionsIntoGroup)
	r.DELETE("/api/terminals/session-groups/:id/sessions/:sid", RemoveSessionFromGroup)
	return r
}

func doGroupsReq(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	r.ServeHTTP(w, req)
	return w
}

// seedAgentTerminalState 预置本地实例 agentTerminal 命名空间（含 groups 与
// 无关键），验证手术式写不动无关面
func seedAgentTerminalState(t *testing.T, groups []map[string]interface{}) {
	t.Helper()
	err := store.Get().UIState.Merge(map[string]interface{}{
		agentGroupsInstance: map[string]interface{}{
			agentGroupsNS: map[string]interface{}{
				"sidebarCollapsed": true,
				agentGroupsKey:     groups,
				"collapsedGroups":  []interface{}{"at_1_aaaa"},
			},
		},
		"fileTree": map[string]interface{}{"pinnedDirs": []interface{}{"src"}},
	})
	if err != nil {
		t.Fatalf("seed uiState: %v", err)
	}
}

func readStoredGroups(t *testing.T) ([]interface{}, map[string]interface{}) {
	t.Helper()
	data, err := store.Get().UIState.Get()
	if err != nil {
		t.Fatalf("read uiState: %v", err)
	}
	inst, ok := data[agentGroupsInstance].(map[string]interface{})
	if !ok {
		t.Fatalf("instance record missing")
	}
	ns, ok := inst[agentGroupsNS].(map[string]interface{})
	if !ok {
		t.Fatalf("agentTerminal namespace missing")
	}
	raw, _ := ns[agentGroupsKey].([]interface{})
	return raw, ns
}

func TestSessionGroups_CRUD(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := setupGroupsRouter(t)

	// 空清单
	w := doGroupsReq(r, http.MethodGet, "/api/terminals/session-groups", "")
	if w.Code != http.StatusOK {
		t.Fatalf("GET empty: %d", w.Code)
	}
	if got := w.Body.String(); !strings.Contains(got, `"data":[]`) {
		t.Fatalf("GET empty body = %s", got)
	}

	// 建组：201 + id 形态 + 落盘
	w = doGroupsReq(r, http.MethodPost, "/api/terminals/session-groups", `{"name":"值班巡检"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("POST create: %d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data struct {
			ID   string   `json:"id"`
			Name string   `json:"name"`
			Ids  []string `json:"sessionIds"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode create resp: %v", err)
	}
	if resp.Data.ID == "" || !strings.HasPrefix(resp.Data.ID, "at_") || len(resp.Data.Ids) != 0 {
		t.Fatalf("create resp = %+v", resp.Data)
	}
	gid := resp.Data.ID

	// 建组前预置的无关键不受影响（seed 在 create 之后并验证不被后续写冲掉）
	seedAgentTerminalState(t, []map[string]interface{}{{"id": gid, "name": "值班巡检", "sessionIds": []interface{}{}}})

	// 改名
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/"+gid, `{"name":"  交付归拢  "}`)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT rename: %d body=%s", w.Code, w.Body.String())
	}
	raw, ns := readStoredGroups(t)
	if len(raw) != 1 {
		t.Fatalf("groups len = %d", len(raw))
	}
	if got := raw[0].(map[string]interface{})["name"]; got != "交付归拢" {
		t.Fatalf("renamed name = %v (want trimmed)", got)
	}
	if ns["sidebarCollapsed"] != true || ns["collapsedGroups"] == nil {
		t.Fatalf("namespace unrelated keys lost: %+v", ns)
	}
	if _, ok := ns["fileTree"]; ok {
		t.Fatalf("fileTree namespace leaked into agentTerminal: %+v", ns)
	}

	// 改名：未知组 404 稳定原文
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_404_xxxx", `{"name":"x"}`)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "session group not found") {
		t.Fatalf("rename unknown: %d body=%s", w.Code, w.Body.String())
	}

	// 删组
	w = doGroupsReq(r, http.MethodDelete, "/api/terminals/session-groups/"+gid, "")
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE group: %d body=%s", w.Code, w.Body.String())
	}
	raw, _ = readStoredGroups(t)
	if len(raw) != 0 {
		t.Fatalf("groups after delete = %+v", raw)
	}
	w = doGroupsReq(r, http.MethodDelete, "/api/terminals/session-groups/"+gid, "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("DELETE unknown group: %d", w.Code)
	}
}

func TestSessionGroups_Validation(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := setupGroupsRouter(t)

	cases := []struct {
		name string
		body string
		want string // 稳定错误原文片段
	}{
		{"empty name", `{"name":"  "}`, "name required"},
		{"missing name", `{}`, "name required"},
		{"too long name", fmt.Sprintf(`{"name":"%s"}`, strings.Repeat("组", agentGroupNameMax+1)), "name too long"},
		{"not json", `nope`, "invalid request body"},
	}
	for _, tc := range cases {
		w := doGroupsReq(r, http.MethodPost, "/api/terminals/session-groups", tc.body)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), tc.want) {
			t.Errorf("%s: %d body=%s", tc.name, w.Code, w.Body.String())
		}
	}
}

func TestSessionGroups_GroupLimit(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	seedAgentTerminalState(t, make([]map[string]interface{}, 0))
	// 预置满额组（agentGroupsMax 条）
	full := make([]map[string]interface{}, agentGroupsMax)
	for i := range full {
		full[i] = map[string]interface{}{"id": fmt.Sprintf("at_%d_aaaa", i), "name": fmt.Sprintf("g%d", i), "sessionIds": []interface{}{}}
	}
	err := store.Get().UIState.Merge(map[string]interface{}{
		agentGroupsInstance: map[string]interface{}{agentGroupsNS: map[string]interface{}{agentGroupsKey: full}},
	})
	if err != nil {
		t.Fatalf("seed full: %v", err)
	}
	r := setupGroupsRouter(t)
	w := doGroupsReq(r, http.MethodPost, "/api/terminals/session-groups", `{"name":"overflow"}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "session groups limit reached (100)") {
		t.Fatalf("limit: %d body=%s", w.Code, w.Body.String())
	}
}

func TestSessionGroups_MoveSessions(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	s1, err := terminal.DefaultManager.CreateSession("sg-s1", "s1", t.TempDir(), "", false)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(s1.ID) })
	s2, err := terminal.DefaultManager.CreateSession("sg-s2", "s2", t.TempDir(), "", false)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() { terminal.DefaultManager.CloseSession(s2.ID) })

	// 平台纪律：会话一律按 CreateSession 返回的权威 s.ID 寻址，不按请求 id 字面
	// 量——tmux 后端（Linux 门禁）下 Manager 把 id 改写为派生 tmux 名
	//（manager.go create 注记「tmux 后端下 finalID != 传入 id」），native（Windows）
	// 才原样保留；字面量寻址只在单平台偶然成立
	seedAgentTerminalState(t, []map[string]interface{}{
		{"id": "at_1_aaaa", "name": "A", "sessionIds": []interface{}{}},
		{"id": "at_2_bbbb", "name": "B", "sessionIds": []interface{}{s2.ID}},
	})
	r := setupGroupsRouter(t)

	// 移入：空清单 400 / 未知会话 404（整体不动）/ 未知组 404
	w := doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_1_aaaa/sessions", `{"sessionIds":[]}`)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "sessionIds required") {
		t.Fatalf("move empty: %d body=%s", w.Code, w.Body.String())
	}
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_1_aaaa/sessions", `{"sessionIds":["sg-ghost"]}`)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "session not found: sg-ghost") {
		t.Fatalf("move ghost: %d body=%s", w.Code, w.Body.String())
	}
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_404_xxxx/sessions",
		fmt.Sprintf(`{"sessionIds":[%q]}`, s1.ID))
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "session group not found") {
		t.Fatalf("move unknown group: %d body=%s", w.Code, w.Body.String())
	}
	raw, _ := readStoredGroups(t)
	if len(raw) != 2 || len(raw[0].(map[string]interface{})["sessionIds"].([]interface{})) != 0 {
		t.Fatalf("failed moves must not mutate: %+v", raw)
	}

	// 正常移入：从 B 组摘除 s2 入 A 组尾部
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_1_aaaa/sessions",
		fmt.Sprintf(`{"sessionIds":[%q,%q]}`, s1.ID, s2.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("move in: %d body=%s", w.Code, w.Body.String())
	}
	raw, _ = readStoredGroups(t)
	a := raw[0].(map[string]interface{})["sessionIds"].([]interface{})
	b := raw[1].(map[string]interface{})["sessionIds"].([]interface{})
	if len(a) != 2 || a[0] != s1.ID || a[1] != s2.ID {
		t.Fatalf("group A members = %v (want %s,%s)", a, s1.ID, s2.ID)
	}
	if len(b) != 0 {
		t.Fatalf("group B members after move = %v (want emptied by move)", b)
	}

	// 幂等重入：已在组内的再移入一次 = 移到尾部不重复
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_1_aaaa/sessions",
		fmt.Sprintf(`{"sessionIds":[%q]}`, s1.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("re-move: %d", w.Code)
	}
	raw, _ = readStoredGroups(t)
	a = raw[0].(map[string]interface{})["sessionIds"].([]interface{})
	if len(a) != 2 || a[0] != s2.ID || a[1] != s1.ID {
		t.Fatalf("re-move members = %v (want s2 first, s1 re-appended)", a)
	}

	// 移出：会话不在该组 404；在则摘除回未分组
	w = doGroupsReq(r, http.MethodDelete, "/api/terminals/session-groups/at_1_aaaa/sessions/"+url.PathEscape(s2.ID), "")
	if w.Code != http.StatusOK {
		t.Fatalf("remove member: %d body=%s", w.Code, w.Body.String())
	}
	w = doGroupsReq(r, http.MethodDelete, "/api/terminals/session-groups/at_1_aaaa/sessions/"+url.PathEscape(s2.ID), "")
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "not in group") {
		t.Fatalf("remove absent member: %d body=%s", w.Code, w.Body.String())
	}
	raw, _ = readStoredGroups(t)
	a = raw[0].(map[string]interface{})["sessionIds"].([]interface{})
	if len(a) != 1 || a[0] != s1.ID {
		t.Fatalf("group A after remove = %v", a)
	}
}

func TestSessionGroups_DefensiveShapes(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	// 存量畸形形状：groups 非数组（旧脏数据，前端读取端归一空表）+ 无关命名空间在场
	err := store.Get().UIState.Merge(map[string]interface{}{
		agentGroupsInstance: map[string]interface{}{
			agentGroupsNS:   map[string]interface{}{agentGroupsKey: "corrupt", "sidebarCollapsed": false},
			"remoteConsole": map[string]interface{}{"open": true},
		},
	})
	if err != nil {
		t.Fatalf("seed corrupt: %v", err)
	}
	r := setupGroupsRouter(t)

	// 读取端：非数组归一空清单（与前端 getAgentTerminalState 同口径）
	w := doGroupsReq(r, http.MethodGet, "/api/terminals/session-groups", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"data":[]`) {
		t.Fatalf("GET corrupt: %d body=%s", w.Code, w.Body.String())
	}

	// 写入端：畸形 groups 归一后写入合法数组（修复性重写，不保形），
	// 同命名空间其余键与兄弟命名空间原样
	w = doGroupsReq(r, http.MethodPost, "/api/terminals/session-groups", `{"name":"repair"}`)
	if w.Code != http.StatusCreated {
		t.Fatalf("create on corrupt: %d body=%s", w.Code, w.Body.String())
	}
	raw, ns := readStoredGroups(t)
	if len(raw) != 1 {
		t.Fatalf("groups after repair = %+v", raw)
	}
	if v, ok := ns["sidebarCollapsed"]; !ok || v != false {
		t.Fatalf("sidebarCollapsed lost: %+v", ns)
	}
	data, _ := store.Get().UIState.Get()
	if rc, ok := data[agentGroupsInstance].(map[string]interface{})["remoteConsole"]; !ok || rc == nil {
		t.Fatalf("sibling namespace lost: %+v", data[agentGroupsInstance])
	}

	// 不可寻址条目（无 id 的 map / 非 map 条目）原样保留、不进视图
	err = store.Get().UIState.Merge(map[string]interface{}{
		agentGroupsInstance: map[string]interface{}{agentGroupsNS: map[string]interface{}{agentGroupsKey: []interface{}{
			"nameless", map[string]interface{}{"name": "no-id"},
			map[string]interface{}{"id": "at_1_cccc", "name": "real", "sessionIds": []interface{}{}},
		}}},
	})
	if err != nil {
		t.Fatalf("seed unaddressable: %v", err)
	}
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_1_cccc/sessions", `{"sessionIds":["sg-x"]}`)
	// sg-x 不在册 → 404 整体不动（同时证明校验在解码之后）
	if w.Code != http.StatusNotFound {
		t.Fatalf("move ghost on unaddressable: %d", w.Code)
	}
	w = doGroupsReq(r, http.MethodPut, "/api/terminals/session-groups/at_1_cccc", `{"name":"renamed"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("rename real group: %d body=%s", w.Code, w.Body.String())
	}
	raw, _ = readStoredGroups(t)
	// 不可寻址条目殿后保留（encodeAgentGroups 记载语义：无渲染语义，只保不丢）
	if len(raw) != 3 || raw[1] != "nameless" {
		t.Fatalf("unaddressable entries must be preserved: %+v", raw)
	}
	if m, ok := raw[2].(map[string]interface{}); !ok || m["name"] != "no-id" {
		t.Fatalf("unaddressable map entry must be preserved: %+v", raw[2])
	}
	if raw[0].(map[string]interface{})["name"] != "renamed" {
		t.Fatalf("addressable entry not renamed: %+v", raw[0])
	}
}
