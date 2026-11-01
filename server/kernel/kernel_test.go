package kernel

import (
	"context"
	"errors"
	"slices"
	"testing"
)

// testModule 生命周期顺序记录器
type testModule struct {
	name  string
	deps  []string
	events *[]string // 追加 name:init / name:start / name:stop
	startErr error
	initErr  error
}

func (m *testModule) Name() string                { return m.name }
func (m *testModule) DependsOn() []string         { return m.deps }
func (m *testModule) Init(_ context.Context, _ Kernel) error {
	*m.events = append(*m.events, m.name+":init")
	return m.initErr
}
func (m *testModule) Start(_ context.Context, _ Kernel) error {
	if m.startErr == nil {
		*m.events = append(*m.events, m.name+":start")
	}
	return m.startErr
}
func (m *testModule) Stop(_ context.Context, _ Kernel) error {
	*m.events = append(*m.events, m.name+":stop")
	return nil
}

func TestStartAll_DependencyTopoOrder(t *testing.T) {
	k := New(nil)
	var events []string

	// 注册顺序故意乱：a 依赖 b、b 依赖 c，init 全部先于 start
	mustRegister(t, k, &testModule{name: "a", deps: []string{"b"}, events: &events})
	mustRegister(t, k, &testModule{name: "c", events: &events})
	mustRegister(t, k, &testModule{name: "b", deps: []string{"c"}, events: &events})

	if err := k.StartAll(context.Background()); err != nil {
		t.Fatalf("StartAll: %v", err)
	}
	k.StopAll(context.Background())

	// init 段：c b a；start 段：c b a；stop 段逆序 a b c
	got := events
	want := []string{"c:init", "b:init", "a:init", "c:start", "b:start", "a:start", "a:stop", "b:stop", "c:stop"}
	if !slices.Equal(got, want) {
		t.Fatalf("lifecycle order = %v, want %v", got, want)
	}
}

func TestStartAll_UnknownDependency(t *testing.T) {
	k := New(nil)
	var events []string
	_ = k.Register(&testModule{name: "x", deps: []string{"ghost"}, events: &events}, Manifest{})
	if err := k.StartAll(context.Background()); !errors.Is(err, ErrUnknownDep) {
		t.Fatalf("want ErrUnknownDep, got %v", err)
	}
}

func TestStartAll_DependencyCycle(t *testing.T) {
	k := New(nil)
	var events []string
	_ = k.Register(&testModule{name: "p", deps: []string{"q"}, events: &events}, Manifest{})
	_ = k.Register(&testModule{name: "q", deps: []string{"p"}, events: &events}, Manifest{})
	if err := k.StartAll(context.Background()); !errors.Is(err, ErrDepCycle) {
		t.Fatalf("want ErrDepCycle, got %v", err)
	}
}

func TestStartAll_DuplicateName(t *testing.T) {
	k := New(nil)
	var events []string
	if err := k.Register(&testModule{name: "dup", events: &events}, Manifest{}); err != nil {
		t.Fatalf("first register: %v", err)
	}
	if err := k.Register(&testModule{name: "dup", events: &events}, Manifest{}); !errors.Is(err, ErrDuplicateModule) {
		t.Fatalf("want ErrDuplicateModule, got %v", err)
	}
}

func TestStartAll_StartFailureRollsBackStartedModules(t *testing.T) {
	k := New(nil)
	var events []string
	_ = k.Register(&testModule{name: "ok", events: &events}, Manifest{})
	_ = k.Register(&testModule{name: "bad", deps: []string{"ok"}, events: &events, startErr: errors.New("boom")}, Manifest{})

	if err := k.StartAll(context.Background()); err == nil {
		t.Fatal("want start error")
	}
	// ok 已启动、bad 启动失败 → ok 必须被回滚 Stop
	assertContains(t, events, "ok:start", "ok:stop")
	assertNotContains(t, events, "bad:start")
}

func TestModules_SnapshotForDiscovery(t *testing.T) {
	k := New(nil)
	var events []string
	_ = k.Register(&testModule{name: "m1", events: &events}, Manifest{Name: "m1", Title: "模块一", Topics: []string{"m1.evt"}})
	mods := k.Modules()
	if len(mods) != 1 || mods[0].Manifest.Name != "m1" || mods[0].Manifest.APIVersion != APIVersion {
		t.Fatalf("modules = %+v", mods)
	}
	if !mods[0].Manifest.Builtin {
		t.Fatal("builtin flag should be set by Register")
	}
}

func mustRegister(t *testing.T, k *StdKernel, m *testModule) {
	t.Helper()
	if err := k.Register(m, Manifest{Name: m.name}); err != nil {
		t.Fatalf("register %s: %v", m.name, err)
	}
}

func assertContains(t *testing.T, events []string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !slices.Contains(events, w) {
			t.Fatalf("events missing %q: %v", w, events)
		}
	}
}

func assertNotContains(t *testing.T, events []string, banned string) {
	t.Helper()
	if slices.Contains(events, banned) {
		t.Fatalf("events should not contain %q: %v", banned, events)
	}
}
