//go:build !windows

package terminal

import (
	"log/slog"
	"os"
	"path/filepath"
	"strconv"

	"codecombo/server/config"
)

// tmuxConfContent 生成 Codecombo 托管的 tmux 配置内容
// historyLimit 来自用户 settings（terminalScrollbackLines），控制 tmux 的 scrollback 上限
// mouseOn 来自用户 settings（terminalTmuxMouseEnabled，P-20261109-7，默认开）
//
// 关键设置：
//   - allow-passthrough on: tmux 3.3+ 透传 OSC 133 等应用级转义序列（Phase 5 shellint 改造依赖）
//   - set-clipboard on: tmux copy-pipe 与应用裸 OSC 52 的系统剪贴板落点（P-20261109-7）。
//     <3.2 默认 off = 拖选源头即不发 OSC 52（「改名后复制失效」死源主因）；external 仅
//     覆盖 tmux 自身 copy-pipe，on 兼容应用自发 OSC 52 双覆盖
//   - history-limit <N>: 用户配置的 scrollback 行数
//   - default-terminal screen-256color: tmux 内部 TERM
//   - terminal-overrides ...Tc: 启用 truecolor
//   - status off: 不显示 tmux 状态栏，让前端 xterm 独占
//   - mouse on|off: tmux 鼠标接管开关（P-20261109-7，默认 on）——on=拖选进 tmux copy-mode
//     选择（MouseDragEnd copy-pipe 经 set-clipboard 进剪贴板），claude 滚轮翻页/分屏拖拽
//     保留；off=复制优先模式（拖选落回 xterm 原生选择+copyOnSelect），代价：tmux 处 alt
//     screen 时 xterm scrollback 为空、滚轮翻史失效，分屏拖拽/点击切 pane 失效
//   - unbind MouseDown3*: 关掉 tmux 自带右键菜单——否则右键按下被 tmux 接管、它画出
//     自带英文菜单，本系统右键菜单又叠加其上（双层菜单）。右键统一交给本系统菜单；
//     tmux 菜单里的分屏/Kill/Zoom 等由本系统 tab 栏与工具栏承担，复制走左键拖选
//     （MouseDragEnd 默认 copy-pipe，经 set-clipboard/OSC 52 进系统剪贴板）
//   - escape-time 10: 缩短 ESC 延迟，避免 vim 卡顿
//   - focus-events on: 让 FocusGained/Bost 透传
//   - aggressive-resize on: 每个窗口尺寸独立
func tmuxConfContent(historyLimit int, mouseOn bool) string {
	mouseLine := "off"
	if mouseOn {
		mouseLine = "on"
	}
	return `# Codecombo managed tmux config - DO NOT EDIT
set -g allow-passthrough on
set -s set-clipboard on
set -g history-limit ` + strconv.Itoa(historyLimit) + `
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g status off
set -g mouse ` + mouseLine + `
unbind -n MouseDown3Pane
unbind -n MouseDown3Status
unbind -n MouseDown3StatusLeft
unbind -n MouseDown3StatusRight
set -g escape-time 10
set -g focus-events on
setw -g aggressive-resize on
`
}

// ensureTmuxConf 确保 tmux.conf 文件内容与配置一致
// 路径: ~/.codecombo/tmux.conf
// - 文件不存在或内容与目标不一致：写入新内容（含最新 history-limit）
// - 内容一致：跳过 IO
// 返回文件路径或写入错误
//
// 注意：tmux.conf 由 Codecombo 全权托管。用户改 settings 后内容会被覆盖。
// 已运行的 tmux server 不会自动重新读 conf，需要 Create 中调 set-option -s 同步。
func ensureTmuxConf(historyLimit int, mouseOn bool) (string, error) {
	confPath := filepath.Join(config.DataDir(), "tmux.conf")
	want := tmuxConfContent(historyLimit, mouseOn)
	if existing, err := os.ReadFile(confPath); err == nil {
		if string(existing) == want {
			return confPath, nil
		}
		slog.Info("terminal: tmux.conf changed, rewriting",
			"path", confPath, "historyLimit", historyLimit)
	}
	if err := os.WriteFile(confPath, []byte(want), 0644); err != nil {
		slog.Error("terminal: failed to write tmux.conf", "path", confPath, "err", err)
		return "", err
	}
	slog.Info("terminal: tmux.conf written", "path", confPath, "historyLimit", historyLimit)
	return confPath, nil
}
