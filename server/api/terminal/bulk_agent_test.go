package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"codecombo/server/agentops"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// 舰队并行 agent 任务（P-20261003-291）：保尾截断口径（对齐前端
// web/src/utils/promptFit.ts）、编队名截断、请求校验与逐条回告跳过。
// 成功创建路径不在此真实建会话（PTY 不进单测是本包既有边界，见
// terminal_precheck_test.go），由 e2e fleet-bulk-agent.spec 守门

// TestFleetFitLaunchBytes 服务端保尾截断：≤500 原样；超限保尾加 … 前缀、
// 收进 500 字节、不腰斩多字节字符、尾部内容保留；两段式估裁收敛到与
// 「逐字符保尾」参考实现同界（前端 fitByBytes 口径）
func TestFleetFitLaunchBytes(t *testing.T) {
	// 未超限原样（含恰好上限）
	short := "run go vet ./..."
	if got := fleetFitLaunchBytes(short, 500); got != short {
		t.Fatalf("short prompt should stay as-is, got %q", got)
	}
	exact := strings.Repeat("x", 500)
	if got := fleetFitLaunchBytes(exact, 500); got != exact {
		t.Fatalf("exact-500 prompt should stay as-is")
	}

	// ASCII 超限：保尾 + … 前缀，总长收进 500 字节
	long := strings.Repeat("a", 600) + "-TAIL-END"
	got := fleetFitLaunchBytes(long, 500)
	if !strings.HasPrefix(got, "…") {
		t.Fatalf("over-limit should get ellipsis prefix, got %q", got[:10])
	}
	if len(got) > 500 {
		t.Fatalf("fitted length = %d, want <= 500 bytes", len(got))
	}
	if !strings.HasSuffix(got, "-TAIL-END") {
		t.Fatalf("tail must be preserved, got %q", got[len(got)-20:])
	}

	// 多字节（CJK 3 字节/字符）超限：结果合法 UTF-8、保尾、收进 500 字节
	src := strings.Repeat("审", 300) + "末尾指令"
	gotCJK := fleetFitLaunchBytes(src, 500)
	if !utf8.ValidString(gotCJK) {
		t.Fatalf("fitted CJK prompt is not valid UTF-8")
	}
	if len(gotCJK) > 500 {
		t.Fatalf("fitted CJK length = %d, want <= 500 bytes", len(gotCJK))
	}
	if !strings.HasSuffix(gotCJK, "末尾指令") {
		t.Fatalf("CJK tail must be preserved, got %q", gotCJK)
	}
	if !strings.HasPrefix(gotCJK, "…") {
		t.Fatalf("CJK over-limit should get ellipsis prefix")
	}

	// 参考实现（逐字符从头丢弃直至 …+尾部恰好收进上限）应与两段式估裁同界
	rs := []rune(src)
	for len(rs) > 0 && len("…")+len(string(rs)) > 500 {
		rs = rs[1:]
	}
	ref := "…" + string(rs)
	if gotCJK != ref {
		t.Fatalf("fitted = %d bytes, reference tail-fit = %d bytes（估裁应收敛到同界）", len(gotCJK), len(ref))
	}
}

// TestFleetSessionName 编队名「fleet: <prompt 头部截断>」：首非空行、控制字符
// 折叠、超 24 rune 截断、全空白兜底、旗标形态不短路
func TestFleetSessionName(t *testing.T) {
	if got := fleetSessionName("修复登录页跳转问题\n第二行"); got != "fleet: 修复登录页跳转问题" {
		t.Fatalf("fleet name = %q", got)
	}
	// 头部空白行跳过
	if got := fleetSessionName("\n\n 审计依赖 "); got != "fleet: 审计依赖" {
		t.Fatalf("blank leading lines should be skipped, got %q", got)
	}
	// 控制字符折叠（promptSessionName 同款口径）
	if got := fleetSessionName("审查\x01这段\t代码"); got != "fleet: 审查 这段 代码" {
		t.Fatalf("control chars should fold to space, got %q", got)
	}
	// 超 24 rune 截断（fleet: 前缀外，头部口径与单会话摘要名一致）
	long := strings.Repeat("审", 30)
	want := "fleet: " + strings.Repeat("审", 24) + "…"
	if got := fleetSessionName(long); got != want {
		t.Fatalf("long head = %q, want %q", got, want)
	}
	// 恰 24 rune 不加省略号
	if got := fleetSessionName(strings.Repeat("审", 24)); got != "fleet: "+strings.Repeat("审", 24) {
		t.Fatalf("24-rune head should stay as-is, got %q", got)
	}
	// 全空白：请求校验已拦，纯函数兜底不产生 "fleet: " 空头
	if got := fleetSessionName("  \n\t "); got != "fleet" {
		t.Fatalf("blank prompt fallback = %q, want fleet", got)
	}
	// 旗标形态不短路：批量链 prompt 必是任务指令，"-" 开头同样编队命名
	if got := fleetSessionName("-n 执行检查"); got != "fleet: -n 执行检查" {
		t.Fatalf("flag-like prompt still gets fleet name, got %q", got)
	}
}

