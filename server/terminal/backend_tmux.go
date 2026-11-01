//go:build !windows

package terminal

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/creack/pty/v2"

	"codecombo/server/store"
)

// tmuxBackend 基于 tmux server 的持久化终端后端
// 通过专属 socket (-L simple-coding) 管理 tmux session，
// shell 进程脱离 simple-coding 主进程生命周期，独立持久化
type tmuxBackend struct{}

// newTmuxBackend 创建 tmux 后端实例（仅 unix build）
func newTmuxBackend() PtyBackend {
	return &tmuxBackend{}
}

// tmuxAttachConn 包装 tmux attach-session 子进程的 PTY
// 关闭该 PTY 仅结束 attach 子进程，**不影响底层 tmux session**
type tmuxAttachConn struct {
	*os.File
	cmd *exec.Cmd
}

func (c *tmuxAttachConn) Close() error {
	if c.cmd != nil && c.cmd.Process != nil {
		// 杀 attach 子进程（不影响底层 session）
		_ = c.cmd.Process.Kill()
	}
	return c.File.Close()
}

// Wait 等待 attach 子进程退出（detach 或底层 session 被 kill）
func (c *tmuxAttachConn) Wait() (*os.ProcessState, error) {
	if c.cmd == nil {
		return nil, fmt.Errorf("no process to wait")
	}
	err := c.cmd.Wait()
	return c.cmd.ProcessState, err
}

// Create 创建 tmux 持久化 session 并立即 attach 一个进程供 readLoop 使用
//
// 流程：
//  1. 从 settings 读 history-limit（terminalScrollbackLines）
//  2. ensureTmuxConf 写配置文件（含最新 history-limit）
//  3. tmux set-option -s history-limit <N>（让已运行的 tmux server 用最新值，影响新 session）
//  4. tmux -f conf new-session -d -s <name> -x 80 -y 24 -e ... -- <shell>
//  5. tmux -L sock attach-session -t <name>（PTY 包装）
//
// spec.TmuxName 必须由 manager.go 在调用前通过 computeTmuxSessionName 填充
//
// history-limit 是 server option：tmux server 启动时读 conf 一次性确定，已存在 session
// 不会因 conf 改变而调整。set-option -s 在 server 已运行时强制更新，确保之后创建的 session
// 用最新值。已有 session 保持创建时的 history-limit。
func (b *tmuxBackend) Create(spec SessionSpec) (ptyConn, error) {
	if spec.TmuxName == "" {
		return nil, fmt.Errorf("tmux backend requires SessionSpec.TmuxName")
	}

	// 从 settings 读 history-limit
	historyLimit := DefaultScrollbackLines
	if cfg := store.Get().Settings.Get(); cfg != nil {
		historyLimit = GetScrollbackLines(cfg.Server.TerminalScrollbackLines)
	}

	confPath, err := ensureTmuxConf(historyLimit)
	if err != nil {
		return nil, fmt.Errorf("ensure tmux conf: %v", err)
	}

	// 同步 tmux server option：已运行的 server 不会重新读 conf，显式 set 让后续新 session 用最新值
	// 首次 Create 时 server 还没启动，set-option 会失败（正常，new-session 启动 server 时会读 conf）
	if _, err := runTmux("set-option", "-s", "history-limit", strconv.Itoa(historyLimit)); err != nil {
		slog.Debug("terminal: tmux set-option history-limit (server may not be running yet)",
			"err", err)
	}

	// 同步右键菜单解绑：conf 里的 unbind 只在 server 启动时生效，已运行的 server
	// （升级前创建）需显式补 unbind，否则 tmux 自带右键菜单与本系统菜单双层同现。
	// -n = 键不存在也不报错；专有 socket（-L simple-coding）不影响用户自己的 tmux
	for _, key := range []string{"MouseDown3Pane", "MouseDown3Status", "MouseDown3StatusLeft", "MouseDown3StatusRight"} {
		if _, err := runTmux("unbind-key", "-n", key); err != nil {
			slog.Debug("terminal: tmux unbind right-click menu key (server may not be running yet)",
				"key", key, "err", err)
		}
	}

	// 构造 new-session 参数：命令行只携带非敏感终端变量。
	// 注入变量（agentCallbackEnv：CC_BASE_URL / CC_LOCK_TOKEN，含长效敏感
	// 令牌）不进任何进程参数——tmux server 是常驻进程，cmdline 永久保留首次
	// 引导的 -e 参数，而 /proc/<pid>/cmdline 全局可读，敏感值放命令行等于向
	// 本机所有用户泄露（历史缺陷）；set-environment 的值放 argv 同样有短命
	// 客户端的竞读窗口。现经 0600 临时 conf + source-file 在会话级下发。
	// 其余 os.Environ 变量无需任何处理：new-session 的会话环境自动继承
	// tmux 客户端（本进程）环境
	args := []string{
		"new-session", "-d",
		"-s", spec.TmuxName,
		"-x", "80", "-y", "24",
		"-e", "TERM=screen-256color",
		"-e", "COLORTERM=truecolor",
		"-c", spec.Dir,
	}
	// shell integration 环境变量同步注入：zsh 的 ZDOTDIR 走 Env 而非 Args，
	// 丢了它 tmux+zsh 组合下 OSC 133 集成静默失效（native 后端无此问题）
	if spec.Setup != nil {
		for _, kv := range spec.Setup.Env {
			args = append(args, "-e", kv)
		}
	}
	// 引导 pane 用占位命令启动（此时注入变量尚未写入环境表）
	args = append(args, "sleep", "3600")

	if _, err := runTmuxWithConf(confPath, args...); err != nil {
		return nil, fmt.Errorf("tmux new-session: %v", err)
	}

	// shell integration 注入参数（Phase 5 才处理 tmux passthrough 包装）
	shellArgs := []string{spec.Shell}
	if spec.Setup != nil {
		shellArgs = append(shellArgs, spec.Setup.Args...)
	}

	// 注入变量写会话级环境：CC_LOCK_TOKEN 是长效敏感令牌，写 -g 会暴露给
	// tmux server 全局环境（任意会话可读），会话级只注入到本会话；下发通道
	// 用 setTmuxSessionEnv（0600 临时 conf + source-file），值不落任何进程
	// argv。令牌轮换后的既有会话刷新由 RefreshAgentCallbackEnv 遍历处理
	// （Rotate/Revoke API 调用），新会话此处注入的即当前值。
	// 一次性清理历史版本的 -g 残留（旧版本把令牌写进过全局，tmux server
	// 常驻、其全局环境不随本服务重启重置）
	scrubLegacyGlobalEnvOnce.Do(scrubLegacyGlobalEnv)
	setTmuxSessionEnv(spec.TmuxName, append(agentCallbackEnv(), terminalIDEnv(spec.ID)...))
	// 项目标识（P-20261003-307）单独一批下发：CC_PROJECT_PATH 是注册路径，可含
	// 空格等 conf 安全字符集外的值——若与敏感令牌同批，tmuxSessionEnvConf 会因
	// 单个超集值拒绝整批，把 CC_LOCK_TOKEN 一起打入 argv 直传回退（丢掉 conf
	// 通道加固）。拆批后回退只波及非敏感的项目标识两枚。
	// 路径取 spec.ProjectPath（项目注册根，P-20261005-192）：目录级终端会话的
	// spec.Dir 是子目录，CC_PROJECT_PATH 语义不随工作目录漂移；字段空回落 Dir
	// 兼容未填该字段的构造点（历史行为）
	envPathRoot := spec.Dir
	if spec.ProjectPath != "" {
		envPathRoot = spec.ProjectPath
	}
	setTmuxSessionEnv(spec.TmuxName, projectEnv(spec.ProjectID, envPathRoot))

	// respawn 把占位 pane 替换为真正的 shell（继承全局环境，注入变量生效）
	respawnArgs := []string{"respawn-pane", "-k", "-t", spec.TmuxName, "-c", spec.Dir}
	respawnArgs = append(respawnArgs, shellArgs...)
	if _, err := runTmux(respawnArgs...); err != nil {
		// respawn 失败则清理引导会话，避免遗留占位 pane
		_, _ = runTmux("kill-session", "-t", spec.TmuxName)
		return nil, fmt.Errorf("tmux respawn-pane: %v", err)
	}
	slog.Info("terminal: tmux session created",
		"name", spec.TmuxName, "shell", spec.Shell, "dir", spec.Dir)

	return b.attachInternal(spec)
}

