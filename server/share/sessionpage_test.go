package share

// 会话回放只读分享访客面（P-20261003-77）单测：页面形态（/session 取数、
// 无 SSE）/ 条目 JSON 直出（thinking/tool 可见）/ P-108 遮蔽在快照本体 /
// meta 投影 / 非法子资源拒绝 / 快照丢失 target_gone / 过期 410。
// 管理面创建链在 api/share 单测，全链 e2e。

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/store"
)

func sessionEnvForTest(t *testing.T) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
}

// sessionServer 访客面测试服：session 记录 + 快照由真实落盘原语产出；
// DirOf 以目录存在性等价替代（派生正确性由 api/share 单测锁定）
func sessionServer(t *testing.T, snapshot []byte) (*httptest.Server, *Service, string, string) {
	t.Helper()
	sessionEnvForTest(t)
	native := fixedToken("sessionnat")
	if err := WriteSessionSnapshot(native, snapshot); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	token := fixedToken("sessiontok")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindSession, Name: "排查心跳",
		SessionID: "sess-e2e", Size: int64(len(snapshot)),
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": t.TempDir()}}, nil)
	svc = svc.WithSnapshotDirs(dirResolverFunc(func(sh *store.Share) (string, error) {
		return filepath.Join(SnapshotsRoot(), native), nil
	}))
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, svc, token, native
}

func sessionFixture(t *testing.T) []byte {
	t.Helper()
	snap := BuildSessionSnapshot(claudesessions.ShareSnapshotResult{
		Title: "排查心跳",
		Entries: []claudesessions.TimelineEntry{
			{Kind: "user", At: "2026-10-19T10:00:00Z", Text: "帮我看看 PASSWORD=hunter2"},
			{Kind: "thinking", At: "2026-10-19T10:00:01Z", Text: "先确认端口再定位心跳间隔"},
			{Kind: "tool", At: "2026-10-19T10:00:02Z", Tool: "Bash", Input: "grep -rn heartbeat server/"},
			{Kind: "result", At: "2026-10-19T10:00:03Z", Text: "server/ws/heartbeat.go:12 interval=30s", Status: "ok"},
			{Kind: "assistant", At: "2026-10-19T10:00:04Z", Text: "心跳间隔 30s 正常"},
		},
	})
	data, err := MarshalSessionSnapshot(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return data
}

func TestSessionVisitorSurface(t *testing.T) {
	content := sessionFixture(t)
	srv, svc, token, _ := sessionServer(t, content)

	// 页面：零外部依赖 + /session 取数 + 无 SSE/轮询
	resp := get(t, srv.URL+"/s/"+token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("page status = %d", resp.StatusCode)
	}
	pageBytes, _ := io.ReadAll(resp.Body)
	page := string(pageBytes)
	for _, want := range []string{"/session", "Session Replay", "Thinking", "Tool"} {
		if !strings.Contains(page, want) {
			t.Fatalf("session page missing %q", want)
		}
	}
	if strings.Contains(page, "EventSource") || strings.Contains(page, "/stream") {
		t.Fatal("session page must have no SSE wiring")
	}

	// /session：净本 JSON 直出（访客页解析）；thinking/tool/result 全形态在列
	sessRes := get(t, srv.URL+"/s/"+token+"/session")
	defer sessRes.Body.Close()
	if sessRes.StatusCode != http.StatusOK {
		t.Fatalf("session status = %d", sessRes.StatusCode)
	}
	if ct := sessRes.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("session content-type = %q, want application/json", ct)
	}
	raw, _ := io.ReadAll(sessRes.Body)
	if string(raw) != string(content) {
		t.Fatalf("session content drifted: %q", raw)
	}
	var snap SessionSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	kinds := map[string]bool{}
	for _, e := range snap.Entries {
		kinds[e.Kind] = true
	}
	for _, want := range []string{"user", "assistant", "thinking", "tool", "result"} {
		if !kinds[want] {
			t.Fatalf("snapshot missing kind %q: %+v", want, snap.Entries)
		}
	}

	// P-108 遮蔽：命中值不进快照（标题/正文/工具输入同口径）
	if strings.Contains(string(raw), "hunter2") {
		t.Fatalf("snapshot leaks P-108 secret: %s", raw)
	}
	if !strings.Contains(string(raw), "PASSWORD=***") {
		t.Fatalf("snapshot must be masked: %s", raw)
	}

	// meta：kind=session 投影（内容走 /session）
	meta := get(t, srv.URL+"/s/"+token+"/meta")
	defer meta.Body.Close()
	metaBody, _ := io.ReadAll(meta.Body)
	if !strings.Contains(string(metaBody), `"kind":"session"`) ||
		!strings.Contains(string(metaBody), `"name":"排查心跳"`) {
		t.Fatalf("meta projection = %s", metaBody)
	}

	// 非法子资源：raw/list/stream/render/download 都是「形态不适用」而非
	// nil root 崩溃
	for _, path := range []string{"/raw", "/list", "/stream", "/render", "/download"} {
		res, err := http.Get(srv.URL + "/s/" + token + path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", path, res.StatusCode)
		}
	}

	// 页面打开计一次访问
	svc.hits.mu.Lock()
	pending := svc.hits.pending[token]
	svc.hits.mu.Unlock()
	if pending != 1 {
		t.Fatalf("hits pending = %d, want 1 (page open counts once)", pending)
	}
}

