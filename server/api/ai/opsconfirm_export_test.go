package ai

import (
	"encoding/csv"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 审批裁决历史 CSV 导出（P-20261003-247）单测：列头与字段序、RFC 4180 转义
// 回读、公式注入防护（=+/-@ 前缀单引号，shared.SanitizeCSVCell）、pending 行
// 无裁决时刻（空串）、排序新→旧、Content-Disposition 经统一净化 helper、
// 导出动作同路入账（approval.export）。

// setupApprovalExportRouter 独立临时目录 store + 审批导出路由（与
// setupApprovalTest 同装配口径，另挂 export 段——正式路由表见 router.go）
func setupApprovalExportRouter(t *testing.T) *gin.Engine {
	t.Helper()
	r := setupApprovalTest(t)
	r.GET("/api/ops-confirm/export", ExportAgentApprovals)
	return r
}

// readApprovalExportCSV 请求导出并按 RFC 4180 解析（剥 BOM），返回全部记录
func readApprovalExportCSV(t *testing.T, r *gin.Engine) [][]string {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/ops-confirm/export", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("export: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("expected text/csv content type, got %q", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Errorf("expected attachment disposition, got %q", cd)
	}
	body := strings.TrimPrefix(w.Body.String(), "\xEF\xBB\xBF")
	records, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil {
		t.Fatalf("csv parse: %v", err)
	}
	return records
}

func saveApproval(t *testing.T, a store.AgentApproval) {
	t.Helper()
	if err := store.Get().AgentApproval.Save(a); err != nil {
		t.Fatalf("seed approval: %v", err)
	}
}

func TestExportAgentApprovals_HeaderRowsAndRoundTrip(t *testing.T) {
	r := setupApprovalExportRouter(t)

	now := time.Now()
	resolved := now.Add(-time.Hour)
	saveApproval(t, store.AgentApproval{
		ID: "sc_ap_exp1", Agent: "claude", Op: "reset --hard", Target: `main, "feat"`,
		Detail: "丢弃未推送改动", Status: store.ApprovalAllowed,
		CreatedAt: now.Add(-2 * time.Hour), ResolvedAt: &resolved,
	})
	saveApproval(t, store.AgentApproval{
		ID: "sc_ap_exp2", Op: "delete branch", Target: "tmp/x",
		Status: store.ApprovalDenied, Reason: "先备份",
		CreatedAt: now.Add(-time.Minute), // 未裁决：resolvedAt 空
	})

	records := readApprovalExportCSV(t, r)
	if len(records) != 3 { // 数据行 ×2 + 表头
		t.Fatalf("expected 3 records, got %d: %q", len(records), records)
	}
	const wantHeader = "op,target,result,agent,createdAt,resolvedAt,detail,reason"
	if strings.Join(records[0], ",") != wantHeader {
		t.Errorf("unexpected header: %v", records[0])
	}
	// 新→旧（裁决时刻优先、发起时刻兜底）：exp2 未裁决以 createdAt（now-1min）
	// 排在 exp1（resolvedAt=now-1h）之前
	first, second := records[1], records[2]
	if len(first) != 8 || len(second) != 8 {
		t.Fatalf("expected 8 fields per row, got %v / %v", first, second)
	}
	if first[0] != "delete branch" || first[2] != store.ApprovalDenied || first[7] != "先备份" {
		t.Errorf("row1 (pending, newest createdAt) round-trip failed: %v", first)
	}
	if first[5] != "" {
		t.Errorf("pending row resolvedAt must be empty, got %q", first[5])
	}
	if second[0] != "reset --hard" || second[1] != `main, "feat"` || second[2] != store.ApprovalAllowed || second[3] != "claude" {
		t.Errorf("row2 round-trip failed: %v", second)
	}
	if second[5] != resolved.Format(time.RFC3339) {
		t.Errorf("row2 resolvedAt = %q, want %q", second[5], resolved.Format(time.RFC3339))
	}
}

func TestExportAgentApprovals_InjectionGuard(t *testing.T) {
	r := setupApprovalExportRouter(t)

	saveApproval(t, store.AgentApproval{
		ID: "sc_ap_inj", Op: `=HYPERLINK("http://evil","pwn")`, Target: "-1+cmd|'/C calc'!A0",
		Detail: "@evil", Reason: "\tTAB", Status: store.ApprovalDenied,
		CreatedAt: time.Now(),
	})

	records := readApprovalExportCSV(t, r)
	if len(records) != 2 {
		t.Fatalf("expected header+1, got %d", len(records))
	}
	row := records[1]
	// createdAt 是真实时刻（断言非空 + RFC3339 形态），resolvedAt 未裁决出空串
	created, err := time.Parse(time.RFC3339, row[4])
	if err != nil || created.IsZero() {
		t.Errorf("createdAt = %q, want RFC3339 timestamp", row[4])
	}
	for i, want := range []string{
		`'=HYPERLINK("http://evil","pwn")`, `'-1+cmd|'/C calc'!A0`,
		store.ApprovalDenied, "", row[4], "", `'@evil`, "'\tTAB",
	} {
		if row[i] != want {
			t.Errorf("field[%d] = %q, want %q", i, row[i], want)
		}
	}
}

func TestExportAgentApprovals_AppendsAuditEntry(t *testing.T) {
	r := setupApprovalExportRouter(t)

	saveApproval(t, store.AgentApproval{
		ID: "sc_ap_aud", Op: "push --force", Status: store.ApprovalPending,
		CreatedAt: time.Now(),
	})

	readApprovalExportCSV(t, r)

	events, total, err := store.Get().Audit.List(10, 0)
	if err != nil || total < 1 {
		t.Fatalf("audit list: total=%d err=%v", total, err)
	}
	found := false
	for _, e := range events {
		if e.Action == store.AuditApprovalExport {
			found = true
			if e.Result != store.AuditResultSuccess {
				t.Errorf("export audit result = %q", e.Result)
			}
			if !strings.Contains(e.Detail, "rows=1") {
				t.Errorf("export audit detail = %q, want rows=1", e.Detail)
			}
		}
	}
	if !found {
		t.Errorf("expected %q audit entry, got %+v", store.AuditApprovalExport, events)
	}
}