// bulkTestRouter 独立 gin 引擎挂 BulkCreateAgentTerminals（precheckTestRouter 同款）
func bulkTestRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/terminals/bulk-agent", BulkCreateAgentTerminals)
	return r
}

// bulkTestStore 装配独立 store 并注册两个项目（precheckTestStore 同款手法）
func bulkTestStore(t *testing.T) {
	t.Helper()
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	_ = store.Get().Project.Create(config.ProjectConfig{ID: "proj-a", Name: "A", Path: t.TempDir()})
	_ = store.Get().Project.Create(config.ProjectConfig{ID: "proj-b", Name: "B", Path: t.TempDir()})
}

func postBulk(body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/terminals/bulk-agent", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	bulkTestRouter().ServeHTTP(w, req)
	return w
}

// TestBulkAgentValidation 请求校验：空列表 / 超 cap / 空 prompt → 400
func TestBulkAgentValidation(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"空项目列表", `{"projectIds":[],"prompt":"do it"}`, "projectIds is required"},
		{"超 cap（21 个）", `{"projectIds":[` + strings.TrimSuffix(strings.Repeat(`"p",`, 21), ",") + `],"prompt":"do it"}`, "too many projects: max 20"},
		{"空 prompt", `{"projectIds":["proj-a"],"prompt":"   "}`, "prompt is required"},
		{"坏 body", `{`, "invalid request body"},
	}
	for _, tc := range cases {
		w := postBulk(tc.body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400（body=%s）", tc.name, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), tc.want) {
			t.Fatalf("%s: body 应含 %q，got %s", tc.name, tc.want, w.Body.String())
		}
	}
}

