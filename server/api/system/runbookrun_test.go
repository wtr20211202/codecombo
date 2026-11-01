package system

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 运行书服务端执行单测（P-20261004-108）：handler 契约（缺参清单/枚举校验/
// 404/409 互斥）与执行链可离线部分（写入失败停步/stop 尾跳过/审计）。真 PTY
// 的执行闭环（D 帧等待 + 插值落终端 + 进度事件）由真实实例 e2e 覆盖
// （web/e2e/specs/runbook-run-api.spec.ts）；等待原语本体在 terminal 包单测。

func init() { gin.SetMode(gin.TestMode) }

// performRunRequest 组装 JSON 请求直调 handler（不挂中间件——锁保护/鉴权由
// 路由组装承担，本表只测 handler 契约）。:id 经 FullPath 注入
func performRunRequest(t *testing.T, bookID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/runbooks/"+bookID+"/run", strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	c.Params = gin.Params{{Key: "id", Value: bookID}}
	RunRunbook(c)
	return w
}

// seedRunbook 直经 store 播种（绕过 handler 校验面，聚焦 run 链行为）
func seedRunbook(t *testing.T, title string, onFailure string, cmds []string) *store.Runbook {
	t.Helper()
	steps := make([]store.RunbookStep, len(cmds))
	for i, c := range cmds {
		steps[i] = store.RunbookStep{Command: c}
	}
	b, err := store.Get().Runbook.Create(store.Runbook{Title: title, OnFailure: onFailure, Steps: steps})
	if err != nil {
		t.Fatalf("seed runbook: %v", err)
	}
	t.Cleanup(func() { _ = store.Get().Runbook.Delete(b.ID) })
	return b
}

func setupRunbookRunStore(t *testing.T) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
}

func decodeRunResponse(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response %q: %v", w.Body.String(), err)
	}
	return body
}

