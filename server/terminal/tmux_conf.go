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
//
// 关键设置：
//   - allow-passthrough on: tmux 3.3+ 透传 OSC 133 等应用级转义序列（Phase 5 shellint 改造依赖）
//   - history-limit <N>: 用户配置的 scrollback 行数
//   - default-terminal screen-256color: tmux 内部 TERM
//   - terminal-overrides ...Tc: 启用 truecolor
//   - status off: 不显示 tmux 状态栏，让前端 xterm 独占
//   - mouse on: 鼠标分屏/选择（方案 A 用户操作依赖）
//   - unbind MouseDown3*: 关掉 tmux 自带右键菜单——否则右键按下被 tmux 接管、它画出
//     自带英文菜单，本系统右键菜单又叠加其上（双层菜单）。右键统一交给本系统菜单；
//     tmux 菜单里的分屏/Kill/Zoom 等由本系统 tab 栏与工具栏承担，复制走左键拖选
//     （MouseDragEnd 默认 copy-pipe，经 set-clipboard/OSC 52 进系统剪贴板）
//   - escape-time 10: 缩短 ESC 延迟，避免 vim 卡顿
//   - focus-events on: 让 FocusGained/Bost 透传
//   - aggressive-resize on: 每个窗口尺寸独立
func tmuxConfContent(historyLimit int) string {
	return `# Codecombo managed tmux config - DO NOT EDIT
set -g allow-passthrough on
set -g history-limit ` + strconv.Itoa(historyLimit) + `
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g status off
set -g mouse on
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
func ensureTmuxConf(historyLimit int) (string, error) {
	confPath := filepath.Join(config.DataDir(), "tmux.conf")
	want := tmuxConfContent(historyLimit)
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
