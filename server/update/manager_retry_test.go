package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// testManager 干净的测试管理器（不触全局单例）
func testManager(t *testing.T) *Manager {
	t.Helper()
	return &Manager{
		status:     StatusIdle,
		dataDir:    t.TempDir(),
		binaryPath: filepath.Join(t.TempDir(), "simple-coding.exe"),
	}
}

// fakeSource 返回固定 ReleaseInfo 的假源
type fakeSource struct{ info *ReleaseInfo }

func (f *fakeSource) FetchLatest(_ context.Context, _, _ string) (*ReleaseInfo, error) {
	return f.info, nil
}

// R1 守护：更新失败（校验不过）后必须可重试——历史实现 ApplyUpdate 只接受
// Idle/Checking，失败终态后重试永远 409
func TestApplyUpdateRetryAfterFailure(t *testing.T) {
	m := testManager(t)

	// 无签名/校验和的 release：verifyUpdate 拒绝 → StatusFailed
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not a real binary"))
	}))
	t.Cleanup(srv.Close)

	m.SetSource(&fakeSource{info: &ReleaseInfo{
		Version:     "9.9.9",
		DownloadURL: srv.URL,
	}})
	if _, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil); err == nil {
		t.Fatal("expected apply to fail (unverifiable release)")
	}
	if st := m.GetStatus(); st.Status != StatusFailed {
		t.Fatalf("expected failed status, got %s", st.Status)
	}

	// 直接重试：不再被 Failed 终态卡死（应再次进入下载并同样失败，而非 409）
	err := m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil)
	if err == nil {
		t.Fatal("expected retry to fail on same unverifiable release")
	}
	if st := m.GetStatus(); st.Status != StatusFailed {
		t.Fatalf("retry should end failed again, got %s", st.Status)
	}
}

// R1 守护：下载失败后临时目录清理干净（半截文件不留给下次）
func TestApplyUpdateCleansTmpOnDownloadFailure(t *testing.T) {
	m := testManager(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden) // 非 200 → 下载即败
	}))
	t.Cleanup(srv.Close)

	m.SetSource(&fakeSource{info: &ReleaseInfo{
		Version:     "9.9.9",
		DownloadURL: srv.URL,
	}})
	_, _ = m.CheckUpdate(context.Background(), "0.0.1")
	_ = m.ApplyUpdate(context.Background(), m.cachedInfo, "0.0.1", 0, nil)

	if _, err := os.Stat(filepath.Join(m.dataDir, "tmp", "update-9.9.9")); !os.IsNotExist(err) {
		t.Fatal("tmp dir should be removed after download failure")
	}
}

// R1 守护：下载停滞检测——服务端只发响应头不发 body，60s 内应有进展失败而非挂死
// （这里用短停滞参数不可行——常量固定；退化为验证 ctx 取消路径快速返回）
func TestDownloadContextCancel(t *testing.T) {
	m := testManager(t)
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "1000")
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		<-block // 挂住连接：模拟死链
	}))
	t.Cleanup(func() { close(block); srv.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	t.Cleanup(cancel)
	dest := filepath.Join(t.TempDir(), "dl.bin")
	start := time.Now()
	err := m.download(ctx, srv.URL, dest, nil, false)
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("cancel should return promptly, took %s", elapsed)
	}
}