// Reattach 重新 attach 到已存在的 tmux session
// 用于：readLoop EOF 后（attach 进程退出，底层 session 存活）的 WS 重连场景
func (b *tmuxBackend) Reattach(spec SessionSpec) (ptyConn, error) {
	if spec.TmuxName == "" {
		return nil, fmt.Errorf("tmux backend requires SessionSpec.TmuxName")
	}
	if !b.Alive(spec) {
		return nil, fmt.Errorf("tmux session not alive: %s", spec.TmuxName)
	}
	slog.Info("terminal: tmux session reattach", "name", spec.TmuxName, "external", spec.TmuxExternal)
	return b.attachInternal(spec)
}

// attachInternal 启动 tmux attach-session 子进程并包装为 PTY。
// socket 按 spec 分流（runTmuxFor 同款纪律）：外部接管会话 attach 用户默认
// socket（其会话所在面），自建会话 attach 专属 socket
func (b *tmuxBackend) attachInternal(spec SessionSpec) (ptyConn, error) {
	var cmd *exec.Cmd
	if spec.TmuxExternal {
		cmd = exec.Command("tmux", "attach-session", "-t", spec.TmuxName)
	} else {
		cmd = exec.Command("tmux", "-L", tmuxSocketName, "attach-session", "-t", spec.TmuxName)
	}
	cmd.Env = append(os.Environ(), "TERM=screen-256color")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("start tmux attach: %v", err)
	}
	return &tmuxAttachConn{File: ptmx, cmd: cmd}, nil
}

