// Package kernel 提供模块化内核：Module 生命周期契约 + 依赖拓扑启动 + 事件总线 + 定时任务托管。
//
// 设计目标（见 docs/design/module-split-plugin-foundation.md）：
//   - 内置功能按「全栈垂直模块」组织，模块对外只依赖 Kernel 门面，禁止包级全局单例互引；
//   - 模块契约是未来进程级插件 manifest 的子集（Name/DependsOn/Routes/Topics/FrontendEntry），
//     后续插件化（Phase D）无需二次改造；
//   - Scheduler 托管的后台循环必须可停（治理"不可停 goroutine"）。
//
// 内核自身保持零业务依赖：仅依赖 model（DTO）与标准库。
package kernel

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
)

// APIVersion 内核模块契约版本（semver 大版本内只加不改；插件 manifest 据此做兼容门禁）
const APIVersion = "1.0.0"

// Module 一个可插拔的功能模块。生命周期由内核按依赖拓扑排序驱动：
// 全部 Init（依赖序）→ 全部 Start（依赖序）→ 全部 Stop（逆序）。
type Module interface {
	// Name 模块唯一名（[a-z0-9-]），同时是事件 topic 与 API 前缀的命名空间
	Name() string
	// DependsOn 依赖的其他模块名；缺省无依赖
	DependsOn() []string
	// Init 装配阶段：解析依赖、构造内部对象。耗时操作放 Start
	Init(ctx context.Context, k Kernel) error
	// Start 启动阶段：拉起后台任务、监听事件等
	Start(ctx context.Context, k Kernel) error
	// Stop 优雅停止：必须在该调用返回后不再产生任何副作用
	Stop(ctx context.Context, k Kernel) error
}

// Manifest 模块元数据：/api/modules 发现端点的载荷，
// 与未来插件 plugin.json 的 contributes 字段一一对应
type Manifest struct {
	Name          string   `json:"name"`
	Title         string   `json:"title"`
	APIVersion    string   `json:"apiVersion"`
	Routes        []string `json:"routes,omitempty"`
	Topics        []string `json:"topics,omitempty"`
	FrontendEntry string   `json:"frontendEntry,omitempty"`
	Builtin       bool     `json:"builtin"`
	// Capabilities 端点级能力项（/api/meta 能力探测载荷，P-20261004-4）：
	// 多实例异版本部署下，前端与 Agent 调对端新端点前先探测此项，未声明
	// 即走旧版兼容路径（404 回退的协议化替代）。kebab-case 端点家族名，
	// 随模块清单声明（新端点上线即在此登记，探测面自动跟随）
	Capabilities []string `json:"capabilities,omitempty"`
}

// ModuleInfo 模块 + 元数据
type ModuleInfo struct {
	Module   Module   `json:"-"`
	Manifest Manifest `json:"manifest"`
	State    string   `json:"state"` // init-pending / started / stopped
}

// Kernel 内核门面：模块唯一可见的世界。
type Kernel interface {
	// Events 统一事件总线（发布/订阅，类型化信封）
	Events() *EventBus
	// Scheduler 后台定时任务托管（Stop 时统一取消并等待退出）
	Scheduler() *Scheduler
	// Logger 内核命名空间 logger（模块可用 With("module", Name()) 派生）
	Logger() *slog.Logger
	// Modules 已注册模块快照（发现端点用）
	Modules() []ModuleInfo
}

var (
	ErrDuplicateModule = errors.New("kernel: duplicate module name")
	ErrUnknownDep      = errors.New("kernel: unknown dependency")
	ErrDepCycle        = errors.New("kernel: dependency cycle")
)

// StdKernel 内核标准实现。注册期（Register）与运行期（StartAll/StopAll）分离，
// 注册期加写锁，运行期只读——无需在事件热路径上加锁。
// 面向模块暴露 Kernel 门面接口；组合根（main.go）使用具体类型驱动生命周期。
type StdKernel struct {
	mu      sync.RWMutex
	modules []*ModuleInfo
	byName  map[string]*ModuleInfo
	started bool

	bus       *EventBus
	scheduler *Scheduler
	logger    *slog.Logger
}

// New 创建内核实例
func New(logger *slog.Logger) *StdKernel {
	if logger == nil {
		logger = slog.Default()
	}
	return &StdKernel{
		byName:    make(map[string]*ModuleInfo),
		bus:       NewEventBus(),
		scheduler: NewScheduler(logger),
		logger:    logger,
	}
}

// Register 注册模块（必须在 StartAll 之前完成）
func (k *StdKernel) Register(m Module, mf Manifest) error {
	if mf.Name == "" {
		mf.Name = m.Name()
	}
	if mf.APIVersion == "" {
		mf.APIVersion = APIVersion
	}
	mf.Builtin = true

	k.mu.Lock()
	defer k.mu.Unlock()
	if k.started {
		return errors.New("kernel: cannot register module after StartAll")
	}
	if _, dup := k.byName[mf.Name]; dup {
		return fmt.Errorf("%w: %s", ErrDuplicateModule, mf.Name)
	}
	info := &ModuleInfo{Module: m, Manifest: mf, State: "init-pending"}
	k.modules = append(k.modules, info)
	k.byName[mf.Name] = info
	return nil
}