// TestBulkAgentSkipReported runtime 预检失败逐条回告跳过 + 项目缺失回告，
// 编队不中断、其余项目逐条走到、会话零创建（预检桩拦在创建前）
func TestBulkAgentSkipReported(t *testing.T) {
	bulkTestStore(t)
	old := precheckRuntimeFn
	precheckRuntimeFn = func(name string) (string, error) {
		return "", &agentops.PrecheckError{Runtime: name, Missing: true}
	}
	t.Cleanup(func() { precheckRuntimeFn = old })

	before := len(terminal.DefaultManager.ListSessions())
	w := postBulk(`{"projectIds":["proj-a","no-such","proj-b"],"runtime":"claude","prompt":"跑依赖审计并整理清单"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200（逐条回告不是 HTTP 错误）body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if after := len(terminal.DefaultManager.ListSessions()); after != before {
		t.Fatalf("预检全失败不得创建会话：before=%d after=%d", before, after)
	}
	// 两个有效项目各自回告同一稳定标记（逐项目独立预检、逐条回告）
	if got := strings.Count(body, "runtime claude is not installed"); got != 2 {
		t.Fatalf("预检失败应逐条回告 2 次，got %d：body=%s", got, body)
	}
	// 项目缺失回告稳定标记
	if !strings.Contains(body, `"projectId":"no-such"`) || !strings.Contains(body, "project not found") {
		t.Fatalf("缺失项目应回告 project not found：body=%s", body)
	}
	// created 为空数组而非 null（前端直读不炸）
	if strings.Contains(body, `"created":null`) {
		t.Fatalf("created 应为空数组而非 null：body=%s", body)
	}
}

// TestBulkAgentNameApplied 编队统一名走 LaunchAgentSession 显式命名链（不被
// 摘要名/槽位名覆盖——resolveAgentSessionName 显式名优先锚定）+ 名长有界
func TestBulkAgentNameApplied(t *testing.T) {
	name := fleetSessionName("给全部项目跑依赖审计")
	if got := resolveAgentSessionName(name, "launch-args", "claude", "/tmp/x", ""); got != name {
		t.Fatalf("显式编队名不得被命名链覆盖：got %q want %q", got, name)
	}
	// 编队名头部有界（24 rune + 省略号）
	full := fleetSessionName(strings.Repeat("审", 100))
	if n := utf8.RuneCountInString(strings.TrimPrefix(full, "fleet: ")); n > 25 {
		t.Fatalf("编队名头部应截断到 24 rune+省略号，got %d rune", n)
	}
}

// TestBulkAgentResponseFleetBatch 编队批元数据响应契约（P-20261005-145）：
// batchId 非空、members 恒非 null（全跳过的批前端直读不炸）。成功创建路径
// 的元数据落库/快照投影由 TestApplySessionMetaSnapshotFleetBatch 与 e2e
// fleet-batch-track.spec 守门（PTY 不进单测是本包既有边界）
func TestBulkAgentResponseFleetBatch(t *testing.T) {
	bulkTestStore(t)
	old := precheckRuntimeFn
	precheckRuntimeFn = func(name string) (string, error) {
		return "", &agentops.PrecheckError{Runtime: name, Missing: true}
	}
	t.Cleanup(func() { precheckRuntimeFn = old })

	w := postBulk(`{"projectIds":["proj-a","proj-b"],"runtime":"claude","prompt":"跑审计"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"fleetBatch"`) {
		t.Fatalf("响应应携带 fleetBatch：body=%s", body)
	}
	if !strings.Contains(body, `"members":[]`) {
		t.Fatalf("全跳过的批 members 应为空数组而非 null：body=%s", body)
	}
	var parsed struct {
		Data struct {
			FleetBatch struct {
				BatchID    string   `json:"batchId"`
				LaunchedAt string   `json:"launchedAt"`
				Members    []string `json:"members"`
			} `json:"fleetBatch"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("响应非合法 JSON：%v", err)
	}
	if !strings.HasPrefix(parsed.Data.FleetBatch.BatchID, "fleet-") {
		t.Fatalf("batchId 应为 fleet- 前缀，got %q", parsed.Data.FleetBatch.BatchID)
	}
	if parsed.Data.FleetBatch.LaunchedAt == "" {
		t.Fatalf("launchedAt 应携带发起时间")
	}
}

// TestAttachFleetBatch 花名册回填（P-20261005-145 两阶段设计的第二段）：
// 创建时只落批身份（members 空），回填后读-改-写为完整花名册；已落库的
// Named/Sensitive 策展值在回填中保留（attach 不覆盖人工策展面）
func TestAttachFleetBatch(t *testing.T) {
	setupMetaTest(t)
	batch := store.FleetBatch{
		BatchID:    "fleet-1759987200000000000",
		LaunchedAt: time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC),
		Members:    []string{"agent-x1", "agent-x2"},
	}
	// 第一段：创建链同步落批身份（members 尚不可知）
	saveAgentSessionMeta("agent-x1", "", "shell", "fleet: 审计", "", "", "",
		launchMetaExtra{fleetBatch: &store.FleetBatch{BatchID: batch.BatchID, LaunchedAt: batch.LaunchedAt}})
	// 用户创建后立即改名（策展面先行）
	saveSessionDisplayName("agent-x1", "我的编队成员", "", "", batch.LaunchedAt)

	// 第二段：完整花名册回填
	attachFleetBatch("agent-x1", batch)
	meta, err := store.Get().AgentSession.Get("agent-x1")
	if err != nil || meta == nil {
		t.Fatalf("meta 应在: %v", err)
	}
	if meta.FleetBatch == nil || len(meta.FleetBatch.Members) != 2 || meta.FleetBatch.Members[1] != "agent-x2" {
		t.Fatalf("回填后应有完整花名册: %+v", meta.FleetBatch)
	}
	if meta.Name != "我的编队成员" || !meta.Named {
		t.Fatalf("回填不得覆盖用户命名: name=%q named=%v", meta.Name, meta.Named)
	}

	// meta 缺失（同步落库失败的罕见面）：补建最小文档保批身份不丢
	attachFleetBatch("agent-x-missing", batch)
	m2, err := store.Get().AgentSession.Get("agent-x-missing")
	if err != nil || m2 == nil || m2.FleetBatch == nil || m2.FleetBatch.BatchID != batch.BatchID {
		t.Fatalf("meta 缺失应补建批身份: %+v err=%v", m2, err)
	}
}

// TestFilterSnapshotByFleet 快照按编队批过滤（?fleet=<batchId> 的纯函数面，
// P-20261005-145）：精确匹配 batchId、非编队/异批剔除、空结果合法
func TestFilterSnapshotByFleet(t *testing.T) {
	snap := []gin.H{
		{"id": "agent-a", "fleetBatch": gin.H{"batchId": "fleet-1", "members": []string{}}},
		{"id": "agent-b", "fleetBatch": gin.H{"batchId": "fleet-2", "members": []string{}}},
		{"id": "agent-solo"}, // 非编队会话（缺 fleetBatch 键）
	}
	got := filterSnapshotByFleet(snap, "fleet-1")
	if len(got) != 1 || got[0]["id"] != "agent-a" {
		t.Fatalf("fleet-1 应只余 agent-a：got %v", got)
	}
	// 未知 batchId → 空列表（非错误；agent 轮询收敛判定的合法空态）
	if got := filterSnapshotByFleet(snap, "fleet-404"); len(got) != 0 {
		t.Fatalf("未知批应得空列表：got %v", got)
	}
}
