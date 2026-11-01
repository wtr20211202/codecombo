package watch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/model"
)

// Module watch 模块：仓库文件监听作为内核模块托管。发布 topic：file.changed；
// 并订阅 project 领域的生命周期事件（project.added / project.removed）自管
// 运行期监听接入——历史上由 api 层经包级变量触达（watch.Default 包级桥，
// roadmap 已消除），现在模块自己听总线，api 层不再反向感知本模块。
type Module struct {
	k  kernel.Kernel
	rw *RepoWatcher

	unsubAdded     func()
	unsubRemoved   func()
	unsubSelfWrite func()
}

// NewModule 创建 watch 模块
func NewModule() *Module {
	return &Module{}
}

func (m *Module) Name() string        { return "watch" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	rw, err := NewRepoWatcher(func(projectID string, msg model.WSMessage) {
		// 双通道：事件总线（唯一发布面，WS 兼容面由 api 层桥接）
		if k != nil {
			k.Events().Publish(kernel.Envelope{
				Topic:     msg.Type,
				ProjectID: projectID,
				Payload:   msg.Data,
			})
		}
	})
	if err != nil {
		return fmt.Errorf("create repo watcher: %w", err)
	}
	m.rw = rw
	return nil
}

func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	if m.rw == nil {
		return errors.New("watch: repo watcher not initialized")
	}
	m.rw.Start()
	// WatchAll 同步递归遍历所有项目目录树（inotify 逐目录注册），大工作区以秒计——
	// 放入 goroutine 让 HTTP 监听先行可用；建立完成前的窗口内文件事件可能缺失，
	// 前端既有 300ms 防抖拉取 + 打开文件全量读兜底，属可接受窗口
	go func() {
		m.rw.WatchAll()
		slog.Info("watch: initial project watch established")
	}()

	// 运行期项目增删 → 自管监听接入/摘除（载荷为 map，避免反向依赖 api 层类型）
	m.unsubAdded = k.Events().Subscribe("project.added", func(env kernel.Envelope) {
		var p struct{ ID, Path string }
		if !decodePayload(env.Payload, &p) || p.ID == "" || p.Path == "" {
			slog.Warn("watch: malformed project.added payload")
			return
		}
		if err := m.rw.TrackProject(p.ID, p.Path); err != nil {
			slog.Warn("watch: track project failed", "path", p.Path, "err", err)
		}
	})
	m.unsubRemoved = k.Events().Subscribe("project.removed", func(env kernel.Envelope) {
		var p struct{ ID, Path string }
		if !decodePayload(env.Payload, &p) {
			slog.Warn("watch: malformed project.removed payload")
			return
		}
		m.rw.UntrackProject(p.ID, p.Path)
	})
	// 工作台自身写入标记（P-20261005-15）：files 域写盘前发布 file.selfwrite
	//（api/files/module.go 常量，字面量订阅与 busbridge/file.changed 同惯例），
	// 敏感外部写入观测据此过滤 API 写自环、只记真外部。载荷只认 path 段
	m.unsubSelfWrite = k.Events().Subscribe("file.selfwrite", func(env kernel.Envelope) {
		var p struct{ Path string }
		if !decodePayload(env.Payload, &p) || p.Path == "" {
			slog.Warn("watch: malformed file.selfwrite payload")
			return
		}
		m.rw.external.noteSelfWrite(p.Path)
	})
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	if m.unsubAdded != nil {
		m.unsubAdded()
		m.unsubAdded = nil
	}
	if m.unsubRemoved != nil {
		m.unsubRemoved()
		m.unsubRemoved = nil
	}
	if m.unsubSelfWrite != nil {
		m.unsubSelfWrite()
		m.unsubSelfWrite = nil
	}
	if m.rw != nil {
		m.rw.Stop()
	}
	return nil
}

// Watcher 暴露底层 RepoWatcher（同包/测试用）
func (m *Module) Watcher() *RepoWatcher { return m.rw }

// FallbackStatus / SetFallback 降级轮询兜底的状态读取与手动开关
// （P-20261003-140）。挂 Module 而非 RepoWatcher：组合根在 Init 之前即可把
// 模块实例装配给 api 桥（server/api/watchapi.Control 隐式实现——api 层不
// import 本包，与 watch.Default 包级桥已消除的路线一致），请求期 m.rw 必已就绪
func (m *Module) FallbackStatus() (bool, string, time.Time) {
	if m.rw == nil {
		return false, "", time.Time{}
	}
	return m.rw.FallbackStatus()
}

func (m *Module) SetFallback(enable *bool) (bool, string, time.Time) {
	if m.rw == nil {
		return false, "", time.Time{}
	}
	return m.rw.SetFallback(enable)
}

// decodePayload 宽松解码 map/struct 形态的事件载荷
func decodePayload(payload any, dst any) bool {
	switch v := payload.(type) {
	case string:
		return json.Unmarshal([]byte(v), dst) == nil
	default:
		b, err := json.Marshal(payload)
		return err == nil && json.Unmarshal(b, dst) == nil
	}
}
