package gitops

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/store"
)

// ── 补丁导出的出域记账（P-20261005-186，patch.export）──
// 两个补丁出域口（POST /patch/export 内容直出、GET /patch .patch 附件下载）
// 同账同 scope 词汇（patchAuditScope 与下载端 scope=worktree|staged|head 对账）；
// 空 diff 400 / 敏感闸 warnings 分支零入账（未出内容不算出域，terminal 导出闸
// 同口径）。导出族记账清单见 server/store/auditlog.go 常量块尾注。

func patchAuditEvents(t *testing.T) []store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	return events
}

func TestPatchExport_AuditsBothEndpoints(t *testing.T) {
	f := newFixtureRepo(t)
	r := setupPatchDownloadTest(t, f)

	// worktree 未暂存变更：POST 直出一条 patch.export（工作区两态缺省分支）
	f.write("a.txt", "dirty\n")
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/patch/export",
		strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST patch/export status = %d, body=%s", w.Code, w.Body.String())
	}

	// 空 staged：GET 先 400——空 diff 分支零入账的顺带验证
	if w := getPatch(r, "staged"); w.Code != http.StatusBadRequest {
		t.Fatalf("empty staged should stay 400, got %d", w.Code)
	}
	if n := len(patchAuditEvents(t)); n != 1 {
		t.Fatalf("400 branch must not audit, events = %d", n)
	}

	// GET .patch 下载（staged 有变更）：再一条 patch.export
	f.write("b.txt", "staged\n")
	f.run("add", "b.txt")
	if w := getPatch(r, "staged"); w.Code != http.StatusOK {
		t.Fatalf("GET patch status = %d, body=%s", w.Code, w.Body.String())
	}

	events := patchAuditEvents(t)
	if len(events) != 2 {
		t.Fatalf("audit events = %d, want 2 (one per egress endpoint)", len(events))
	}
	for i, ev := range events {
		if ev.Action != store.AuditPatchExport {
			t.Fatalf("event[%d] action = %s, want %s", i, ev.Action, store.AuditPatchExport)
		}
		if ev.Result != store.AuditResultSuccess {
			t.Fatalf("event[%d] result = %s", i, ev.Result)
		}
		if !strings.HasPrefix(ev.Detail, "t: ") {
			t.Fatalf("event[%d] detail %q must be prefixed with project name", i, ev.Detail)
		}
	}
	// List 倒序（最新在前）：[0] = GET staged、[1] = POST worktree
	if events[0].Detail != "t: scope=staged" {
		t.Fatalf("GET download detail = %q, want %q", events[0].Detail, "t: scope=staged")
	}
	if events[1].Detail != "t: scope=worktree" {
		t.Fatalf("POST export detail = %q, want %q", events[1].Detail, "t: scope=worktree")
	}
}

// TestPatchAuditScope_Matrix 请求形态归一矩阵：显式提交清单 > 区间 > 工作区两态
// （与 ExportPatch handler 分支序一致；scope 词汇与 GET 下载端对账）
func TestPatchAuditScope_Matrix(t *testing.T) {
	cases := []struct {
		name    string
		commits int
		from    string
		to      string
		staged  bool
		want    string
	}{
		{"range wins", 3, "abc", "def", true, "range=abc..def"},
		{"commits count", 2, "", "", false, "commits=2"},
		{"staged", 0, "", "", true, "scope=staged"},
		{"worktree default", 0, "", "", false, "scope=worktree"},
		{"half range falls through", 0, "abc", "", false, "scope=worktree"},
	}
	for _, tc := range cases {
		if got := patchAuditScope(tc.commits, tc.from, tc.to, tc.staged); got != tc.want {
			t.Errorf("%s: patchAuditScope = %q, want %q", tc.name, got, tc.want)
		}
	}
}
