package share

// 终端输出时点冻结分享（P-20261005-205）的单测：快照落盘原语（写/幂等重写/
// 探针/删除）与访客面（定格页形态、raw 单文件语义、meta、无流语义、副本
// 丢失降级）。创建链的净化纪律（剥 ANSI → 遮蔽 → 哈希）在 server/api/share
// 的 sanitizeTermFrozenOutput 单测锁定；happy path 全链路走定向 e2e。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/store"
)

// snapEnv 同 snapshot_test：数据目录隔离进临时目录
func termFrozenEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
}

func TestWriteTermFrozenSnapshot(t *testing.T) {
	termFrozenEnv(t)
	native := fixedToken("nat")

	if HasTermFrozenSnapshot(native) {
		t.Fatal("snapshot must not exist before write")
	}
	if err := WriteTermFrozenSnapshot(native, []byte("line-1\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !HasTermFrozenSnapshot(native) {
		t.Fatal("snapshot must exist after write")
	}
	got, err := os.ReadFile(filepath.Join(SnapshotsRoot(), native, termFrozenFileName))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "line-1\n" {
		t.Fatalf("content = %q", got)
	}

	// 同 token 重写 = 幂等覆盖（同哈希同内容的直推；兼修复通道）
	if err := WriteTermFrozenSnapshot(native, []byte("line-1\nline-2\n")); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	got, _ = os.ReadFile(filepath.Join(SnapshotsRoot(), native, termFrozenFileName))
	if string(got) != "line-1\nline-2\n" {
		t.Fatalf("content after rewrite = %q", got)
	}
	// 重写不产生临时件残壳
	entries, _ := os.ReadDir(filepath.Join(SnapshotsRoot(), native))
	if len(entries) != 1 {
		t.Fatalf("snapshot dir entries = %d, want exactly 1 (no temp leftovers)", len(entries))
	}

	if err := DeleteFrozenSnapshot(native); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if HasTermFrozenSnapshot(native) {
		t.Fatal("snapshot must be gone after delete")
	}
}

// termFrozenServer 访客面测试服：term-frozen 记录 + 快照目录由真实落盘原语
// 产出（SnapshotDirs 注入真实解析——DirOf 的派生逻辑属装配层，本包测试以
// 目录存在性探针等价替代，派生正确性由 api/share 的 module_test 锁定）
func termFrozenServer(t *testing.T, content string) (*httptest.Server, *Service, string) {
	t.Helper()
	termFrozenEnv(t)
	native := fixedToken("nat")
	if err := WriteTermFrozenSnapshot(native, []byte(content)); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	token := fixedToken("tf")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTermFrozen, Name: "build 终端",
		TerminalID: "term-a", Size: int64(len(content)),
	}}
	// fake DirOf：按派生锚直接指向快照目录（记录字段 → 目录名的装配层映射
	// 在 module_test 断言；这里测访客面对该目录的服务形态）
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": t.TempDir()}}, nil)
	svc = svc.WithSnapshotDirs(dirResolverFunc(func(sh *store.Share) (string, error) {
		return filepath.Join(SnapshotsRoot(), native), nil
	}))
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, svc, token
}

// dirResolverFunc SnapshotDirs 的函数适配器（测试注入）
type dirResolverFunc func(sh *store.Share) (string, error)

func (f dirResolverFunc) DirOf(sh *store.Share) (string, error) { return f(sh) }

func TestTermFrozenVisitorSurface(t *testing.T) {
	content := "$ go test ./...\nok  \npanic: boom\n"
	srv, svc, token := termFrozenServer(t, content)

	// 页面：定格访客页形态——xterm 三件 + /raw 取数，无 SSE 接线
	resp := get(t, srv.URL+"/s/"+token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("page status = %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	page := string(body)
	// 语言中立标记（Accept-Language 缺省 en）：xterm 三件 + /raw 定格取数 +
	// Snapshot 徽标形态；遮蔽声明横幅随语言包注入（zh 语料由页渲染测试覆盖）
	for _, want := range []string{"/assets/xterm.js", "/assets/addon-fit.js", "/raw", "Snapshot"} {
		if !strings.Contains(page, want) {
			t.Fatalf("frozen page missing %q", want)
		}
	}
	if strings.Contains(page, "EventSource") || strings.Contains(page, "/stream") {
		t.Fatal("frozen page must have no SSE wiring")
	}

	// raw：单文件语义免 path 参数，text/plain 直出净本
	raw, err := http.Get(srv.URL + "/s/" + token + "/raw")
	if err != nil {
		t.Fatalf("raw: %v", err)
	}
	defer raw.Body.Close()
	if raw.StatusCode != http.StatusOK {
		t.Fatalf("raw status = %d", raw.StatusCode)
	}
	if ct := raw.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("raw content-type = %q, want text/plain", ct)
	}
	rawBody, _ := io.ReadAll(raw.Body)
	if string(rawBody) != content {
		t.Fatalf("raw content = %q, want %q", rawBody, content)
	}

	// meta：条目即快照单文件（展示名回落记录 Name，vrel 空 = 文件分享语义）
	meta, err := http.Get(srv.URL + "/s/" + token + "/meta")
	if err != nil {
		t.Fatalf("meta: %v", err)
	}
	defer meta.Body.Close()
	metaBody, _ := io.ReadAll(meta.Body)
	if !strings.Contains(string(metaBody), `"name":"build 终端"`) {
		t.Fatalf("meta missing share name: %s", metaBody)
	}

	// 直播流语义不适用于定格形态（记录不可直播，不是路由缺失）
	if res, err := http.Get(srv.URL + "/s/" + token + "/stream"); err != nil {
		t.Fatalf("stream: %v", err)
	} else {
		res.Body.Close()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("stream status = %d, want 400", res.StatusCode)
		}
	}

	// 页面打开计一次访问（hits 同链；Service 聚合器同包直读 pending 验证）
	svc.hits.mu.Lock()
	pending := svc.hits.pending[token]
	svc.hits.mu.Unlock()
	if pending != 1 {
		t.Fatalf("hits pending = %d, want 1 (page open counts once)", pending)
	}
}

func TestTermFrozenSnapshotMissingTargetGone(t *testing.T) {
	termFrozenEnv(t)
	token := fixedToken("gone")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTermFrozen, Name: "t",
		TerminalID: "term-x", ContentHash: "deadbeef",
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": t.TempDir()}}, nil)
	svc = svc.WithSnapshotDirs(dirResolverFunc(func(sh *store.Share) (string, error) {
		// 记录在而副本丢失：DirOf 报错（装配层语义）→ 访客面 target_gone
		return "", os.ErrNotExist
	}))
	ts := httptest.NewServer(svc.Handler())
	t.Cleanup(ts.Close)

	for _, path := range []string{"/s/" + token + "/raw", "/s/" + token + "/meta"} {
		res, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusGone {
			t.Fatalf("%s status = %d, want 410 target_gone", path, res.StatusCode)
		}
	}
}
