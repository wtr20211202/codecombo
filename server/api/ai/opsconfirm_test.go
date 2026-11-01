package ai

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

func setupApprovalTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/ops-confirm", CreateAgentApproval)
	r.GET("/api/ops-confirm/:id", GetAgentApproval)
	r.POST("/api/ops-confirm/:id/resolve", ResolveAgentApproval)
	r.GET("/api/ops-confirm", ListAgentApprovals)
	return r
}

func doJSON(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if body != "" {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestAgentApproval_StateMachine(t *testing.T) {
	r := setupApprovalTest(t)

	// 创建 → pending
	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"agent-1","op":"reset --hard","target":"main","detail":"丢弃未推送改动"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.ApprovalPending || created.Data.ID == "" {
		t.Fatalf("expect pending with id, got %+v", created.Data)
	}

	// 轮询 → pending
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+created.Data.ID, "")
	var got struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Data.Status != store.ApprovalPending {
		t.Fatalf("poll expect pending, got %s err=%v", got.Data.Status, err)
	}

	// 裁决允许 → allowed
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve", `{"allow":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d", w.Code)
	}

	// 重复裁决 → 409（仅 pending 可裁决）
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve", `{"allow":false}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("double resolve status = %d, want 409", w.Code)
	}

	// 列表包含且状态正确
	w = doJSON(r, http.MethodGet, "/api/ops-confirm", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), store.ApprovalAllowed) {
		t.Fatalf("list expect allowed entry, status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestAgentApproval_Validation(t *testing.T) {
	r := setupApprovalTest(t)
	// op 缺失 → 400
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"target":"x"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("missing op status = %d, want 400", w.Code)
	}
	// op 超长 → 400
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"`+strings.Repeat("a", 200)+`"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("long op status = %d, want 400", w.Code)
	}
	// 不存在的审批 → 404
	if w := doJSON(r, http.MethodGet, "/api/ops-confirm/sc_ap_none", ""); w.Code != http.StatusNotFound {
		t.Fatalf("unknown id status = %d, want 404", w.Code)
	}
	// 未知 ID 裁决 → 404
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/sc_ap_none/resolve", `{"allow":true}`); w.Code != http.StatusNotFound {
		t.Fatalf("unknown resolve status = %d, want 404", w.Code)
	}
}

// TestAgentApproval_RejectedPath 拒绝路径：allow=false → denied
func TestAgentApproval_RejectedPath(t *testing.T) {
	r := setupApprovalTest(t)
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"delete file","target":"/tmp/x"}`)
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve", `{"allow":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d", w.Code)
	}
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+created.Data.ID, "")
	if !bytes.Contains(w.Body.Bytes(), []byte(store.ApprovalDenied)) {
		t.Fatalf("expect denied, body=%s", w.Body.String())
	}
}

// TestAgentApproval_DenyReason 拒绝理由回传（P-20261003-21）：resolve 带 reason →
// 轮询响应携带（控制符折叠+去首尾空白）→ 随记录持久化 → 列表/广播同源
func TestAgentApproval_DenyReason(t *testing.T) {
	r := setupApprovalTest(t)

	// 广播观测：approval.resolved 必须携带同一 reason（广播载荷是 gin.H）
	var broadcast gin.H
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "approval.resolved" {
			if m, ok := ev.Payload.(gin.H); ok {
				broadcast = m
			}
		}
	})
	defer unsub()

	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"edit .env","target":".env"}`)
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	// 裁决拒绝并附理由：控制字符（\n）折叠为空格 + 首尾空白裁剪
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve",
		`{"allow":false,"reason":"  别动 .env\n改用环境变量  "}`)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body=%s", w.Code, w.Body.String())
	}

	// 轮询响应携带 reason
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+created.Data.ID, "")
	var poll struct {
		Data struct {
			Status string `json:"status"`
			Reason string `json:"reason"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &poll); err != nil {
		t.Fatal(err)
	}
	if poll.Data.Status != store.ApprovalDenied || poll.Data.Reason != "别动 .env 改用环境变量" {
		t.Fatalf("poll expect denied + reason, got %+v", poll.Data)
	}

	// 随记录持久化（store 记录同源）
	stored, err := store.Get().AgentApproval.Get(created.Data.ID)
	if err != nil || stored == nil {
		t.Fatal(err)
	}
	if stored.Reason != "别动 .env 改用环境变量" {
		t.Fatalf("persisted reason = %q", stored.Reason)
	}

	// 广播携带同一 reason
	if broadcast == nil || broadcast["reason"] != "别动 .env 改用环境变量" {
		t.Fatalf("broadcast expect reason carried, got %v", broadcast)
	}

	// 列表（完整记录）同源
	w = doJSON(r, http.MethodGet, "/api/ops-confirm", "")
	if !strings.Contains(w.Body.String(), "别动 .env 改用环境变量") {
		t.Fatalf("list expect reason, body=%s", w.Body.String())
	}
}