// CaptureScrollback 通过 capture-pane 重放 scrollback 历史
// -e 保留 ANSI 转义序列（颜色/光标格式），不加则重放为纯文本无颜色
// 默认抓取最近 maxLines 行
func (b *tmuxBackend) CaptureScrollback(spec SessionSpec, maxLines int) ([]byte, error) {
	return b.capture(spec, maxLines, false)
}

// CaptureHistory 只抓取可视区上方的历史行（-E -1 截止到可视区顶行的上一行）。
// 当前可视屏交给 RedrawClient 重绘：capture-pane 的线性文本转储没有光标定位
// 上下文，全屏 TUI（claude/vim 等）场景下把它当作当前屏写入全新 xterm 后，
// tmux attach 客户端后续的增量更新（相对光标定位）会全部错位——这是浏览器
// 刷新/切换视图后终端显示「全乱」的根因
func (b *tmuxBackend) CaptureHistory(spec SessionSpec, maxLines int) ([]byte, error) {
	return b.capture(spec, maxLines, true)
}

// capture capture-pane 封装：historyOnly=true 时截止到可视区上方，false 时含可视屏。
// maxLines<=0 时历史起点取全部（-S - 即 history 起点；不传 -S 则 tmux 默认从
// 可视区顶行起，-E -1 会得到空区间，历史重放静默失效）
func (b *tmuxBackend) capture(spec SessionSpec, maxLines int, historyOnly bool) ([]byte, error) {
	if spec.TmuxName == "" {
		return nil, nil
	}
	args := []string{"capture-pane", "-t", spec.TmuxName, "-e", "-p"}
	if maxLines > 0 {
		args = append(args, "-S", strconv.Itoa(-maxLines))
	} else if historyOnly {
		args = append(args, "-S", "-")
	}
	if historyOnly {
		args = append(args, "-E", "-1")
	}
	out, err := runTmuxFor(spec, args...)
	if err != nil {
		// session 可能已被外部 kill，返回空内容（让前端无感知重放失败）
		slog.Debug("terminal: tmux capture-pane failed",
			"name", spec.TmuxName, "err", err)
		return nil, nil
	}
	return out, nil
}

// RedrawClient 强制重绘 attach 在该 session 上的客户端可视屏
// （refresh-client 发送完整重绘序列：内容 + 光标位置 + 备屏状态），
// 供 WS 重连后把 tmux 客户端的精确终端状态同步给全新 xterm
func (b *tmuxBackend) RedrawClient(spec SessionSpec) {
	if spec.TmuxName == "" {
		return
	}
	// 找到 attach 在本 session 的客户端（client_name 为 tty 路径），逐个 refresh；
	// 无客户端 attach 时 list-clients 为空，静默返回
	out, err := runTmuxFor(spec, "list-clients", "-t", spec.TmuxName, "-F", "#{client_name}")
	if err != nil {
		slog.Debug("terminal: tmux list-clients failed", "name", spec.TmuxName, "err", err)
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		client := strings.TrimSpace(line)
		if client == "" {
			continue
		}
		if _, err := runTmuxFor(spec, "refresh-client", "-t", client); err != nil {
			slog.Debug("terminal: tmux refresh-client failed",
				"client", client, "err", err)
		}
	}
}

// Resize 同步 attach 进程的 PTY 尺寸
// tmux 客户端会捕获 SIGWINCH 并自动调整 pane 尺寸（aggressive-resize on 时每个 window 独立）
func (b *tmuxBackend) Resize(conn ptyConn, spec SessionSpec, rows, cols uint16) error {
	if ac, ok := conn.(*tmuxAttachConn); ok {
		return pty.Setsize(ac.File, &pty.Winsize{Rows: rows, Cols: cols})
	}
	return nil
}

// Kill 先杀 attach 子进程，再 kill-session 释放底层 tmux session
// 这是用户主动关闭终端（点 × 按钮）的语义：彻底释放资源
// 外部接管会话（spec.TmuxExternal）由 API/Manager 层分流——默认走解除接管
// 不进本方法，仅显式 kill 确认后才到这（kill-session 落在用户默认 socket）
func (b *tmuxBackend) Kill(conn ptyConn, spec SessionSpec) error {
	if conn != nil {
		_ = conn.Close()
	}
	if spec.TmuxName != "" {
		if _, err := runTmuxFor(spec, "kill-session", "-t", spec.TmuxName); err != nil {
			// session 可能已不存在，记录但不视为错误
			slog.Debug("terminal: tmux kill-session (already gone?)",
				"name", spec.TmuxName, "err", err)
		} else {
			slog.Info("terminal: tmux session killed", "name", spec.TmuxName, "external", spec.TmuxExternal)
		}
	}
	return nil
}

// Alive 检查底层 tmux session 是否存活
// 通过 list-sessions 列举判断（避免 has-session 的非零退出码坑）
func (b *tmuxBackend) Alive(spec SessionSpec) bool {
	if spec.TmuxName == "" {
		return false
	}
	out, err := runTmuxFor(spec, "list-sessions", "-F", "#{session_name}")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == spec.TmuxName {
			return true
		}
	}
	return false
}

// IsPersistent tmux session 独立于 attach 子进程存活
func (b *tmuxBackend) IsPersistent() bool {
	return true
}
