package share

// 会话回放访客面（P-20261004-103）单测：回放页形态（xterm + /cast，无 SSE）/
// cast 单文件端点（text/plain + 附件下载）/ meta 投影/非法子资源拒绝/
// 快照丢失 target_gone/访问计数。管理面创建链在 api/share 单测，全链 e2e。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

func castEnvForTest(t *testing.T) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
}

// castServer 访客面测试服：cast 记录 + 快照由真实落盘原语产出；DirOf 以
// 目录存在性等价替代（派生正确性由 api/share module_test/handlers_cast_test
// 锁定——与 termFrozenServer 同款分工）
func castServer(t *testing.T, content string) (*httptest.Server, *Service, string, string) {
	t.Helper()
	castEnvForTest(t)
	native := fixedToken("castnat")
	if err := WriteCastSnapshot(native, []byte(content)); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	token := fixedToken("casttok")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindCast, Name: "reset --hard 回放",
		RecordingID: "sc_rec_e2e", TerminalID: "sess-1", Size: int64(len(content)),
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": t.TempDir()}}, nil)
	svc = svc.WithSnapshotDirs(dirResolverFunc(func(sh *store.Share) (string, error) {
		return filepath.Join(SnapshotsRoot(), native), nil
	}))
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, svc, token, native
}

func TestCastVisitorSurface(t *testing.T) {
	content := `{"version":2,"width":100,"height":30,"timestamp":1700000000}` + "\n" +
		`[0.1,"o","CAST_HELLO\r\n"]` + "\n" +
		`[0.4,"o","\u001b]133;E;ZWNobyBDQVNUX0hFTExP\u0007\u001b]133;C\u0007CAST_HELLO\r\n"]` + "\n"
	srv, svc, token, _ := castServer(t, content)

	// 回放页：xterm 三件 + /cast 取数 + 无 SSE/轮询接线；回放徽标语言中立
	resp := get(t, srv.URL+"/s/"+token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("page status = %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	page := string(body)
	for _, want := range []string{"/assets/xterm.js", "/assets/addon-fit.js", "/cast", "REPLAY", "Download cast"} {
		if !strings.Contains(page, want) {
			t.Fatalf("cast page missing %q", want)
		}
	}
	if strings.Contains(page, "EventSource") || strings.Contains(page, "/stream") {
		t.Fatal("cast page must have no SSE wiring")
	}

	// /cast：单文件文本直出（回放引擎取数）
	castRes := get(t, srv.URL+"/s/"+token+"/cast")
	defer castRes.Body.Close()
	if castRes.StatusCode != http.StatusOK {
		t.Fatalf("cast status = %d", castRes.StatusCode)
	}
	if ct := castRes.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("cast content-type = %q, want text/plain", ct)
	}
	raw, _ := io.ReadAll(castRes.Body)
	if string(raw) != content {
		t.Fatalf("cast content = %q, want %q", raw, content)
	}

	// ?dl=1：附件下载（导出 cast 交外部播放器）
	dl := get(t, srv.URL+"/s/"+token+"/cast?dl=1")
	defer dl.Body.Close()
	if cd := dl.Header.Get("Content-Disposition"); !strings.Contains(cd, "attachment") ||
		!strings.Contains(cd, "replay.cast") {
		t.Fatalf("download disposition = %q", cd)
	}

	// meta：kind=cast 投影（内容走 /cast）
	meta := get(t, srv.URL+"/s/"+token+"/meta")
	defer meta.Body.Close()
	metaBody, _ := io.ReadAll(meta.Body)
	if !strings.Contains(string(metaBody), `"kind":"cast"`) ||
		!strings.Contains(string(metaBody), `"name":"reset --hard 回放"`) {
		t.Fatalf("meta projection = %s", metaBody)
	}

	// 非法子资源：raw/list/stream 都是「形态不适用」而非 nil root 崩溃
	for _, path := range []string{"/raw", "/list", "/stream"} {
		res, err := http.Get(srv.URL + "/s/" + token + path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", path, res.StatusCode)
		}
	}
	// 下载族同样拒绝（cast 文本不走文件下载语义）
	if res := get(t, srv.URL+"/s/"+token+"/download"); res.StatusCode != http.StatusBadRequest {
		res.Body.Close()
		t.Fatalf("download status = %d, want 400", res.StatusCode)
	} else {
		res.Body.Close()
	}

	// 页面打开计一次访问
	svc.hits.mu.Lock()
	pending := svc.hits.pending[token]
	svc.hits.mu.Unlock()
	if pending != 1 {
		t.Fatalf("hits pending = %d, want 1 (page open counts once)", pending)
	}
}

// TestCastSnapshotMissingTargetGone 记录在而快照丢失：/cast 410 target_gone
// （服务端数据事故，不给「路径敲错」误导）
func TestCastSnapshotMissingTargetGone(t *testing.T) {
	castEnvForTest(t)
	token := fixedToken("castgone")
	shares := fakeShares{token: {Token: token, Kind: store.ShareKindCast, Name: "t", RecordingID: "sc_rec_x"}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil)
	svc = svc.WithSnapshotDirs(dirResolverFunc(func(sh *store.Share) (string, error) {
		return "", os.ErrNotExist
	}))
	ts := httptest.NewServer(svc.Handler())
	t.Cleanup(ts.Close)
	res, err := http.Get(ts.URL + "/s/" + token + "/cast")
	if err != nil {
		t.Fatalf("cast: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusGone {
		t.Fatalf("cast status = %d, want 410 target_gone", res.StatusCode)
	}
}

// TestCastVisitorExpired 过期记录：页面 410 专页（与既有快照形态同口径）
func TestCastVisitorExpired(t *testing.T) {
	castEnvForTest(t)
	token := fixedToken("castexp")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindCast, Name: "t", RecordingID: "sc_rec_x",
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
