package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"codecombo/server/store"
)

// impact 结构化影响面（P-20261003-319）：可选字段的合法落库 / 坏载荷 400 稳定码
// / 老载荷零破坏三条主线。校验参数与清洗口径见 opsconfirm.go cleanApprovalImpact。

// createdID 建单成功取审批 id（bodyCode 同款装配复用）
func createdID(t *testing.T, body string) string {
	t.Helper()
	var m struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("decode body: %v (%s)", err, body)
	}
	return m.Data.ID
}

// listApproval 取落库记录（List 返回全字段，含 impact）
func listApproval(t *testing.T, id string) *store.AgentApproval {
	t.Helper()
	list, err := store.Get().AgentApproval.List("", 0)
	if err != nil {
		t.Fatalf("list approvals: %v", err)
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	t.Fatalf("approval %s not found in list", id)
	return nil
}

// TestAgentApproval_Impact_Valid 合法 impact 全字段落库：清洗后（trim）随记录
// 持久化；广播/列表同源（广播载荷即完整记录）
func TestAgentApproval_Impact_Valid(t *testing.T) {
	r := setupApprovalTest(t)
	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"sc-impact-1","op":"delete branch","target":"feature/x","detail":"长散文……","impact":{"kind":"delete","summary":" 将删除 12 个文件 ","filesCount":12,"commands":["git branch -D feature/x"]}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	a := listApproval(t, createdID(t, w.Body.String()))
	if a.Impact == nil {
		t.Fatal("impact missing on persisted record")
	}
	if a.Impact.Kind != "delete" || a.Impact.Summary != "将删除 12 个文件" {
		t.Errorf("impact kind/summary = %q/%q, want delete/将删除 12 个文件（trim 后）", a.Impact.Kind, a.Impact.Summary)
	}
	if a.Impact.FilesCount == nil || *a.Impact.FilesCount != 12 {
		t.Errorf("filesCount = %v, want 12", a.Impact.FilesCount)
	}
	if len(a.Impact.Commands) != 1 || a.Impact.Commands[0] != "git branch -D feature/x" {
		t.Errorf("commands = %v, want [git branch -D feature/x]", a.Impact.Commands)
	}
	// 显式 0 文件计数与未附带是两回事（指针语义）：0 要保留
	w = doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"op":"deploy","impact":{"kind":"deploy","summary":"重新部署生产环境","filesCount":0}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d", w.Code)
	}
	a = listApproval(t, createdID(t, w.Body.String()))
	if a.Impact == nil || a.Impact.FilesCount == nil || *a.Impact.FilesCount != 0 {
		t.Errorf("explicit zero filesCount lost: %+v", a.Impact)
	}
	// 空命令数组与缺席等价：归一为 nil（前端只看有/无）
	w = doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"op":"reset","impact":{"kind":"reset","summary":"回退 main 三个提交","commands":[]}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d", w.Code)
	}
	a = listApproval(t, createdID(t, w.Body.String()))
	if a.Impact == nil || a.Impact.Commands != nil {
		t.Errorf("empty commands should normalize to nil, got %+v", a.Impact)
	}
}

// TestAgentApproval_Impact_Omitted 无 impact 老载荷零破坏：记录 impact 为 nil，
// JSON 序列化 omitempty 不出现该键
func TestAgentApproval_Impact_Omitted(t *testing.T) {
	r := setupApprovalTest(t)
	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"sc-impact-2","op":"reset --hard","target":"main","detail":"散文 detail"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d", w.Code)
	}
	a := listApproval(t, createdID(t, w.Body.String()))
	if a.Impact != nil {
		t.Errorf("impact should be nil without payload, got %+v", a.Impact)
	}
	if strings.Contains(w.Body.String(), `"impact"`) {
		t.Errorf("legacy create response should not mention impact: %s", w.Body.String())
	}
}

// TestAgentApproval_Impact_Invalid 坏载荷逐形态 400 + 稳定码
// ops.confirm_impact_invalid（agent 按 code 分支：修正或去掉 impact 重发）
func TestAgentApproval_Impact_Invalid(t *testing.T) {
	r := setupApprovalTest(t)
	longSummary := strings.Repeat("长", 201) // 201 rune 超上限
	cases := []struct {
		name, impact string
	}{
		{"kind 枚举外", `{"kind":"nuke","summary":"x"}`},
		{"kind 缺失", `{"summary":"x"}`},
		{"summary 空白", `{"kind":"delete","summary":"   "}`},
		{"summary 超 200 rune", `{"kind":"delete","summary":"` + longSummary + `"}`},
		{"filesCount 负数", `{"kind":"delete","summary":"x","filesCount":-1}`},
		{"commands 超 5 条", `{"kind":"other","summary":"x","commands":["a","b","c","d","e","f"]}`},
		{"command 空白", `{"kind":"other","summary":"x","commands":["  "]}`},
		{"command 超 200 rune", `{"kind":"other","summary":"x","commands":["` + strings.Repeat("c", 201) + `"]}`},
	}
	for _, tc := range cases {
		w := doJSON(r, http.MethodPost, "/api/ops-confirm",
			`{"op":"ok","impact":`+tc.impact+`}`)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400, body=%s", tc.name, w.Code, w.Body.String())
			continue
		}
		if got := bodyCode(t, w.Body.String()); got != "ops.confirm_impact_invalid" {
			t.Errorf("%s: code = %q, want ops.confirm_impact_invalid", tc.name, got)
		}
	}
	// 校验失败不落库：整表无新增 pending
	list, err := store.Get().AgentApproval.List("", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Errorf("rejected payloads must not persist, got %d records", len(list))
	}
}

// TestAgentApproval_Impact_PollResponse 轮询 GET /api/ops-confirm/:id 响应携
// impact（P-20261006-35：guarded 服务端拦截填充后 agent 轮询同步自知影响面，
// 人与 agent 双读）；未附带未填充（nil）序列化为 null——旧轮询方忽略即可
func TestAgentApproval_Impact_PollResponse(t *testing.T) {
	r := setupApprovalTest(t)
	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"op":"删除项目","impact":{"kind":"delete","summary":"将终止该项目 2 个终端会话"}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	id := createdID(t, w.Body.String())
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+id, "")
	if w.Code != http.StatusOK {
		t.Fatalf("poll status = %d", w.Code)
	}
	var poll struct {
		Data struct {
			ID     string                `json:"id"`
			Status string                `json:"status"`
			Impact *store.ApprovalImpact `json:"impact"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &poll); err != nil {
		t.Fatalf("decode poll body: %v (%s)", err, w.Body.String())
	}
	if poll.Data.ID != id || poll.Data.Status != store.ApprovalPending {
		t.Fatalf("poll data = %+v", poll.Data)
	}
	if poll.Data.Impact == nil || poll.Data.Impact.Kind != "delete" ||
		poll.Data.Impact.Summary != "将终止该项目 2 个终端会话" {
		t.Fatalf("poll 响应应携 impact: %+v", poll.Data.Impact)
	}

	// 无 impact 老形态：响应 impact 为 null（键在场值空，旧轮询方忽略即可）
	w = doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"git push"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d", w.Code)
	}
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+createdID(t, w.Body.String()), "")
	if w.Code != http.StatusOK {
		t.Fatalf("poll status = %d", w.Code)
	}
	var legacy struct {
		Data struct {
			Impact *store.ApprovalImpact `json:"impact"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &legacy); err != nil {
		t.Fatalf("decode poll body: %v (%s)", err, w.Body.String())
	}
	if legacy.Data.Impact != nil {
		t.Fatalf("无 impact 记录轮询应为 null: %+v", legacy.Data.Impact)
	}
}