// TestSessionSnapshotMissingTargetGone 记录在而快照丢失：/session 410
func TestSessionSnapshotMissingTargetGone(t *testing.T) {
	sessionEnvForTest(t)
	token := fixedToken("sessiongone")
	shares := fakeShares{token: {Token: token, Kind: store.ShareKindSession, Name: "t", SessionID: "sess-x"}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil)
	svc = svc.WithSnapshotDirs(dirResolverFunc(func(sh *store.Share) (string, error) {
		return "", os.ErrNotExist
	}))
	ts := httptest.NewServer(svc.Handler())
	t.Cleanup(ts.Close)
	res, err := http.Get(ts.URL + "/s/" + token + "/session")
	if err != nil {
		t.Fatalf("session: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusGone {
		t.Fatalf("session status = %d, want 410 target_gone", res.StatusCode)
	}
}

// TestSessionVisitorExpired 过期记录：页面 410 专页
func TestSessionVisitorExpired(t *testing.T) {
	sessionEnvForTest(t)
	token := fixedToken("sessionexp")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindSession, Name: "t", SessionID: "sess-x",
		ExpiresAt: time.Now().Add(-time.Minute),
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil)
	ts := httptest.NewServer(svc.Handler())
	t.Cleanup(ts.Close)
	res, err := http.Get(ts.URL + "/s/" + token)
	if err != nil {
		t.Fatalf("page: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusGone {
		t.Fatalf("expired page status = %d, want 410", res.StatusCode)
	}
}

// TestBuildSessionSnapshotMasksAllFields 遮蔽面覆盖标题/正文/工具输入，
// 自定义与内置模式同源（P-108）
func TestBuildSessionSnapshotMasksAllFields(t *testing.T) {
	snap := BuildSessionSnapshot(claudesessions.ShareSnapshotResult{
		Title: "token=title-secret",
		Entries: []claudesessions.TimelineEntry{
			{Kind: "user", Text: "export PASSWORD=hunter2"},
			{Kind: "thinking", Text: "sca_abcdef123456 在命令里"},
			{Kind: "tool", Tool: "Bash", Input: "curl -H 'Authorization: password=abc123'"},
		},
	})
	if strings.Contains(snap.Title, "title-secret") {
		t.Fatalf("title not masked: %q", snap.Title)
	}
	for _, e := range snap.Entries {
		if strings.Contains(e.Text+e.Input, "hunter2") || strings.Contains(e.Text+e.Input, "sca_abcdef") ||
			strings.Contains(e.Text+e.Input, "abc123") {
			t.Fatalf("entry leaks secret: %+v", e)
		}
	}
	if !strings.Contains(snap.Entries[0].Text, "PASSWORD=***") {
		t.Fatalf("assignment not masked: %q", snap.Entries[0].Text)
	}
}