// Events 实现 Kernel
func (k *StdKernel) Events() *EventBus { return k.bus }

// Scheduler 实现 Kernel
func (k *StdKernel) Scheduler() *Scheduler { return k.scheduler }

// Logger 实现 Kernel
func (k *StdKernel) Logger() *slog.Logger { return k.logger }

// Modules 实现 Kernel（快照）
func (k *StdKernel) Modules() []ModuleInfo {
	k.mu.RLock()
	defer k.mu.RUnlock()
	out := make([]ModuleInfo, len(k.modules))
	for i, m := range k.modules {
		out[i] = ModuleInfo{Manifest: m.Manifest, State: m.State}
	}
	return out
}

// topoOrder 依赖拓扑排序（Kahn）。返回排序后的模块切片；
// 未知依赖返回 ErrUnknownDep，成环返回 ErrDepCycle。
func (k *StdKernel) topoOrder() ([]*ModuleInfo, error) {
	k.mu.RLock()
	defer k.mu.RUnlock()

	indeg := make(map[string]int, len(k.modules))
	dependents := make(map[string][]string, len(k.modules)) // dep -> [who depends on it]
	for _, m := range k.modules {
		name := m.Manifest.Name
		if _, ok := indeg[name]; !ok {
			indeg[name] = 0
		}
		for _, dep := range m.Module.DependsOn() {
			if _, ok := k.byName[dep]; !ok {
				return nil, fmt.Errorf("%w: %s needs %s", ErrUnknownDep, name, dep)
			}
			indeg[name]++
			dependents[dep] = append(dependents[dep], name)
		}
	}

	// 注册顺序即同层稳定顺序
	queue := make([]*ModuleInfo, 0, len(k.modules))
	for _, m := range k.modules {
		if indeg[m.Manifest.Name] == 0 {
			queue = append(queue, m)
		}
	}
	order := make([]*ModuleInfo, 0, len(k.modules))
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		order = append(order, cur)
		for _, next := range dependents[cur.Manifest.Name] {
			indeg[next]--
			if indeg[next] == 0 {
				queue = append(queue, k.byName[next])
			}
		}
	}
	if len(order) != len(k.modules) {
		return nil, ErrDepCycle
	}
	return order, nil
}

// StartAll 按依赖拓扑完成全部模块的 Init + Start。任一模块失败即返回错误
//（已 Start 的模块会被回滚 Stop）
func (k *StdKernel) StartAll(ctx context.Context) error {
	order, err := k.topoOrder()
	if err != nil {
		return err
	}

	started := make([]*ModuleInfo, 0, len(order))
	for _, m := range order {
		if err := m.Module.Init(ctx, k); err != nil {
			k.rollbackStop(ctx, started)
			return fmt.Errorf("kernel: init module %s: %w", m.Manifest.Name, err)
		}
	}
	for _, m := range order {
		if err := m.Module.Start(ctx, k); err != nil {
			k.rollbackStop(ctx, started)
			return fmt.Errorf("kernel: start module %s: %w", m.Manifest.Name, err)
		}
		m.State = "started"
		started = append(started, m)
	}
	k.mu.Lock()
	k.started = true
	k.mu.Unlock()
	return nil
}

// rollbackStop 逆序停止已启动模块
func (k *StdKernel) rollbackStop(ctx context.Context, started []*ModuleInfo) {
	for i := len(started) - 1; i >= 0; i-- {
		m := started[i]
		if err := m.Module.Stop(ctx, k); err != nil {
			k.logger.Error("kernel: stop module on rollback", "module", m.Manifest.Name, "err", err)
		}
		m.State = "stopped"
	}
}

// StopAll 逆序停止全部模块（含已启动未注册完成的场景），随后停止调度器与事件总线
func (k *StdKernel) StopAll(ctx context.Context) {
	order, err := k.topoOrder()
	if err != nil {
		// 注册不完整（有未知依赖/环）：退化为注册逆序停止，尽力而为
		k.mu.RLock()
		for i := len(k.modules) - 1; i >= 0; i-- {
			m := k.modules[i]
			if m.State == "started" {
				_ = m.Module.Stop(ctx, k)
				m.State = "stopped"
			}
		}
		k.mu.RUnlock()
	} else {
		for i := len(order) - 1; i >= 0; i-- {
			m := order[i]
			if m.State != "started" {
				continue
			}
			if err := m.Module.Stop(ctx, k); err != nil {
				k.logger.Error("kernel: stop module", "module", m.Manifest.Name, "err", err)
			}
			m.State = "stopped"
		}
	}
	k.scheduler.Stop()
	k.bus.Close()
}
