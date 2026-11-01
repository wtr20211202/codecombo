package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// P-20261003-305 门禁：ops 域错误面的 code 稳定断言——ops-notify 载荷校验与
// ops-confirm（git 危险操作确认）的错误分支依据。code 字面与共享注册表
// （server/api/shared/errors.go）一一对应，漂移在此翻红。

// bodyCode 取响应体 code 字段（复用本包既有 doJSON 装配）
func bodyCode(t *testing.T, body string) string {
	t.Helper()
	var m struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("decode body: %v (%s)", err, body)
	}
	return m.Code
}

// ops-notify：载荷校验三形态各带稳定 code；限流不走错误通道（200 静默丢弃，
// 由 opsnotify_ratelimit_test 覆盖——此处锁定「合法事件 200 无 code」的对照面）
func TestOpsNotify_ErrorCodes(t *testing.T) {
	r := setupNotifyTest(t)

	cases := []struct {
		name, body, wantCode string
	}{
		{"非法 JSON", `{bad`, "ops.payload_invalid"},
		{"system: 保留前缀", `{"type":"system:fake"}`, "ops.event_type_invalid"},
		{"type 超长", `{"type":"` + strings.Repeat("x", 65) + `"}`, "ops.event_type_invalid"},
		{"preview.port 坏载荷", `{"type":"preview.port","payload":{}}`, "ops.event_payload_invalid"},
		{"task.progress 坏载荷", `{"type":"task.progress","payload":{"steps":"no"}}`, "ops.event_payload_invalid"},
		{"open-file-at 坏载荷", `{"type":"open-file-at","payload":{"path":"/abs/path","projectId":"p"}}`, "ops.event_payload_invalid"},
	}
	for _, tc := range cases {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", tc.body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400, body=%s", tc.name, w.Code, w.Body.String())
			continue
		}
		if got := bodyCode(t, w.Body.String()); got != tc.wantCode {
			t.Errorf("%s: code = %q, want %q", tc.name, got, tc.wantCode)
		}
	}

	// 对照面：合法发布 200 且无 code 字段（错误码只出现在错误面）
	w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":"navigate","payload":{"path":"/"}}`)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), `"code"`) {
		t.Errorf("valid publish should be 200 without code field, got %d %s", w.Code, w.Body.String())
	}
}

// ops-confirm（git 危险操作确认）：建单校验/轮询 404/重复裁决 409 各带稳定 code
func TestOpsConfirm_ErrorCodes(t *testing.T) {
	r := setupApprovalTest(t)

	// op 空白（required 通过、TrimSpace 后为空）→ 400 + ops.confirm_op_invalid
	//（空串会被 binding:required 先拦成 ops.payload_invalid，两条 400 码互不重叠）
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"   "}`)
	if w.Code != http.StatusBadRequest || bodyCode(t, w.Body.String()) != "ops.confirm_op_invalid" {
		t.Errorf("op invalid: %d %s", w.Code, w.Body.String())
	}

	// target 超长 → 400 + ops.confirm_field_too_long
	long := strings.Repeat("x", 600)
	w = doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"ok","target":"`+long+`"}`)
	if w.Code != http.StatusBadRequest || bodyCode(t, w.Body.String()) != "ops.confirm_field_too_long" {
		t.Errorf("field too long: %d %s", w.Code, w.Body.String())
	}

	// 轮询不存在的审批 → 404 + ops.confirm_not_found
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/no-such-id", "")
	if w.Code != http.StatusNotFound || bodyCode(t, w.Body.String()) != "ops.confirm_not_found" {
		t.Errorf("not found: %d %s", w.Code, w.Body.String())
	}

	// 重复裁决 → 409 + ops.confirm_already_resolved（幂等拒绝）
	w = doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"reset --hard","target":"main"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create approval failed: %d %s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve", `{"allow":true}`); w.Code != http.StatusOK {
		t.Fatalf("first resolve failed: %d %s", w.Code, w.Body.String())
	}
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+created.Data.ID+"/resolve", `{"allow":true}`)
	if w.Code != http.StatusConflict || bodyCode(t, w.Body.String()) != "ops.confirm_already_resolved" {
		t.Errorf("already resolved: %d %s", w.Code, w.Body.String())
	}
}
