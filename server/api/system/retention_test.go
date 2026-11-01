package system

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/store"
)

// 保留期可配（P-20261003-123）settings 面测试：PUT 白名单边界（0=回落默认 /
// 1~3650 有效 / 越界 400）+ GET 出参回读生效值 + 审计导出窗口跟随配置

// setupRetentionRouter settings + 审计导出同引擎装配（导出窗口跟随用例需要
// 先经 PUT 改配置再调导出）
func setupRetentionRouter(t *testing.T) *gin.Engine {
	r := setupAuditExportRouter(t)
	r.GET("/api/settings", GetSettings)
	r.PUT("/api/settings", UpdateSettings)
	return r
}

func TestUpdateSettings_RetentionDays(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 显式配置保存 + GET 回读
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"auditRetentionDays":90,"logRetentionDays":7}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save retention status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			AuditRetentionDays int `json:"auditRetentionDays"`
			LogRetentionDays   int `json:"logRetentionDays"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.AuditRetentionDays != 90 || got.Data.LogRetentionDays != 7 {
		t.Fatalf("retention roundtrip = (%d,%d), want (90,7)",
			got.Data.AuditRetentionDays, got.Data.LogRetentionDays)
	}

	// 0 = 回落默认（GET 出参收敛生效值，存量行为）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"auditRetentionDays":0,"logRetentionDays":0}`)
	if w.Code != http.StatusOK {
		t.Fatalf("reset retention status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.AuditRetentionDays != 30 || got.Data.LogRetentionDays != 15 {
		t.Fatalf("retention after reset = (%d,%d), want defaults (30,15)",
			got.Data.AuditRetentionDays, got.Data.LogRetentionDays)
	}

	// 未配置（零值配置）GET 出参收敛默认——存量配置升级零变化
	r2 := setupApprovalRulesRouter(t)
	w = doSettingReq(t, r2, http.MethodGet, "/api/settings", "")
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.AuditRetentionDays != 30 || got.Data.LogRetentionDays != 15 {
		t.Fatalf("default retention = (%d,%d), want (30,15)",
			got.Data.AuditRetentionDays, got.Data.LogRetentionDays)
	}

	// 越界/负值 400（写入端拒绝，防手滑超大值让清理语义名存实亡）
	for _, body := range []string{
		`{"auditRetentionDays":9999}`,
		`{"auditRetentionDays":-1}`,
		`{"logRetentionDays":9999}`,
		`{"logRetentionDays":-5}`,
	} {
		w := doSettingReq(t, r, http.MethodPut, "/api/settings", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", body, w.Code)
		}
	}
}

// TestExportAudit_WindowFollowsRetention 导出窗口上限随 settings.auditRetentionDays
// 动态收敛：留存调短后默认导出只取新窗口（45 天前种子按旧 30 天窗本就被裁，
// 这里用 10 天前种子证明 1 天窗把它裁掉、调回 30 天窗后又可见）。按 action 列
// 过滤计数——导出自身入账（audit.export，Time=now 恒在窗内）会让裸行数随
// 导出次数漂移（PaginationLoopPullsFullWindow 同款坑，见其注释）
func TestExportAudit_WindowFollowsRetention(t *testing.T) {
	r := setupRetentionRouter(t)

	unlockRows := func(query string) int {
		n := 0
		for _, rec := range readExportCSV(t, r, query) {
			if len(rec) >= 2 && rec[1] == store.AuditUnlock {
				n++
			}
		}
		return n
	}

	mid := time.Now().Add(-10 * 24 * time.Hour)
	store.Get().Audit.Append(store.AuditEvent{Time: mid, Action: store.AuditUnlock, Result: store.AuditResultFailure})
	store.Get().Audit.Append(store.AuditEvent{Time: time.Now(), Action: store.AuditUnlock, Result: store.AuditResultSuccess})

	// 默认 30 天窗：两条都可见
	if n := unlockRows(""); n != 2 {
		t.Fatalf("default window: expected 2 rows, got %d", n)
	}

	// 调短到 1 天：10 天前种子出窗（无 days 参数 = 新窗口全量）
	if w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"auditRetentionDays":1}`); w.Code != http.StatusOK {
		t.Fatalf("shrink retention status = %d", w.Code)
	}
	if n := unlockRows(""); n != 1 {
		t.Fatalf("1-day window: expected 1 row, got %d", n)
	}

	// days=9999 也只收敛到当前窗口（伪全量防线跟随配置）
	if n := unlockRows("?days=9999"); n != 1 {
		t.Fatalf("clamp to configured window: expected 1 row, got %d", n)
	}

	// 调长到 90 天：10 天前种子重新入窗
	if w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"auditRetentionDays":90}`); w.Code != http.StatusOK {
		t.Fatalf("extend retention status = %d", w.Code)
	}
	if n := unlockRows(""); n != 2 {
		t.Fatalf("90-day window: expected 2 rows, got %d", n)
	}
}