// TestAgentApproval_DenyReasonClamp 理由钳制：>200 rune 截到 200；空理由=原行为
// （reason 缺省，字段为空）；allow 携带 reason 不落库（理由仅 deny 语义）
func TestAgentApproval_DenyReasonClamp(t *testing.T) {
	r := setupApprovalTest(t)

	// 超长理由 → 钳到 200 rune
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"clean -fdx"}`)
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("拒", 250)
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve",
		`{"allow":false,"reason":"`+long+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d", w.Code)
	}
	stored, err := store.Get().AgentApproval.Get(created.Data.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := []rune(stored.Reason); len(got) != approvalReasonMax {
		t.Fatalf("reason runes = %d, want %d", len(got), approvalReasonMax)
	}

	// 空理由拒绝（原行为零变化）：字段为空
	w = doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"reset --hard"}`)
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve", `{"allow":false}`); w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d", w.Code)
	}
	if stored, _ = store.Get().AgentApproval.Get(created.Data.ID); stored.Reason != "" {
		t.Fatalf("empty reason expect empty, got %q", stored.Reason)
	}

	// allow 携带 reason → 不落库（理由仅拒绝语义）
	w = doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"push --force"}`)
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve", `{"allow":true,"reason":"放行理由"}`); w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d", w.Code)
	}
	if stored, _ = store.Get().AgentApproval.Get(created.Data.ID); stored.Reason != "" {
		t.Fatalf("allow expect empty reason, got %q", stored.Reason)
	}
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+created.Data.ID, "")
	if strings.Contains(w.Body.String(), "放行理由") {
		t.Fatalf("poll must not carry reason on allow, body=%s", w.Body.String())
	}
}

// TestAgentTask_PersistViaObserver 任务事件经 observer 落库 + 列表查询（B6）
func TestAgentTask_PersistViaObserver(t *testing.T) {
	r := setupApprovalTest(t)
	// 经 opschannel 广播路径触发持久化（模块 Init 已装配 observer）
	opschannel.BroadcastEvent(opschannel.EventTaskProgress, map[string]any{
		"task": "切换主题", "status": "running", "step": "写入设置", "terminalId": "agent-9",
	})
	opschannel.BroadcastEvent(opschannel.EventTaskProgress, map[string]any{
		"task": "切换主题", "status": "done", "terminalId": "agent-9",
	})
	opschannel.BroadcastEvent(opschannel.EventSettingsChanged, nil) // 非任务事件不落库

	list, err := store.Get().AgentTask.List(10, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("expect 2 task events, got %d", len(list))
	}
	if list[0].Status != "done" || list[0].SessionID != "agent-9" {
		t.Fatalf("latest-first + session anchor failed: %+v", list[0])
	}
	// 按 sessionId 过滤
	filtered, _ := store.Get().AgentTask.List(10, "agent-9")
	if len(filtered) != 2 {
		t.Fatalf("session filter expect 2, got %d", len(filtered))
	}
	_ = r
}

// TestAgentApproval_ListParams 列表 limit/status 查询参数（P-20261003-254）：
// 默认不传=全量（兼容既有消费方）；status 过滤只回该状态；limit 收敛为最新 N 条
// （最新在前=CreatedAt 降序）；非法 status 400 稳定码、非法/越界 limit 宽松回全量
func TestAgentApproval_ListParams(t *testing.T) {
	r := setupApprovalTest(t)

	// 直存 store 铸造可控时间线（走 API CreatedAt=time.Now() 无法构造稳定新旧序）：
	// old(pending) / mid(allowed) / new(denied)
	mk := func(id string, status string, at time.Time) {
		a := store.AgentApproval{
			ID: "sc_ap_" + id, Op: "op-" + id, Status: status, CreatedAt: at,
		}
		if status != store.ApprovalPending {
			a.ResolvedAt = &at
		}
		if err := store.Get().AgentApproval.Save(a); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	mk("old", store.ApprovalPending, base)
	mk("mid", store.ApprovalAllowed, base.Add(time.Minute))
	mk("new", store.ApprovalDenied, base.Add(2*time.Minute))

	listIDs := func(query string) []string {
		t.Helper()
		w := doJSON(r, http.MethodGet, "/api/ops-confirm"+query, "")
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d body=%s", query, w.Code, w.Body.String())
		}
		var got struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		ids := make([]string, 0, len(got.Data))
		for _, a := range got.Data {
			ids = append(ids, strings.TrimPrefix(a.ID, "sc_ap_"))
		}
		return ids
	}

	// 默认不传 = 全量三条，最新在前（limit 语义的确定性排序基础）
	if ids := listIDs(""); len(ids) != 3 || ids[0] != "new" || ids[2] != "old" {
		t.Fatalf("default expect full 3 newest-first, got %v", ids)
	}
	// status 过滤：seed 场景语义——pending 全量回（含最旧项，不因新序被 limit 挤出）
	if ids := listIDs("?status=pending"); len(ids) != 1 || ids[0] != "old" {
		t.Fatalf("status=pending expect [old], got %v", ids)
	}
	if ids := listIDs("?status=allowed"); len(ids) != 1 || ids[0] != "mid" {
		t.Fatalf("status=allowed expect [mid], got %v", ids)
	}
	// limit 收敛：最新 N 条（截断最旧）
	if ids := listIDs("?limit=2"); len(ids) != 2 || ids[0] != "new" || ids[1] != "mid" {
		t.Fatalf("limit=2 expect [new mid], got %v", ids)
	}
	// 组合：过滤后再截断
	if ids := listIDs("?status=denied&limit=5"); len(ids) != 1 || ids[0] != "new" {
		t.Fatalf("status=denied&limit=5 expect [new], got %v", ids)
	}
	// 兼容形态：非法 limit（非数字/0/越界）宽松忽略=全量，不 400
	for _, q := range []string{"?limit=abc", "?limit=0", "?limit=-1", "?limit=501"} {
		if ids := listIDs(q); len(ids) != 3 {
			t.Fatalf("%s expect full 3 (lenient), got %v", q, ids)
		}
	}

	// 非法 status → 400 + 稳定码（枚举外静默回全量会误读列表语义）
	w := doJSON(r, http.MethodGet, "/api/ops-confirm?status=bogus", "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad status code = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "ops.confirm_status_invalid") {
		t.Fatalf("bad status expect stable code, body=%s", w.Body.String())
	}
}

