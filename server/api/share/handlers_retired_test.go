package shareapi

import (
	"net/http"
	"testing"
	"time"

	"codecombo/server/store"
)

// 退役访问投影与端到端管理面链路（P-20261008-2）：shareResponse 的
// retiredHits/lastRetiredAt 投影 + rotate→命中落盘→列表徽标数据源的闭环。
// 复用 handlers_test.go 的 newAdminRouter/doJSON helper。

// TestRetiredHitsProjection rotate 后列表行携带退役命中投影（有命中才携带
// ——无退役史/未被踩的行零噪音）；撤销后行消失（台账随宿主消亡）
func TestRetiredHitsProjection(t *testing.T) {
	r := newAdminRouter(t)

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create = %d, body=%v", code, out)
	}
	created, _ := out["data"].(map[string]any)
	oldToken, _ := created["token"].(string)

	// 未轮换：列表行无 retiredHits（零值缺省——有命中才投影的缺省纪律）
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list = %d", code)
	}
	rows, _ := out["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if _, has := rows[0].(map[string]any)["retiredHits"]; has {
		t.Fatal("fresh share must not carry retiredHits")
	}

	// 轮换 → 模拟退役命中落盘（RecordRetiredHit：访客面攒批冲刷的等价直写）
	code, out = doJSON(r, http.MethodPost, "/api/share/"+oldToken+"/rotate", "")
	if code != http.StatusOK {
		t.Fatalf("rotate = %d, body=%v", code, out)
	}
	rot, _ := out["data"].(map[string]any)
	newToken, _ := rot["token"].(string)
	if newToken == oldToken || newToken == "" {
		t.Fatalf("rotate produced token %v", newToken)
	}
	if _, has := rot["retiredHits"]; has {
		t.Fatal("freshly retired link has no hits yet — projection must stay absent")
	}
	at := time.Now().Add(-time.Minute)
	if _, err := store.Get().Share.RecordRetiredHit(oldToken, 2, at); err != nil {
		t.Fatal(err)
	}

	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list = %d", code)
	}
	rows, _ = out["data"].([]any)
	row, _ := rows[0].(map[string]any)
	if row["token"] != newToken {
		t.Fatalf("row token = %v, want current generation", row["token"])
	}
	if n, _ := row["retiredHits"].(float64); n != 2 {
		t.Fatalf("retiredHits = %v, want 2", row["retiredHits"])
	}
	lr, _ := row["lastRetiredAt"].(string)
	if lr == "" {
		t.Fatal("lastRetiredAt must be projected alongside hits")
	}
	if _, err := time.Parse(time.RFC3339, lr); err != nil {
		t.Fatalf("lastRetiredAt not RFC3339: %v", err)
	}

	// 撤销宿主：列表行消失（退役观测随宿主消亡的响应面镜像）
	if code, _ = doJSON(r, http.MethodDelete, "/api/share/"+newToken, ""); code != http.StatusOK {
		t.Fatalf("delete = %d", code)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	rows, _ = out["data"].([]any)
	if len(rows) != 0 {
		t.Fatalf("rows after revoke = %d, want 0", len(rows))
	}
}

// TestRetiredHitUnknownTokenRejected 未知退役 token 的落盘侧拒绝（宿主已
// 消亡/从未存在 → ErrNotFound，访客面 flush 侧丢弃该批的契约锚）
func TestRetiredHitUnknownTokenRejected(t *testing.T) {
	r := newAdminRouter(t)
	_, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	created, _ := out["data"].(map[string]any)
	oldToken, _ := created["token"].(string)
	if _, err := store.Get().Share.RecordRetiredHit(oldToken, 1, time.Now()); err == nil {
		t.Fatal("live token is not a retired token — RecordRetiredHit must reject")
	}
	_ = r
}
