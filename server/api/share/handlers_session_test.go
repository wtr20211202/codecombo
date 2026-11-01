package shareapi

// 会话回放只读分享（P-20261003-77）管理面单测：创建校验 / 条目快照落盘与
// P-108 遮蔽（思考块与工具详情可见、命中值 ***）/ 默认 24h TTL / 幂等同链
// 不续期且重分享跟进新增回合 / rotate 快照不迁 / 撤销即删快照 / 列表
// sessionId 投影。访客页在 server/share 单测与定向 e2e 覆盖。

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

const sessionFixtureID = "e2e-share-session-1"

// sessionEnv 数据目录 + Claude 目录隔离；默认 store 装配
func sessionEnv(t *testing.T) string {
	t.Helper()
	claudeRoot := t.TempDir()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	t.Setenv("CC_CLAUDE_DIR", claudeRoot)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	return claudeRoot
}

func sessionFixtureLine(t *testing.T, root, sessionID, text string) {
	t.Helper()
	dir := filepath.Join(root, "D--e2e-session-fixture")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir fixtures: %v", err)
	}
	f, err := os.OpenFile(filepath.Join(dir, sessionID+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer f.Close()
	if _, err := f.WriteString(text + "\n"); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
}

// seedSessionFixture 标准会话：user（标题+敏感赋值）→ assistant（思考+正文+
// 工具）→ 工具结果；思考/工具详情是访客可见口径的锚点，hunter2/sca_ 是
// P-108 遮蔽断言点
func seedSessionFixture(t *testing.T, root, sessionID string, withSecondTurn bool) {
	t.Helper()
	at := func(min int) string { return time.Now().Add(-time.Duration(min) * time.Minute).Format(time.RFC3339) }
	sessionFixtureLine(t, root, sessionID, `{"type":"last-prompt","sessionId":"`+sessionID+`"}`)
	sessionFixtureLine(t, root, sessionID, `{"type":"user","isSidechain":false,"message":{"role":"user","content":"排查心跳 PASSWORD=hunter2"},"timestamp":"`+at(6)+`","cwd":"D:\\e2e-session-fixture"}`)
	assistant := map[string]any{
		"type": "assistant",
		"message": map[string]any{"role": "assistant", "content": []map[string]any{
			{"type": "thinking", "thinking": "先确认端口 sca_abcdef123456"},
			{"type": "text", "text": "好的，开始排查"},
			{"type": "tool_use", "id": "toolu_s1", "name": "Bash", "input": map[string]any{"command": "grep -rn heartbeat server/"}},
		}},
		"timestamp": at(5),
	}
	b, _ := json.Marshal(assistant)
	sessionFixtureLine(t, root, sessionID, string(b))
	sessionFixtureLine(t, root, sessionID, `{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_s1","content":"server/ws/heartbeat.go:12 interval=30s","is_error":false}]},"timestamp":"`+at(4)+`"}`)
	if withSecondTurn {
		sessionFixtureLine(t, root, sessionID, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"SECOND_TURN_MARKER 心跳间隔正常"}]},"timestamp":"`+at(2)+`"}`)
	}
}

func newSessionRouter() *gin.Engine {
	r := gin.New()
	r.POST("/api/share/session", CreateSessionShare)
	r.GET("/api/share", ListShares)
	r.DELETE("/api/share/:token", DeleteShare)
	r.POST("/api/share/:token/rotate", RotateShare)
	return r
}

func postSession(r *gin.Engine, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/share/session", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

type sessionResp struct {
	Data *struct {
		Token     string    `json:"token"`
		Kind      string    `json:"kind"`
		SessionID string    `json:"sessionId"`
		Name      string    `json:"name"`
		Size      int64     `json:"size"`
		CreatedAt time.Time `json:"createdAt"`
		ExpiresAt time.Time `json:"expiresAt"`
	} `json:"data"`
}

func decodeSessionResp(t *testing.T, w *httptest.ResponseRecorder) sessionResp {
	t.Helper()
	var out sessionResp
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response (%d): %v body=%s", w.Code, err, w.Body.String())
	}
	return out
}

// TestCreateSessionValidation 创建校验：缺 sessionId 400、未知会话 404、
// 无可回放条目 400、viewOnce 400、负 TTL 400
func TestCreateSessionValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := sessionEnv(t)
	r := newSessionRouter()

	if code := postSession(r, `{}`).Code; code != http.StatusBadRequest {
		t.Fatalf("missing sessionId status = %d, want 400", code)
	}
	if code := postSession(r, `{"sessionId":"no-such"}`).Code; code != http.StatusNotFound {
		t.Fatalf("unknown session status = %d, want 404", code)
	}
	// 只有 header 行：无可回放条目
	sessionFixtureLine(t, root, "empty-sess", `{"type":"last-prompt","sessionId":"empty-sess"}`)
	if code := postSession(r, `{"sessionId":"empty-sess"}`).Code; code != http.StatusBadRequest {
		t.Fatalf("empty session status = %d, want 400", code)
	}
	seedSessionFixture(t, root, sessionFixtureID, false)
	if code := postSession(r, `{"sessionId":"`+sessionFixtureID+`","viewOnce":true}`).Code; code != http.StatusBadRequest {
		t.Fatalf("viewOnce status = %d, want 400", code)
	}
	if code := postSession(r, `{"sessionId":"`+sessionFixtureID+`","ttlMinutes":-1}`).Code; code != http.StatusBadRequest {
		t.Fatalf("negative ttl status = %d, want 400", code)
	}
}

// TestCreateSessionLifecycle 创建 → 快照落盘/净本（thinking/tool 在列、
// hunter2 已遮蔽）→ 默认 24h → 列表投影 → 幂等同链不续期且重分享跟进新增
// 回合 → rotate 快照不迁 → 撤销即删快照
func TestCreateSessionLifecycle(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := sessionEnv(t)
	r := newSessionRouter()
	seedSessionFixture(t, root, sessionFixtureID, false)

	w := postSession(r, `{"sessionId":"`+sessionFixtureID+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", w.Code, w.Body.String())
	}
	first := decodeSessionResp(t, w)
	if first.Data == nil || first.Data.Kind != string(store.ShareKindSession) {
		t.Fatalf("create response = %+v", first)
	}
	if first.Data.SessionID != sessionFixtureID || first.Data.Size <= 0 {
		t.Fatalf("anchors/size = %+v", first.Data)
	}
	if remain := time.Until(first.Data.ExpiresAt); remain < 23*time.Hour+59*time.Minute || remain > 24*time.Hour+time.Minute {
		t.Fatalf("default ttl = %v, want ~24h", remain)
	}
	native := store.SessionNativeToken(config.MasterKey(), sessionFixtureID)
	if !share.HasSessionSnapshot(native) {
		t.Fatal("session snapshot must be on disk after create")
	}
	snap, err := os.ReadFile(filepath.Join(share.SnapshotsRoot(), native, "session.json"))
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	snapText := string(snap)
	for _, want := range []string{`"kind":"thinking"`, `"kind":"tool"`, "先确认端口", "grep -rn heartbeat"} {
		if !strings.Contains(snapText, want) {
			t.Fatalf("snapshot missing %q: %s", want, snapText)
		}
	}
	if strings.Contains(snapText, "hunter2") || strings.Contains(snapText, "sca_abcdef") {
		t.Fatalf("snapshot leaks P-108 secret: %s", snapText)
	}
	if !strings.Contains(snapText, "PASSWORD=***") {
		t.Fatalf("snapshot must be masked: %s", snapText)
	}

	// 列表：kind/sessionId 投影
	lw := httptest.NewRecorder()
	r.ServeHTTP(lw, httptest.NewRequest(http.MethodGet, "/api/share", nil))
	if !strings.Contains(lw.Body.String(), `"kind":"session"`) ||
		!strings.Contains(lw.Body.String(), `"sessionId":"`+sessionFixtureID+`"`) {
		t.Fatalf("list projection missing session fields: %s", lw.Body.String())
	}

	// 幂等：同会话重复分享同链、TTL 不续期；会话增长后重分享刷新快照
	again := decodeSessionResp(t, postSession(r, `{"sessionId":"`+sessionFixtureID+`"}`))
	if again.Data == nil || again.Data.Token != first.Data.Token {
		t.Fatalf("idempotent create token = %+v, want %s", again.Data, first.Data.Token)
	}
	if !again.Data.ExpiresAt.Equal(first.Data.ExpiresAt) {
		t.Fatalf("idempotent create must not extend ttl: %v vs %v", again.Data.ExpiresAt, first.Data.ExpiresAt)
	}
	seedSessionFixture(t, root, sessionFixtureID, true)
	_ = postSession(r, `{"sessionId":"`+sessionFixtureID+`"}`)
	snap2, _ := os.ReadFile(filepath.Join(share.SnapshotsRoot(), native, "session.json"))
	if !strings.Contains(string(snap2), "SECOND_TURN_MARKER") {
		t.Fatalf("re-share must refresh snapshot content: %s", snap2)
	}

	// rotate：旧链失效、新链可用；快照目录锚零代际值不动
	rotW := httptest.NewRecorder()
	r.ServeHTTP(rotW, httptest.NewRequest(http.MethodPost, "/api/share/"+first.Data.Token+"/rotate", nil))
	if rotW.Code != http.StatusOK {
		t.Fatalf("rotate status = %d body=%s", rotW.Code, rotW.Body.String())
	}
	rot := decodeSessionResp(t, rotW)
	if rot.Data == nil || rot.Data.Token == first.Data.Token {
		t.Fatalf("rotate response = %+v", rot.Data)
	}
	if !share.HasSessionSnapshot(native) {
		t.Fatal("rotate must not move the session snapshot (native token anchor)")
	}

	// 撤销：记录 + 快照一并清
	delW := httptest.NewRecorder()
	r.ServeHTTP(delW, httptest.NewRequest(http.MethodDelete, "/api/share/"+rot.Data.Token, nil))
	if delW.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", delW.Code, delW.Body.String())
	}
	if _, err := store.Get().Share.Get(rot.Data.Token); err == nil {
		t.Fatal("record must be gone after revoke")
	}
	if share.HasSessionSnapshot(native) {
		t.Fatal("session snapshot must be deleted with the share revoke")
	}
}

