package shareapi

// 会话回放分享（P-20261004-103）管理面单测：创建校验/敏感扫描警示流/
// 快照落盘与净本/幂等同链/rotate/撤销/孤儿对账 keep 集。happy path 的
// 访客回放页在 server/share 单测与定向 e2e 覆盖。

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
	"codecombo/server/recording"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// castEnv 数据目录隔离 + 默认 store 装配（录制/分享同库）
func castEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// seedRecording 录制索引 + cast 文件（内容由调用方给）
func seedRecording(t *testing.T, id, castText string) {
	t.Helper()
	if err := store.Get().Recording.Save(store.Recording{
		ID: id, SessionID: "sess-cast", Op: "reset --hard", Status: store.RecordingStatusCompleted,
		StartedAt: time.Now(),
	}); err != nil {
		t.Fatalf("save recording: %v", err)
	}
	if err := os.MkdirAll(recording.ArtifactsDir(), 0o700); err != nil {
		t.Fatalf("mkdir artifacts: %v", err)
	}
	if err := os.WriteFile(recording.CastPath(id), []byte(castText), 0o600); err != nil {
		t.Fatalf("write cast: %v", err)
	}
}

// castFixture 标准 cast 文本：header + 两帧事件（含 OSC133 章节链）
func castFixture() string {
	e := func(t float64, text string) string {
		b, _ := json.Marshal([]any{t, "o", text})
		return string(b) + "\n"
	}
	header := `{"version":2,"width":100,"height":30,"timestamp":1700000000,"env":{"TERM":"xterm-256color"}}` + "\n"
	return header +
		e(0.1, "CAST_HELLO\r\n") +
		e(0.5, "\x1b]133;E;ZWNobyBDQVNUX0hFTExP\x07\x1b]133;C\x07CAST_HELLO\r\n\x1b]133;D;0\x07")
}

func newCastRouter() *gin.Engine {
	r := gin.New()
	r.POST("/api/share/cast", CreateCast)
	r.GET("/api/share", ListShares)
	r.DELETE("/api/share/:token", DeleteShare)
	r.POST("/api/share/:token/rotate", RotateShare)
	return r
}

func postCast(r *gin.Engine, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/share/cast", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

// TestCreateCastValidation 创建校验：缺 recordingId 400、未知录制 404、
// cast 文件缺失 404、header-only 空录制 400、viewOnce 400
func TestCreateCastValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	castEnv(t)
	r := newCastRouter()

	if code := postCast(r, `{}`).Code; code != http.StatusBadRequest {
		t.Fatalf("missing recordingId status = %d, want 400", code)
	}
	if code := postCast(r, `{"recordingId":"no-such"}`).Code; code != http.StatusNotFound {
		t.Fatalf("unknown recording status = %d, want 404", code)
	}
	// 索引在而 cast 文件缺失
	if err := store.Get().Recording.Save(store.Recording{ID: "sc_rec_nofile", Status: store.RecordingStatusCompleted}); err != nil {
		t.Fatalf("seed meta: %v", err)
	}
	if code := postCast(r, `{"recordingId":"sc_rec_nofile"}`).Code; code != http.StatusNotFound {
		t.Fatalf("missing cast file status = %d, want 404", code)
	}
	// header-only：空录制无分享价值
	seedRecording(t, "sc_rec_empty", `{"version":2,"width":80,"height":24}`+"\n")
	if code := postCast(r, `{"recordingId":"sc_rec_empty"}`).Code; code != http.StatusBadRequest {
		t.Fatalf("empty recording status = %d, want 400", code)
	}
	// 一次性与回放相斥
	seedRecording(t, "sc_rec_vo", castFixture())
	if code := postCast(r, `{"recordingId":"sc_rec_vo","viewOnce":true}`).Code; code != http.StatusBadRequest {
		t.Fatalf("viewOnce status = %d, want 400", code)
	}
	// 非法 ttl
	if code := postCast(r, `{"recordingId":"sc_rec_vo","ttlMinutes":-1}`).Code; code != http.StatusBadRequest {
		t.Fatalf("negative ttl status = %d, want 400", code)
	}
}

type castResp struct {
	Data *struct {
		Token       string    `json:"token"`
		Kind        string    `json:"kind"`
		RecordingID string    `json:"recordingId"`
		TerminalID  string    `json:"terminalId"`
		Name        string    `json:"name"`
		Size        int64     `json:"size"`
		CreatedAt   time.Time `json:"createdAt"`
		ExpiresAt   time.Time `json:"expiresAt"`
	} `json:"data"`
	Warnings      []string `json:"warnings"`
	ScanTruncated bool     `json:"scanTruncated"`
}

