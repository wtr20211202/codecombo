package terminal

import (
	"log/slog"

	"codecombo/server/terminal/shellint"
)

// BackendKind 终端后端类型
type BackendKind string

const (
	// BackendAuto 自动检测（tmux 可用则启用，否则 fallback native）
	BackendAuto BackendKind = "auto"
	// BackendTmux 强制使用 tmux 后端
	BackendTmux BackendKind = "tmux"
	// BackendNative 强制使用原生 PTY 后端
	BackendNative BackendKind = "native"
)

// SessionSpec 创建会话所需参数
// 作为 PtyBackend 各方法的入参，让 backend 实现可以通过
// ID/ProjectID 等标识符定位底层会话（tmux session 命名依赖此信息）
type SessionSpec struct {
	ID        string
	Name      string // 用户可读名称（前端 tab 标签）
	ProjectID string
	Shell     string
	Env       []string
	Dir       string
	Setup     *shellint.SetupResult

	// ProjectPath 项目注册根路径（P-20261005-192）：目录级终端会话的 Dir 是
	// 项目根内子目录，而 CC_PROJECT_PATH 语义恒为「注册根路径」（agent 据此
	// 对照 pwd 判断相对关系）——tmux 后端会话环境注入用本字段，空回落 Dir
	// （agent/外部接管等构造点未填时行为与历史一致：agent 会话本就 Dir=工作目录
	// 且免项目注入，不受影响）。native 后端不经此字段：CC_PROJECT_PATH 走
	// spec.Env（manager.create 以项目根装配）
	ProjectPath string

	// TmuxName tmux session 名（仅 tmux backend 使用）
	// 形如 sc-<projectId短哈希>-<6位随机>
	// manager.go 在 CreateSession 时通过 computeTmuxSessionName 填充
	// native backend 该字段为空，不影响行为
	TmuxName string

	// TmuxExternal 外部接管会话标记（P-20261005-189）：true = 本会话是服务器上
	// 用户自建的 tmux 会话（住用户默认 socket），本系统只是 attach 侧客户端。
	// 所有携带 spec 的 tmux IO 必须经 runTmuxFor 据此选 socket——外部会话不在
	// 专属 socket 上，裸调 runTmux 会当成同名的自建会话定向（找不到=静默失败，
	// 更坏情形是误伤同名的自建会话）。自建会话恒 false，零行为变化
	TmuxExternal bool
}

// PtyBackend 终端后端抽象
// 实现方：nativeBackend（原生 PTY）、tmuxBackend（tmux 持久化会话，Phase 2 引入）
type PtyBackend interface {
	// Create 启动底层会话（native: shell 子进程；tmux: new-session + attach）
	// 返回 ptyConn 供 Manager 的 readLoop/waitLoop 使用
	Create(spec SessionSpec) (ptyConn, error)

	// CaptureScrollback 重放 scrollback 历史（含当前可视屏内容）
	// native 返回 nil（无重放能力）；tmux 调 capture-pane
	CaptureScrollback(spec SessionSpec, maxLines int) ([]byte, error)

	// CaptureHistory 只取当前可视屏上方的历史行（不含可视屏内容）
	// tmux 供 WS 重连重放使用：可视屏由 RedrawClient 以完整终端状态重绘补齐，
	// 避免线性转储与 tmux 增量更新的光标状态不一致导致前端显示错乱
	CaptureHistory(spec SessionSpec, maxLines int) ([]byte, error)

	// RedrawClient 强制重绘当前可视屏（含光标位置/备屏等完整状态）
	// tmux 调 refresh-client；native 无对应概念（no-op）
	RedrawClient(spec SessionSpec)

	// Resize 同步底层会话尺寸
	// native 通过 ptyConn 调整；tmux 调 resize-pane
	Resize(conn ptyConn, spec SessionSpec, rows, cols uint16) error

	// Kill 彻底关闭底层会话（释放资源）
	// native 等同 ptyConn.Close()；tmux 调 kill-session 释放底层 tmux session
	Kill(conn ptyConn, spec SessionSpec) error

	// Alive 检查底层会话是否存活
	// native 始终 true 直到 Close；tmux 调 list-sessions 检查
	Alive(spec SessionSpec) bool

	// IsPersistent 底层会话是否独立于 attach 进程
	// tmux 返回 true（attach 子进程死不影响底层 session，可 Reattach）
	// native 返回 false（shell 子进程死即 session 终结，无法 Reattach）
	IsPersistent() bool

	// Reattach 重新 attach 到已存在的底层会话
	// 仅 IsPersistent()=true 的 backend 实现有效（tmux）
	// native 返回 error（不支持重连）
	Reattach(spec SessionSpec) (ptyConn, error)
}

// ResolveBackend 根据配置与运行环境决定使用哪个后端
// 返回值为 BackendTmux 或 BackendNative
// Phase 1: tmux backend 尚未实现，所有配置均解析为 native（短路）
// Phase 2: 接入 isTmuxAvailable() 真正检测
func ResolveBackend(cfg string) BackendKind {
	kind := BackendKind(cfg)
	if kind == "" {
		kind = BackendAuto
	}

	switch kind {
	case BackendNative:
		return BackendNative
	case BackendTmux:
		if !isTmuxAvailable() {
			slog.Warn("terminal: tmux backend requested but unavailable, fallback to native",
				"reason", "tmux not installed or version < 3.3")
			return BackendNative
		}
		return BackendTmux
	case BackendAuto:
		if isTmuxAvailable() {
			return BackendTmux
		}
		return BackendNative
	default:
		slog.Warn("terminal: unknown backend kind, fallback to native", "kind", cfg)
		return BackendNative
	}
}

// NewBackend 根据 BackendKind 创建对应后端实例。
// 后端构造已注册表化（扩展点）：新后端实现 PtyBackend 后调用
// RegisterBackend(kind, factory) 接入，无需修改本函数；
// 未注册的 kind 一律回退原生 PTY（与历史 default 分支语义一致）
func NewBackend(kind BackendKind) PtyBackend {
	if f, ok := backendFactories[kind]; ok {
		return f()
	}
	return newNativeBackend()
}

var backendFactories = map[BackendKind]func() PtyBackend{
	BackendTmux:   func() PtyBackend { return newTmuxBackend() },
	BackendNative: func() PtyBackend { return newNativeBackend() },
}

// RegisterBackend 注册一种后端构造工厂（同名覆盖）
func RegisterBackend(kind BackendKind, factory func() PtyBackend) {
	backendFactories[kind] = factory
}
