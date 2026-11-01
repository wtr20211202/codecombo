package system

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 用户 UI 现场（P-20261004-52）handler 单测：写入/读取契约 + TTL 过期收敛 +
// 设置开关关闭双侧收敛 + 载荷校验与 UpdatedAt 服务端盖戳。
// 不挂中间件——锁保护/令牌鉴权由路由组装承担，本表只测 handler 契约（clip 同口径）。

func init() { gin.SetMode(gin.TestMode) }

func setupUISnapRouter(t *testing.T) {
	t.Helper()
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
}

func performUISnapRequest(t *testing.T, method string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, "/api/ui/snapshot", reader)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	if method == http.MethodPost {
		PostUISnapshot(c)
	} else {
		GetUISnapshot(c)
	}
	return w
}

type uiSnapGetPayload struct {
	Data struct {
		ActiveProjectID         string                `json:"activeProjectId"`
		ActiveFile              *store.UIActiveFile   `json:"activeFile"`
		VisiblePanels           store.UIVisiblePanels `json:"visiblePanels"`
		ActiveTerminalSessionID string                `json:"activeTerminalSessionId"`
		UpdatedAt               string                `json:"updatedAt"`
		AgeSeconds              int                   `json:"ageSeconds"`
	} `json:"data"`
	Code string `json:"code"`
}

func TestUISnap_PostThenGet(t *testing.T) {
	setupUISnapRouter(t)

	w := performUISnapRequest(t, http.MethodPost, store.UISnapshot{
		ActiveProjectID: "proj-1",
		ActiveFile:      &store.UIActiveFile{Path: "web/src/main.ts", Line: 200, Column: 7},
		VisiblePanels:   store.UIVisiblePanels{Side: "files", SideOpen: true, Bottom: "terminal", BottomOpen: false},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("post status = %d, body=%s", w.Code, w.Body.String())
	}

	w = performUISnapRequest(t, http.MethodGet, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get status = %d, body=%s", w.Code, w.Body.String())
	}
	var got uiSnapGetPayload
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.ActiveProjectID != "proj-1" || got.Data.ActiveFile == nil ||
		got.Data.ActiveFile.Path != "web/src/main.ts" || got.Data.ActiveFile.Line != 200 {
		t.Fatalf("roundtrip mismatch: %+v", got.Data)
	}
	if got.Data.VisiblePanels.Side != "files" || !got.Data.VisiblePanels.SideOpen {
		t.Fatalf("visiblePanels mismatch: %+v", got.Data.VisiblePanels)
	}
	if got.Data.UpdatedAt == "" || got.Data.AgeSeconds < 0 {
		t.Fatalf("updatedAt/ageSeconds missing: %+v", got.Data)
	}
}

// TestUISnap_TTLExpired 查无：服务端时钟判定（注入未来时刻模拟 10 分钟无心跳）
func TestUISnap_TTLExpired(t *testing.T) {
	setupUISnapRouter(t)
	if w := performUISnapRequest(t, http.MethodPost, store.UISnapshot{
		ActiveProjectID: "proj-1",
		VisiblePanels:   store.UIVisiblePanels{Side: "files", SideOpen: true},
	}); w.Code != http.StatusOK {
		t.Fatalf("post status = %d", w.Code)
	}

	defer func(orig func() time.Time) { uisnapNow = orig }(uisnapNow)
	uisnapNow = func() time.Time { return time.Now().Add(store.UISnapshotTTL + time.Minute) }

	w := performUISnapRequest(t, http.MethodGet, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expired get status = %d, want 404", w.Code)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("ui.snapshot_unavailable")) {
		t.Fatalf("expired body missing stable code: %s", w.Body.String())
	}
}

// TestUISnap_DisabledBySetting 开关关 = 端点查无（存量快照也不可读——隐私关闭
// 立即生效，不残留 10 分钟窗口）
func TestUISnap_DisabledBySetting(t *testing.T) {
	setupUISnapRouter(t)
	off := false
	cfg := store.Get().Settings.Get()
	cfg.Server.UISnapshotEnabled = &off
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatal(err)
	}

	if w := performUISnapRequest(t, http.MethodPost, store.UISnapshot{
		VisiblePanels: store.UIVisiblePanels{Side: "files", SideOpen: true},
	}); w.Code != http.StatusOK {
		t.Fatalf("post (reporter stop is client-side) status = %d", w.Code)
	}
	w := performUISnapRequest(t, http.MethodGet, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("disabled get status = %d, want 404", w.Code)
	}

	// 重新打开即恢复可读
	on := true
	cfg.Server.UISnapshotEnabled = &on
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatal(err)
	}
	if w := performUISnapRequest(t, http.MethodGet, nil); w.Code != http.StatusOK {
		t.Fatalf("re-enabled get status = %d, want 200", w.Code)
	}
}

// TestUISnap_PayloadValidation 载荷校验：畸形 JSON / 字段超上界稳定 400 +
// ui.payload_invalid；UpdatedAt 不采信调用方（服务端盖戳）
func TestUISnap_PayloadValidation(t *testing.T) {
	setupUISnapRouter(t)

	req := httptest.NewRequest(http.MethodPost, "/api/ui/snapshot", bytes.NewReader([]byte("{not json")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	PostUISnapshot(c)
	if w.Code != http.StatusBadRequest || !bytes.Contains(w.Body.Bytes(), []byte("ui.payload_invalid")) {
		t.Fatalf("malformed json status=%d body=%s", w.Code, w.Body.String())
	}

	w = performUISnapRequest(t, http.MethodPost, store.UISnapshot{
		ActiveFile: &store.UIActiveFile{Path: string(make([]byte, 2048)), Line: 1},
	})
	if w.Code != http.StatusBadRequest || !bytes.Contains(w.Body.Bytes(), []byte("ui.payload_invalid")) {
		t.Fatalf("oversized path status=%d body=%s", w.Code, w.Body.String())
	}

	// UpdatedAt 调用方传入无效值：服务端盖戳覆写（TTL 唯一时钟源）
	w = performUISnapRequest(t, http.MethodPost, store.UISnapshot{
		VisiblePanels: store.UIVisiblePanels{Side: "git", SideOpen: true},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("minimal snapshot rejected: %d %s", w.Code, w.Body.String())
	}
	if _, err := store.Get().UISnap.GetAlive(time.Now()); err != nil {
		t.Fatalf("minimal snapshot not readable: %v", err)
	}
}