func decodeCastResp(t *testing.T, w *httptest.ResponseRecorder) castResp {
	t.Helper()
	var out castResp
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response (%d): %v body=%s", w.Code, err, w.Body.String())
	}
	return out
}

// TestCreateCastLifecycle 创建 → 快照落盘/净本 → 幂等同链不续期 → rotate →
// 撤销即删快照；列表响应带 recordingId/kind
func TestCreateCastLifecycle(t *testing.T) {
	gin.SetMode(gin.TestMode)
	castEnv(t)
	r := newCastRouter()
	seedRecording(t, "sc_rec_life", castFixture())

	w := postCast(r, `{"recordingId":"sc_rec_life"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", w.Code, w.Body.String())
	}
	first := decodeCastResp(t, w)
	if first.Data == nil || first.Data.Kind != string(store.ShareKindCast) {
		t.Fatalf("create response = %+v", first)
	}
	if first.Data.RecordingID != "sc_rec_life" || first.Data.TerminalID != "sess-cast" {
		t.Fatalf("anchors = %+v", first.Data)
	}
	if remain := time.Until(first.Data.ExpiresAt); remain < 59*time.Minute || remain > 61*time.Minute {
		t.Fatalf("default ttl = %v, want ~1h", remain)
	}
	native := store.CastNativeToken(config.MasterKey(), "sc_rec_life")
	if !share.HasCastSnapshot(native) {
		t.Fatal("cast snapshot must be on disk after create")
	}
	snap, err := os.ReadFile(filepath.Join(share.SnapshotsRoot(), native, "replay.cast"))
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if !strings.Contains(string(snap), "CAST_HELLO") {
		t.Fatalf("snapshot missing event text: %q", snap)
	}
	if first.Warnings == nil || len(first.Warnings) != 0 {
		t.Fatalf("clean cast should have empty warnings, got %v", first.Warnings)
	}

	// 列表：kind/recordingId 投影
	lw := httptest.NewRecorder()
	r.ServeHTTP(lw, httptest.NewRequest(http.MethodGet, "/api/share", nil))
	if !strings.Contains(lw.Body.String(), `"kind":"cast"`) ||
		!strings.Contains(lw.Body.String(), `"recordingId":"sc_rec_life"`) {
		t.Fatalf("list projection missing cast fields: %s", lw.Body.String())
	}

	// 幂等：同录制重复分享同链、TTL 不续期；录制增长后重分享刷新快照
	again := decodeCastResp(t, postCast(r, `{"recordingId":"sc_rec_life"}`))
	if again.Data == nil || again.Data.Token != first.Data.Token {
		t.Fatalf("idempotent create token = %+v, want %s", again.Data, first.Data.Token)
	}
	if !again.Data.ExpiresAt.Equal(first.Data.ExpiresAt) {
		t.Fatalf("idempotent create must not extend ttl: %v vs %v", again.Data.ExpiresAt, first.Data.ExpiresAt)
	}
	// 录制内容增长（模拟录制继续写）→ 重分享重写快照
	f, err := os.OpenFile(recording.CastPath("sc_rec_life"), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("append cast: %v", err)
	}
	_, _ = f.WriteString(`[0.9,"o","CAST_LATE\r\n"]` + "\n")
	_ = f.Close()
	_ = postCast(r, `{"recordingId":"sc_rec_life"}`)
	snap2, _ := os.ReadFile(filepath.Join(share.SnapshotsRoot(), native, "replay.cast"))
	if !strings.Contains(string(snap2), "CAST_LATE") {
		t.Fatalf("re-share must refresh snapshot content: %q", snap2)
	}

	// rotate：旧链失效、新链可用；快照目录锚零代际值不动
	rotW := httptest.NewRecorder()
	r.ServeHTTP(rotW, httptest.NewRequest(http.MethodPost, "/api/share/"+first.Data.Token+"/rotate", nil))
	if rotW.Code != http.StatusOK {
		t.Fatalf("rotate status = %d body=%s", rotW.Code, rotW.Body.String())
	}
	rot := decodeCastResp(t, rotW)
	if rot.Data == nil || rot.Data.Token == first.Data.Token {
		t.Fatalf("rotate response = %+v", rot.Data)
	}
	if !share.HasCastSnapshot(native) {
		t.Fatal("rotate must not move the cast snapshot (native token anchor)")
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
	if share.HasCastSnapshot(native) {
		t.Fatal("cast snapshot must be deleted with the share revoke")
	}
}

// TestCreateCastSensitiveWarning 敏感扫描警示流（P-97 同语义）：命中未确认
// 不落快照不建记录；override 后创建，快照本体为净本（命中值已 ***）
func TestCreateCastSensitiveWarning(t *testing.T) {
	gin.SetMode(gin.TestMode)
	castEnv(t)
	r := newCastRouter()
	e, _ := json.Marshal([]any{0.1, "o", "export PASSWORD=hunter2\r\n"})
	seedRecording(t, "sc_rec_scanhit", `{"version":2,"width":80,"height":24}`+"\n"+string(e)+"\n")

	blockedW := postCast(r, `{"recordingId":"sc_rec_scanhit"}`)
	if blockedW.Code != http.StatusOK {
		t.Fatalf("blocked status = %d", blockedW.Code)
	}
	blocked := decodeCastResp(t, blockedW)
	if blocked.Data != nil {
		t.Fatalf("unconfirmed sensitive cast must not create: %+v", blocked.Data)
	}
	if len(blocked.Warnings) != 1 || !strings.HasPrefix(blocked.Warnings[0], "line 2") {
		t.Fatalf("warnings = %v, want line 2", blocked.Warnings)
	}
	native := store.CastNativeToken(config.MasterKey(), "sc_rec_scanhit")
	if share.HasCastSnapshot(native) {
		t.Fatal("unconfirmed sensitive cast must not leave a snapshot")
	}
	if list, _ := store.Get().Share.List(); len(list) != 0 {
		t.Fatalf("unconfirmed sensitive cast must not create a record: %+v", list)
	}

	allowed := decodeCastResp(t, postCast(r, `{"recordingId":"sc_rec_scanhit","override":true}`))
	if allowed.Data == nil || allowed.Data.Kind != string(store.ShareKindCast) {
		t.Fatalf("override create = %+v", allowed)
	}
	snap, err := os.ReadFile(filepath.Join(share.SnapshotsRoot(), native, "replay.cast"))
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if strings.Contains(string(snap), "hunter2") {
		t.Fatalf("snapshot leaks sensitive value: %q", snap)
	}
	if !strings.Contains(string(snap), "PASSWORD=***") {
		t.Fatalf("snapshot must be sanitized (PASSWORD=***): %q", snap)
	}
}

// TestCastSnapshotGcKeepSet 快照目录派生 + 孤儿对账 keep 集：记录存活则快照
// 存活（漏扩 keep 即被巡检清成 target_gone）；记录消亡后同轮扫走
func TestCastSnapshotGcKeepSet(t *testing.T) {
	castEnv(t)
	st := store.Get()
	native := store.CastNativeToken(config.MasterKey(), "sc_rec_gc")
	if err := share.WriteCastSnapshot(native, []byte(`{"version":2,"width":80,"height":24}`+"\n")); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	sh, err := st.Share.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "sc_rec_gc"})
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
	if !share.HasCastSnapshot(native) {
		t.Fatal("gc must keep cast snapshot of an alive record (missing keep-set branch)")
	}
	if err := st.Share.Delete(sh.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	gcFrozenOrphans(st, slog.Default())
	if share.HasCastSnapshot(native) {
		t.Fatal("gc must sweep cast snapshot with no alive record")
	}
}

// TestCastSnapshotDirSurvivesRotate rotate 后 DirOf 仍指同一目录（快照不迁）
func TestCastSnapshotDirSurvivesRotate(t *testing.T) {
	castEnv(t)
	st := store.Get()
	native := store.CastNativeToken(config.MasterKey(), "sc_rec_rot")
	if err := share.WriteCastSnapshot(native, []byte(`{"version":2}`+"\n")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	sh, err := st.Share.Create(store.Share{Kind: store.ShareKindCast, RecordingID: "sc_rec_rot"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	rot, err := st.Share.Rotate(sh.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	dir, err := (snapshotResolver{}).DirOf(rot)
	if err != nil {
		t.Fatalf("DirOf after rotate: %v", err)
	}
	if want := filepath.Join(share.SnapshotsRoot(), native); dir != want {
		t.Fatalf("DirOf after rotate = %s, want %s", dir, want)
	}
}
