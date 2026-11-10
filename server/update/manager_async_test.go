package update

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/notification"
)

// 更新进度可见性（P-20261109-10）流水线守护：异步受理（受理/拒绝同步交还、
// 受理后失败经状态机承载）、verifying 独立阶段、在途态不被检查覆写、受理即清
// 上一轮结果、生命周期通知服务端单一发射（开始先于失败入账）。

// fakeRoundTripper 不拨号的下载桩：任意请求回固定 200 body（Content-Length 如实）。
// downloadClient 是包级变量，替换后 download 的 https 公网 URL 校验照常执行
type fakeRoundTripper struct{ body []byte }

func (f fakeRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode:    http.StatusOK,
		Body:          io.NopCloser(bytes.NewReader(f.body)),
		ContentLength: int64(len(f.body)),
		Header:        http.Header{},
		Request:       r,
	}, nil
}

func useFakeDownload(t *testing.T, body []byte) {
	t.Helper()
	orig := downloadClient
	downloadClient = &http.Client{Transport: fakeRoundTripper{body: body}}
	t.Cleanup(func() { downloadClient = orig })
}

// captureNotifications 替换通知入账口，返回线程安全的已入账快照读取器
func captureNotifications(t *testing.T) func() []notification.Notification {
	t.Helper()
	var mu sync.Mutex
	var got []notification.Notification
	orig := publishNotification
	publishNotification = func(n notification.Notification) {
		mu.Lock()
		got = append(got, n)
		mu.Unlock()
	}
	t.Cleanup(func() { publishNotification = orig })
	return func() []notification.Notification {
		mu.Lock()
		defer mu.Unlock()
		return append([]notification.Notification(nil), got...)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func TestStatusInFlight(t *testing.T) {
	cases := map[Status]bool{
		StatusIdle: false, StatusChecking: false,
		StatusDownloading: true, StatusVerifying: true, StatusReplacing: true, StatusRestarting: true,
		StatusSuccess: false, StatusFailed: false, StatusRolledBack: false,
	}
	for s, want := range cases {
		if got := s.InFlight(); got != want {
			t.Errorf("%s.InFlight() = %v, want %v", s, got, want)
		}
	}
}

// 受理即返回 nil；后台下载完成后进入 verifying 阶段校验，校验失败落 failed+errMsg。
// 通知序：开始（受理点同步）先于失败；FileSize=0 时总量以 Content-Length 补齐
func TestStartUpdateAdmitsThenFailsInBackground(t *testing.T) {
	m := testManager(t)
	notes := captureNotifications(t)
	body := bytes.Repeat([]byte("x"), 4096)
	useFakeDownload(t, body)

	var seen Status
	var seenTotal int64
	orig := verifyUpdateFn
	verifyUpdateFn = func(string, *ReleaseInfo) error {
		st := m.GetStatus()
		seen, seenTotal = st.Status, st.Total
		return errors.New("checksum mismatch")
	}
	t.Cleanup(func() { verifyUpdateFn = orig })

	info := &ReleaseInfo{Version: "9.9.9", DownloadURL: "https://example.com/codecombo"}
	if err := m.StartUpdate(info, "0.0.1", 0); err != nil {
		t.Fatalf("StartUpdate should admit, got %v", err)
	}
	waitFor(t, "failed status", func() bool { return m.GetStatus().Status == StatusFailed })

	if seen != StatusVerifying {
		t.Fatalf("status during verify = %s, want verifying", seen)
	}
	if seenTotal != int64(len(body)) {
		t.Fatalf("total = %d, want Content-Length %d (FileSize=0 fallback)", seenTotal, len(body))
	}
	st := m.GetStatus()
	if !strings.HasPrefix(st.ErrMsg, "update verification failed") || st.Version != "9.9.9" {
		t.Fatalf("errMsg/version = %q/%q", st.ErrMsg, st.Version)
	}

	waitFor(t, "two notifications", func() bool { return len(notes()) == 2 })
	got := notes()
	if got[0].Type != "info" || got[0].TitleKey != notifyStartedTitleKey || got[0].Action != ActionUpdatePanel ||
		got[0].MsgParams["version"] != "9.9.9" {
		t.Fatalf("first notification should be started, got %+v", got[0])
	}
	if got[1].Type != "error" || got[1].TitleKey != notifyFailedTitleKey || !strings.Contains(got[1].Body, "checksum mismatch") ||
		got[1].Action != ActionUpdatePanel {
		t.Fatalf("second notification should be failed with reason, got %+v", got[1])
	}
}

// 在途闸门：受理前拒绝，错误可判型且文案不变；状态机与通知零副作用
func TestStartUpdateRejectsWhenInFlight(t *testing.T) {
	m := testManager(t)
	notes := captureNotifications(t)
	m.status = StatusRestarting

	err := m.StartUpdate(&ReleaseInfo{Version: "9.9.9"}, "0.0.1", 0)
	if !errors.Is(err, ErrUpdateInProgress) || err.Error() != "update already in progress: restarting" {
		t.Fatalf("err = %v, want ErrUpdateInProgress with status suffix", err)
	}
	if m.GetStatus().Status != StatusRestarting {
		t.Fatalf("status must stay restarting, got %s", m.GetStatus().Status)
	}
	if n := len(notes()); n != 0 {
		t.Fatalf("rejected admission must not notify, got %d", n)
	}
}

// npm 形态：受理前拒绝（ErrNpmManaged 交还请求方，API 层 409 指引）
func TestStartUpdateRejectsNpmManaged(t *testing.T) {
	t.Setenv("CODECOMBO_INSTALLER", "npm")
	m := testManager(t)
	notes := captureNotifications(t)

	if err := m.StartUpdate(&ReleaseInfo{Version: "9.9.9"}, "0.0.1", 0); !errors.Is(err, ErrNpmManaged) {
		t.Fatalf("err = %v, want ErrNpmManaged", err)
	}
	if m.GetStatus().Status != StatusIdle || len(notes()) != 0 {
		t.Fatalf("npm rejection must leave idle and silent, got %s / %d notes", m.GetStatus().Status, len(notes()))
	}
}

// 检查不得把在途态抹成 Idle（下载期跨分钟级，定时/手动检查必撞）
func TestCheckUpdateKeepsInFlightStatus(t *testing.T) {
	m := testManager(t)
	m.SetSource(&fakeSource{info: &ReleaseInfo{Version: "9.9.9"}})
	for _, s := range []Status{StatusDownloading, StatusVerifying, StatusReplacing, StatusRestarting} {
		m.status = s
		if _, err := m.CheckUpdateWithCache(context.Background(), "0.0.1", true); err != nil {
			t.Fatalf("check: %v", err)
		}
		if got := m.GetStatus().Status; got != s {
			t.Fatalf("check during %s clobbered status to %s", s, got)
		}
	}
	// 非在途：照旧 Checking→Idle
	m.status = StatusIdle
	_, _ = m.CheckUpdateWithCache(context.Background(), "0.0.1", true)
	if got := m.GetStatus().Status; got != StatusIdle {
		t.Fatalf("idle check should end idle, got %s", got)
	}
}

// 受理即清上一轮结果文件：换包重启窗内新进程先于子进程落盘可读到旧结论
func TestApplyClearsStaleResultOnAdmission(t *testing.T) {
	m := testManager(t)
	if err := SaveUpdateResult(m.dataDir, &UpdateResult{Status: "success", Version: "1.0.0"}); err != nil {
		t.Fatal(err)
	}
	// http 源在 download 前即被 https 公网校验拒绝：受理后失败，结果文件已清
	_ = m.ApplyUpdate(context.Background(), &ReleaseInfo{Version: "9.9.9", DownloadURL: "http://127.0.0.1/x"}, "0.0.1", 0, nil)
	if r, _ := LoadUpdateResult(m.dataDir); r != nil {
		t.Fatalf("stale result should be cleared at admission, got %+v", r)
	}
	if st := m.GetStatus(); st.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", st.Status)
	}
}

// 中心分发缓存下载（DownloadToFile）不回写状态机进度：与并发自更新互踩的源头
func TestDownloadToFileDoesNotTouchProgress(t *testing.T) {
	m := testManager(t)
	useFakeDownload(t, bytes.Repeat([]byte("y"), 2048))
	dest := filepath.Join(t.TempDir(), "serve.bin")
	if err := m.DownloadToFile(context.Background(), "https://example.com/serve", dest); err != nil {
		t.Fatalf("download: %v", err)
	}
	if st := m.GetStatus(); st.Progress != 0 || st.Total != 0 {
		t.Fatalf("serve download must not touch progress, got %d/%d", st.Progress, st.Total)
	}
}