// TestSessionSnapshotGcKeepSet 快照目录派生 + 孤儿对账 keep 集：记录存活则
// 快照存活（漏扩 keep 即被巡检清成 target_gone）；记录消亡后同轮扫走
func TestSessionSnapshotGcKeepSet(t *testing.T) {
	sessionEnv(t)
	st := store.Get()
	native := store.SessionNativeToken(config.MasterKey(), "sess-gc")
	if err := share.WriteSessionSnapshot(native, []byte(`{"title":"t","entries":[]}`)); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	sh, err := st.Share.Create(store.Share{Kind: store.ShareKindSession, SessionID: "sess-gc"})
	if err != nil {
		t.Fatalf("create share: %v", err)
	}
	if got := snapshotDirName(sh); got != native {
		t.Fatalf("snapshotDirName = %s, want %s", got, native)
	}
	if _, err := (snapshotResolver{}).DirOf(sh); err != nil {
		t.Fatalf("DirOf: %v", err)
	}
	gcFrozenOrphans(st, slog.Default())
	if !share.HasSessionSnapshot(native) {
		t.Fatal("gc must keep session snapshot of an alive record (missing keep-set branch)")
	}
	if err := st.Share.Delete(sh.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	gcFrozenOrphans(st, slog.Default())
	if share.HasSessionSnapshot(native) {
		t.Fatal("gc must sweep session snapshot with no alive record")
	}
}
