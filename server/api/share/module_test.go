package shareapi

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/kernel"
	sharecore "codecombo/server/share"
	"codecombo/server/store"
)

// TestModuleLifecycle 起停子服务：监听就绪 → 状态可查 → 访客端点可达
// （未知 token 返回友好 404 页）→ Stop 后端口关闭
func TestModuleLifecycle(t *testing.T) {
	dir := t.TempDir()
	store.SetDefault(store.New(filestore.New(dir)))
	t.Cleanup(func() { store.SetDefault(nil) })

	port := 29871 // 测试专用高端口；占用时表现为连接拒绝而失败，可换端口重跑
	cfg := &config.Config{}
	cfg.Server.Host = "127.0.0.1"
	cfg.Server.Port = 29870
	cfg.Server.SharePort = port

	m := NewModule(cfg, false, "", "")
	k := &fakeKernel{}
	if err := m.Start(context.Background(), k); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = m.Stop(context.Background(), k) })

	st := currentStatus()
	if !st.Running || st.Port != port || st.Scheme != "http" {
		t.Fatalf("status = %+v", st)
	}
	if config.RuntimeSharePort() != port {
		t.Fatalf("config.RuntimeSharePort() = %d, want %d", config.RuntimeSharePort(), port)
	}
	// 同源入口（P-20261020-2）：监听成功即发布给主应用 /s/* 路由
	if sharecore.SameOriginHandler() == nil {
		t.Fatal("same-origin handler should be published after start")
	}

	// 访客面：未知 token → 404 + HTML 友好页
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/s/zzzzzzzzzzzzzzzz", port))
	if err != nil {
		t.Fatalf("visitor GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown token status = %d", resp.StatusCode)
	}
	if resp.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("404 content-type = %s", resp.Header.Get("Content-Type"))
	}
	if len(body) == 0 {
		t.Fatal("empty 404 body")
	}

	if err := m.Stop(context.Background(), k); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if s := currentStatus(); s.Running {
		t.Fatal("status should be not-running after stop")
	}
	if config.RuntimeSharePort() != 0 {
		t.Fatal("runtime share port should reset to 0 after stop")
	}
	if sharecore.SameOriginHandler() != nil {
		t.Fatal("same-origin handler should be cleared after stop")
	}
	// 关闭后连接应被拒绝
	time.Sleep(50 * time.Millisecond)
	if _, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", port)); err == nil {
		t.Fatal("connection should be refused after stop")
	}
}

// fakeKernel 满足 Module 启停所需的最小内核门面（只用 Logger）
type fakeKernel struct{}

func (f *fakeKernel) Events() *kernel.EventBus     { return nil }
func (f *fakeKernel) Scheduler() *kernel.Scheduler { return nil }
func (f *fakeKernel) Logger() *slog.Logger         { return slog.Default() }
func (f *fakeKernel) Modules() []kernel.ModuleInfo { return nil }
