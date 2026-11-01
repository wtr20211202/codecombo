package git

import (
	"context"
	"path/filepath"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/model"
	"codecombo/server/store"
)

// newTestStore 装独立测试 store（模块 Init 依赖 SshKey/Project 仓储）
func newTestStore(t *testing.T) {
	t.Helper()
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// TestModuleConformance 契约一致性自检（M1.6）
func TestModuleConformance(t *testing.T) {
	newTestStore(t)
	kerneltest.Conformance(t, func() kernel.Module { return NewModule() })
	t.Cleanup(func() { broadcastFn, pathResolverFn = nil, nil })
}

// TestModuleWiring M1.5 验收：模块 Init 后广播与路径反查即生效——
// 广播走事件总线（envelope 字段完整），路径反查命中 store 项目表
func TestModuleWiring(t *testing.T) {
	newTestStore(t)

	projDir := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID:   "proj-w1",
		Name: "wired",
		Path: projDir,
	}); err != nil {
		t.Fatal(err)
	}

	m := NewModule()
	k := kernel.New(nil)
	if err := k.Register(m, kernel.Manifest{Name: m.Name()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { broadcastFn, pathResolverFn = nil, nil })

	if err := k.StartAll(context.Background()); err != nil {
		t.Fatal(err)
	}

	// 路径反查：命中
	if got := pathResolverFn(projDir); got != "proj-w1" {
		t.Fatalf("pathResolver = %q, want proj-w1", got)
	}
	// 路径反查：未命中
	if got := pathResolverFn(filepath.Join(projDir, "sub")); got != "" {
		t.Fatalf("pathResolver miss = %q, want empty", got)
	}

	// 广播：进总线，envelope 字段完整
	envCh := make(chan kernel.Envelope, 1)
	unsub := k.Events().Subscribe("git.command", func(env kernel.Envelope) { envCh <- env })
	defer unsub()

	broadcastFn("proj-w1", model.WSMessage{Type: "git.command", Data: model.CommandLog{Command: "git"}})
	env := <-envCh
	if env.Topic != "git.command" || env.ProjectID != "proj-w1" {
		t.Fatalf("envelope = %+v", env)
	}
	if log, ok := env.Payload.(model.CommandLog); !ok || log.Command != "git" {
		t.Fatalf("payload = %+v", env.Payload)
	}
}