func TestRunRunbookMissingParams(t *testing.T) {
	setupRunbookRunStore(t)
	b := seedRunbook(t, "缺参书", "", []string{"deploy {env} to {host}", "echo {env}"})

	w := performRunRequest(t, b.ID, map[string]any{"params": map[string]string{"env": "prod"}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	body := decodeRunResponse(t, w)
	if body["code"] != "runbook.params_missing" {
		t.Errorf("code = %v, want runbook.params_missing", body["code"])
	}
	missing, ok := body["missing"].([]any)
	if !ok || len(missing) != 1 || missing[0] != "host" {
		t.Errorf("missing = %v, want [host]", body["missing"])
	}
}

func TestRunRunbookMissingParamsEmptyValueCounts(t *testing.T) {
	setupRunbookRunStore(t)
	b := seedRunbook(t, "空白参书", "", []string{"echo {tag}"})
	w := performRunRequest(t, b.ID, map[string]any{"params": map[string]string{"tag": "  "}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("blank value should count as missing, status = %d", w.Code)
	}
}

func TestRunRunbookInvalidOnFailure(t *testing.T) {
	setupRunbookRunStore(t)
	b := seedRunbook(t, "坏档位书", "", []string{"echo hi"})
	w := performRunRequest(t, b.ID, map[string]any{"onFailure": "explode"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if body := decodeRunResponse(t, w); body["code"] != "runbook.payload_invalid" {
		t.Errorf("code = %v, want runbook.payload_invalid", body["code"])
	}
}

func TestRunRunbookUnknownBookAndTarget(t *testing.T) {
	setupRunbookRunStore(t)
	if w := performRunRequest(t, "sc_rb_not-exist", map[string]any{}); w.Code != http.StatusNotFound {
		t.Fatalf("unknown book status = %d, want 404", w.Code)
	}
	// 在册书 + 不在册显式目标 → 404 runbook.target_not_found（目标解析失败早于
	// 任何 PTY 动作，单测无 PTY 依赖）
	b := seedRunbook(t, "无目标书", "", []string{"echo hi"})
	w := performRunRequest(t, b.ID, map[string]any{"targetSessionId": "no-such-session"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown target status = %d, want 404", w.Code)
	}
	if body := decodeRunResponse(t, w); body["code"] != "runbook.target_not_found" {
		t.Errorf("code = %v, want runbook.target_not_found", body["code"])
	}
}

func TestRunRunbookBusy(t *testing.T) {
	setupRunbookRunStore(t)
	b := seedRunbook(t, "并发书", "", []string{"echo hi"})
	runID, ok := admitRunbookRun(b.ID)
	if !ok {
		t.Fatal("first admit should pass")
	}
	defer releaseRunbookRun(b.ID, runID)
	w := performRunRequest(t, b.ID, map[string]any{"targetSessionId": "no-such-session"})
	if w.Code != http.StatusConflict {
		t.Fatalf("busy status = %d, want 409 (互斥判定先于目标解析)", w.Code)
	}
	if body := decodeRunResponse(t, w); body["code"] != "runbook.busy" {
		t.Errorf("code = %v, want runbook.busy", body["code"])
	}
}

func TestAdmitReleaseRunbookRun(t *testing.T) {
	// 互斥表语义：占用/释放/错 id 释放不清账
	id, ok := admitRunbookRun("book-x")
	if !ok {
		t.Fatal("first admit should pass")
	}
	if _, ok := admitRunbookRun("book-x"); ok {
		t.Fatal("second admit while active should fail")
	}
	releaseRunbookRun("book-x", "wrong-run-id")
	if _, ok := admitRunbookRun("book-x"); ok {
		t.Fatal("release with wrong run id must not clear the slot")
	}
	releaseRunbookRun("book-x", id)
	if id2, ok := admitRunbookRun("book-x"); !ok {
		t.Fatal("admit after proper release should pass")
	} else {
		releaseRunbookRun("book-x", id2)
	}
}

func TestExecuteRunbookStepsWriteFailure(t *testing.T) {
	setupRunbookRunStore(t)
	// 裸 Session（无 PTY）：WriteInput 恒失败——「会话不可写如实停在当前步」
	// 语义与 stop 尾跳过（前端 useRunbookRunner write 失败分支同款）
	sess := &terminal.Session{}
	book := &store.Runbook{ID: "b1", Title: "t", OnFailure: "stop", Steps: []store.RunbookStep{
		{Command: "a"}, {Command: "b"}, {Command: "c"},
	}}
	res := executeRunbookSteps(sess, "run-1", book, []string{"a", "b", "c"}, "stop", 50*time.Millisecond)
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if res.Steps[0].Status != "failed" {
		t.Errorf("step0 = %q, want failed", res.Steps[0].Status)
	}
	for i, want := range []string{"skipped", "skipped"} {
		if res.Steps[i+1].Status != want {
			t.Errorf("step%d = %q, want %q", i+1, res.Steps[i+1].Status, want)
		}
	}
}

func TestExecuteRunbookStepsWriteFailureContinue(t *testing.T) {
	setupRunbookRunStore(t)
	// continue 档下写入失败同样停步（会话没了，后续写了也白发），余下 skipped
	sess := &terminal.Session{}
	book := &store.Runbook{ID: "b2", Title: "t", Steps: []store.RunbookStep{
		{Command: "a"}, {Command: "b"},
	}}
	res := executeRunbookSteps(sess, "run-2", book, []string{"a", "b"}, "continue", 50*time.Millisecond)
	if res.Status != "failed" || res.Steps[0].Status != "failed" || res.Steps[1].Status != "skipped" {
		t.Fatalf("continue write-failure = %q %q %q", res.Status, res.Steps[0].Status, res.Steps[1].Status)
	}
}

func TestRunbookRequiredParamsOrder(t *testing.T) {
	steps := []store.RunbookStep{
		{Command: "echo {b} {a}"},
		{Command: "echo {a} {c}"},
		{Command: "echo plain"},
	}
	got := runbookRequiredParams(steps)
	want := []string{"b", "a", "c"}
	if len(got) != len(want) {
		t.Fatalf("required = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("required = %v, want %v（按首次出现序）", got, want)
		}
	}
}

func TestRunbookStepDisplayNamesPrefersDescription(t *testing.T) {
	cmds := []string{"echo secret-token-abc123", "echo plain"}
	steps := []store.RunbookStep{
		{Command: cmds[0], Description: "部署到生产"},
		{Command: cmds[1]},
	}
	names := runbookStepDisplayNames(steps, cmds)
	if names[0] != "部署到生产" {
		t.Errorf("names[0] = %q, want description", names[0])
	}
	if !strings.Contains(names[1], "echo plain") {
		t.Errorf("names[1] = %q, want command fallback", names[1])
	}
}

func TestPublishRunbookProgressShape(t *testing.T) {
	// 进度载荷契约：steps ≤20 收敛 + done 按完成数推进 + terminalId 归属。
	// 广播进 hub 队列即丢弃（无客户端），观察者单测环境未装配——只验证不炸
	book := &store.Runbook{ID: "b", Title: "形状书"}
	names := make([]string, 25)
	for i := range names {
		names[i] = "s"
	}
	publishRunbookProgress("run", book, "term-1", "running", "step 1/25", 1, names)
	// 单播事件已入队（hub 队列异步），此处只断言函数不 panic；载荷形状由
	// e2e 在真实 WS 面断言
	_ = opschannel.EventTaskProgress
}
