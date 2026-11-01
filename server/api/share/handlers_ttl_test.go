package shareapi

// 分享有效期闭环（P-20261020-5）创建面：POST /api/share 可选 ttl/expiresAt +
// settings.shareDefaultTTL 兜底。覆盖显式预设/自定义时点/默认档/显式永久
// （frozen 清 30 天默认）/非法档位/互斥字段/幂等重建的显式改期语义。

import (
	"net/http"
	"testing"
	"time"

	"codecombo/server/store"
)

// ttlResponseExpiry data.expiresAt（RFC3339）→ 时点；缺省返回零值
func ttlResponseExpiry(t *testing.T, data map[string]any) time.Time {
	t.Helper()
	raw, ok := data["expiresAt"].(string)
	if !ok || raw == "" {
		return time.Time{}
	}
	at, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatalf("parse expiresAt %q: %v", raw, err)
	}
	return at
}

// assertTTLNear 断言到期时点落在 now+d 的宽容窗口内（±1 分钟：请求处理耗时）
func assertTTLNear(t *testing.T, at time.Time, d time.Duration) {
	t.Helper()
	if at.IsZero() {
		t.Fatalf("expiresAt missing, want ~%v", d)
	}
	if delta := time.Until(at); delta > d+time.Minute || delta < d-time.Minute {
		t.Fatalf("expiresAt delta = %v, want ~%v", delta, d)
	}
}

func TestCreateShareTTLPresets(t *testing.T) {
	r := newAdminRouter(t)

	// ttl=1h：创建即落显式窗口
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","ttl":"1h"}`)
	if code != http.StatusOK {
		t.Fatalf("ttl=1h status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	assertTTLNear(t, ttlResponseExpiry(t, data), time.Hour)

	// ttl=7d：同一目标幂等命中既有记录——显式选择允许改期（store 幂等分支
	// 默认保留旧倒计时，显式选择经 applyExplicitExpiry 覆写）
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","ttl":"7d"}`)
	if code != http.StatusOK {
		t.Fatalf("ttl=7d status = %d, body = %v", code, out)
	}
	data, _ = out["data"].(map[string]any)
	assertTTLNear(t, ttlResponseExpiry(t, data), 7*24*time.Hour)

	// ttl=permanent：显式清窗（幂等记录同样生效）
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","ttl":"permanent"}`)
	if code != http.StatusOK {
		t.Fatalf("ttl=permanent status = %d, body = %v", code, out)
	}
	data, _ = out["data"].(map[string]any)
	if at := ttlResponseExpiry(t, data); !at.IsZero() {
		t.Fatalf("explicit permanent must clear expiresAt, got %v", at)
	}

	// 未显式选择重复创建：保留既有状态（此时为永久），不得无声续期
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("plain recreate status = %d", code)
	}
	if at := ttlResponseExpiry(t, out["data"].(map[string]any)); !at.IsZero() {
		t.Fatalf("plain recreate must not invent an expiry, got %v", at)
	}
}

func TestCreateShareTTLExpiresAt(t *testing.T) {
	r := newAdminRouter(t)
	fixed := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	body := `{"projectId":"p1","path":"note.txt","expiresAt":"` + fixed.Format(time.RFC3339) + `"}`
	code, out := doJSON(r, http.MethodPost, "/api/share", body)
	if code != http.StatusOK {
		t.Fatalf("expiresAt status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	at := ttlResponseExpiry(t, data)
	if !at.Equal(fixed) {
		t.Fatalf("expiresAt = %v, want %v", at, fixed)
	}

	// 列表投影同样携带 expiresAt（管理面倒计时数据源）
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	list, _ := out["data"].([]any)
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
	row, _ := list[0].(map[string]any)
	if got := ttlResponseExpiry(t, row); !got.Equal(fixed) {
		t.Fatalf("list expiresAt = %v, want %v", got, fixed)
	}
}

func TestCreateShareTTLValidation(t *testing.T) {
	r := newAdminRouter(t)
	for _, tc := range []struct {
		name string
		body string
	}{
		{"invalid-preset", `{"projectId":"p1","path":"note.txt","ttl":"2d"}`},
		{"both-fields", `{"projectId":"p1","path":"note.txt","ttl":"1d","expiresAt":"2026-12-01T00:00:00Z"}`},
	} {
		code, out := doJSON(r, http.MethodPost, "/api/share", tc.body)
		if code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400 (body=%v)", tc.name, code, out)
		}
	}
}

func TestCreateShareDefaultTTLSetting(t *testing.T) {
	r := newAdminRouter(t)

	// 缺省（未配置）= 永久：存量行为零变化
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("default create status = %d", code)
	}
	if at := ttlResponseExpiry(t, out["data"].(map[string]any)); !at.IsZero() {
		t.Fatalf("default create must stay permanent, got %v", at)
	}

	// 配置默认 1d：未显式选择的创建应用默认档
	cfg := store.Get().Settings.Get()
	cfg.Server.ShareDefaultTTL = "1d"
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("default=1d create status = %d", code)
	}
	// 幂等命中既有永久记录：默认档不覆写既有记录（只有显式选择才改期）
	if at := ttlResponseExpiry(t, out["data"].(map[string]any)); !at.IsZero() {
		t.Fatalf("default TTL must not override existing record, got %v", at)
	}

	// 新目标：默认档生效
	if code, _ = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":""}`); code != http.StatusOK {
		t.Fatalf("new target create status = %d", code)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	list, _ := out["data"].([]any)
	found := false
	for _, item := range list {
		row, _ := item.(map[string]any)
		if row["path"] == "" {
			found = true
			assertTTLNear(t, ttlResponseExpiry(t, row), 24*time.Hour)
		}
	}
	if !found {
		t.Fatal("project-root share missing from list")
	}

	// 显式选择优先于默认档
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","ttl":"permanent"}`)
	if code != http.StatusOK {
		t.Fatalf("explicit permanent status = %d", code)
	}
	if at := ttlResponseExpiry(t, out["data"].(map[string]any)); !at.IsZero() {
		t.Fatalf("explicit permanent must win over default TTL, got %v", at)
	}
}
