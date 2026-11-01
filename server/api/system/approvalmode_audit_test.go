package system

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	filestore "codecombo/server/filestore"
	"codecombo/server/store"
)

// 审批档位变更审计（P-20261005-162）——设置页 PUT 写点：档位实际翻转入账一条
// approval.mode（Detail=old→new，24h 档追记到期时刻）；同值保存零入账（设置页
// 整体提交每次都携带 mode 字段，按次入账会把日常保存变成台账噪音）

// restoreTierAfter 档位字段恢复（包级单例纪律，ai 包 withTierMode 同款）：档位
// 落在 config.Load 包级单例上（新 store 缺 config 文档时回落它），本组用例翻过
// 档位，退出时不恢复会泄漏给同包后续用例（全局放行短路让规则命中测试全体失真）
func restoreTierAfter(t *testing.T) {
	t.Helper()
	cfg := store.Get().Settings.Get()
	savedMode := cfg.Server.AgentApprovalMode
	savedExp := cfg.Server.AgentApprovalExpiresAt
	savedMap := cfg.Server.AgentSessionAllows
	t.Cleanup(func() {
		cfg.Server.AgentApprovalMode = savedMode
		cfg.Server.AgentApprovalExpiresAt = savedExp
		cfg.Server.AgentSessionAllows = savedMap
	})
}

func TestUpdateSettings_ApprovalModeAudit(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := setupApprovalRulesRouter(t)
	restoreTierAfter(t)

	// 翻转入账：ask → allow-24h，Detail 携 old→new + 到期时刻（时限边界证据）
	if w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"agentApprovalMode":"allow-24h"}`); w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	var found *store.AuditEvent
	for i := range events {
		if events[i].Action == store.AuditApprovalMode {
			found = &events[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("mode flip must be audited, got %+v", events)
	}
	if found.Result != store.AuditResultSuccess {
		t.Fatalf("result = %q, want success", found.Result)
	}
	if !strings.Contains(found.Detail, config.ApprovalModeAsk+" → "+config.ApprovalModeAllow24h) {
		t.Fatalf("detail = %q, want ask → allow-24h", found.Detail)
	}
	if !strings.Contains(found.Detail, "expires ") {
		t.Fatalf("detail = %q, want 24h expiry timestamp", found.Detail)
	}

	// 同值保存零入账：再次提交同一档位（无论携带多少其他设置字段），台账不新增
	_, total, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"agentApprovalMode":"allow-24h","autoFetch":true}`); w.Code != http.StatusOK {
		t.Fatalf("idempotent save status = %d", w.Code)
	}
	_, totalAfter, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if totalAfter != total {
		t.Fatalf("same-mode save must not append audit, total %d → %d", total, totalAfter)
	}

	// 翻转回 ask：new 方向也入账（收回放权同样值得追认）
	if w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"agentApprovalMode":"ask"}`); w.Code != http.StatusOK {
		t.Fatalf("revert status = %d", w.Code)
	}
	ev := lastApprovalModeAudit(t)
	if ev == nil || !strings.Contains(ev.Detail, config.ApprovalModeAllow24h+" → "+config.ApprovalModeAsk) {
		t.Fatalf("revert must be audited with allow-24h → ask, got %+v", ev)
	}
}

// lastApprovalModeAudit 最近一条 approval.mode 审计事件（无则 nil）
func lastApprovalModeAudit(t *testing.T) *store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := range events {
		if events[i].Action == store.AuditApprovalMode {
			return &events[i]
		}
	}
	return nil
}

// 到期时刻格式口径自证：PUT 写点的 expires 后缀是 RFC3339 UTC（与 ai 包 resolve/
// sweep 两写点同形态，审计面板/CSV 消费方按同一口径解析）
func TestApprovalModeAuditDetailExpiryIsRFC3339(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := setupApprovalRulesRouter(t)
	restoreTierAfter(t)

	if w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"agentApprovalMode":"allow-24h"}`); w.Code != http.StatusOK {
		t.Fatalf("save status = %d", w.Code)
	}
	detail := lastApprovalModeAudit(t).Detail
	idx := strings.Index(detail, "expires ")
	if idx < 0 {
		t.Fatalf("detail = %q, want expires suffix", detail)
	}
	ts := strings.TrimSuffix(detail[idx+len("expires "):], ")")
	if _, err := time.Parse(time.RFC3339, ts); err != nil {
		t.Fatalf("expiry suffix %q not RFC3339: %v (detail=%q)", ts, err, detail)
	}
}