// TestAgentApproval_ListHistoryForOp 同类历史查询参数（P-20261005-173）：
// ?historyForOp=<完整 op 串> 按完整 op 精确匹配（大小写敏感）只回已裁决记录
// （pending 不混入——「正在等的这一次」不是历史）、最新在前、无显式 limit 兜底
// 钳 3 条（卡面弱行展示上限，防 30 天窗内同 op 大量记录拉爆 payload）
func TestAgentApproval_ListHistoryForOp(t *testing.T) {
	r := setupApprovalTest(t)

	// 直存 store 铸造可控时间线：op-a 四条已裁决（h1..h4 时间递增）+ op-a 一条
	// pending + op-b 一条已裁决（隔离对照）+ 一条并入主卡的已裁决（联动终态，
	// 事实裁决照常入历史）
	mk := func(id, op, status string, at time.Time) {
		a := store.AgentApproval{
			ID: "sc_ap_" + id, Op: op, Status: status, CreatedAt: at,
		}
		if status != store.ApprovalPending {
			a.ResolvedAt = &at
		}
		if err := store.Get().AgentApproval.Save(a); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	mk("h1", "op-a", store.ApprovalAllowed, base.Add(time.Minute))
	mk("h2", "op-a", store.ApprovalDenied, base.Add(2*time.Minute))
	mk("h3", "op-a", store.ApprovalAllowed, base.Add(3*time.Minute))
	mk("h4", "op-a", store.ApprovalDenied, base.Add(4*time.Minute))
	mk("p1", "op-a", store.ApprovalPending, base.Add(5*time.Minute))
	mk("ob", "op-b", store.ApprovalAllowed, base.Add(6*time.Minute))

	type row struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	listRows := func(query string) []row {
		t.Helper()
		w := doJSON(r, http.MethodGet, "/api/ops-confirm"+query, "")
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d body=%s", query, w.Code, w.Body.String())
		}
		var got struct {
			Data []row `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Data
	}
	trim := func(s string) string { return strings.TrimPrefix(s, "sc_ap_") }

	// 同 op 只回已裁决：pending 不混入；最新在前；钳 3 条（最旧 h1 被挤出）
	rows := listRows("?historyForOp=op-a")
	if len(rows) != 3 {
		t.Fatalf("historyForOp=op-a expect 3 (cap), got %d", len(rows))
	}
	want := []string{"h4", "h3", "h2"}
	for i, id := range want {
		if trim(rows[i].ID) != id {
			t.Fatalf("historyForOp=op-a[%d] = %s, want %s", i, trim(rows[i].ID), id)
		}
	}
	if rows[0].Status != "denied" || rows[1].Status != "allowed" {
		t.Fatalf("history statuses wrong: %v", rows)
	}
	// 隔离对照：他 op 只见自己的已裁决
	rows = listRows("?historyForOp=op-b")
	if len(rows) != 1 || trim(rows[0].ID) != "ob" {
		t.Fatalf("historyForOp=op-b expect [ob], got %+v", rows)
	}
	// 无命中回空数组（零历史不显示由前端据此渲染）
	if rows = listRows("?historyForOp=op-missing"); len(rows) != 0 {
		t.Fatalf("historyForOp=op-missing expect empty, got %+v", rows)
	}
	// 精确匹配：前缀不算命中（MVP 完整串口径的字面行为钉住）
	if rows = listRows("?historyForOp=op-"); len(rows) != 0 {
		t.Fatalf("historyForOp=op- (prefix) expect empty, got %+v", rows)
	}
	// 组合参数被忽略：status/limit 不改变该查询面语义（恒 resolved + 钳 3）
	if rows = listRows("?historyForOp=op-a&status=pending&limit=1"); len(rows) != 3 || trim(rows[0].ID) != "h4" {
		t.Fatalf("historyForOp ignores status/limit, got %+v", rows)
	}
}
