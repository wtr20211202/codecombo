//go:build !windows

package terminal

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"codecombo/server/userbin"
)

// tmux 专属 socket 名，与用户 tmux 环境完全隔离。
// var 非 const：测试二进制经本包 TestMain 覆写为 per-process socket——并行
// go test 二进制（同仓多包并行 / 多 worktree 并行门禁）共用一枚 socket 时，
// 任一侧 TestModuleConformance→Start→RecoverSessions 的孤儿清扫会把测试
// 会话的空项目哈希（sc-e3b0c442-*）判为孤儿杀掉，对方存活中的等待面测试
// 随之帧流中断（实测 WSL 并行 verify 互踩）；产品路径读到的仍是固定名，
// 零行为变化。
// legacyTmuxSocketName：P-20261025-1 标识切换前的旧 socket 名。切换时挂在旧
// socket 上的在途会话（tmux server 常驻、其会话不随本服务重启消失）由
// runTmux 的旧 socket 回落与 RecoverSessions 的双 socket 并集列举兼容接管，
// 旧 socket server 随其末个会话结束自然退出——不设硬性切换日，旧名只读不写
// （新会话恒落新 socket）
var (
	tmuxSocketName       = "codecombo"
	legacyTmuxSocketName = "simple-coding"
)

// tmux session 名前缀（重启恢复时按此前缀过滤）
const tmuxSessionPrefix = "sc-"

// tmux 最低支持版本（allow-passthrough 自 3.3a 引入）
const (
	tmuxMinMajor = 3
	tmuxMinMinor = 3
)

var (
	tmuxCheckMu    sync.Mutex
	tmuxChecked    bool
	tmuxAvailable  bool
	tmuxBinary     string
	tmuxVersionStr string // tmux -V 原始输出（如 "tmux 3.4"），未安装时为空

	// tmuxSessionNameRe 反向解析 tmux session 名（重启恢复用）
	// 形如: sc-<8 hex>-<6 alnum>
	tmuxSessionNameRe = regexp.MustCompile(`^sc-([a-f0-9]{8})-([a-z0-9]{6})$`)
)

// runTmux 执行 tmux 命令（带专属 socket），返回 stdout。
// socket 隔离通过 -L codecombo 实现。
// 旧 socket 回落（P-20261025-1）：命令在新 socket 上失败且错误形态是「目标
// 不存在」（no server running / error connecting / can't find session）时，
// 对允许回落的命令族（会话定向读写/列举/终结，见 tmuxFallbackBlocked）在旧
// socket 重试一次——挂旧 socket 的在途会话切换期继续可捕获/可杀/可附；命令
// 在新 socket 有结果时绝不回落（新 socket 优先，防同名会话双命中）
func runTmux(args ...string) ([]byte, error) {
	fullArgs := append([]string{"-L", tmuxSocketName}, args...)
	out, err := runTmuxBinary(fullArgs)
	if err != nil && len(args) > 0 && !tmuxFallbackBlocked[args[0]] && tmuxTargetMissing(err) {
		if legacyOut, legacyErr := runTmuxBinary(append([]string{"-L", legacyTmuxSocketName}, args...)); legacyErr == nil {
			return legacyOut, nil
		}
	}
	return out, err
}

// tmuxFallbackBlocked 不做旧 socket 回落的命令族：创建/服务级/配置类——它们
// 的正确目标只有新 socket（在旧 socket 上执行要么误建会话要么写错服务器）
var tmuxFallbackBlocked = map[string]bool{
	"new-session":  true,
	"start-server": true,
	"kill-server":  true,
	"source-file":  true,
	"set-option":   true,
	"set-hook":     true,
	"server-info":  true,
	"show-options": true,
}

// tmuxTargetMissing 判断 tmux 错误是否为「socket/server/session 不存在」形态
// （tmux 对这三者的报错文案跨版本稳定，子串匹配足够）；其余失败（版本/权限/
// 参数错）不回落，避免把真故障吞成旧 socket 的静默成功
func tmuxTargetMissing(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "no server running") ||
		strings.Contains(msg, "error connecting to") ||
		strings.Contains(msg, "can't find session") ||
		strings.Contains(msg, "couldn't find session")
}

// runTmuxDefaultSocket 在用户默认 socket 上执行 tmux 命令（无 -L 前缀）。
// 外部会话面专用（P-20261005-189）：用户 SSH/脚本起的 tmux 会话住默认 socket，
// 与本项目专属 socket（-L simple-coding）完全隔离——外部会话的列举/attach/
// 按名定向 IO 都要落到这条通道
func runTmuxDefaultSocket(args ...string) ([]byte, error) {
	return runTmuxBinary(args)
}

// runTmuxFor 按 spec 所属面定向 tmux 命令：外部接管会话（TmuxExternal）走用户
// 默认 socket，自建会话走专属 socket。所有携带 SessionSpec 的 tmux IO 必须
// 经此分发——按名定向（capture-pane -t <name> 族）的前提是 socket 也对，
// 错 socket 会把外部会话当成专属 socket 上的同名会话（找不到=静默失败，
// 更坏情形是误伤同名的自建会话）
func runTmuxFor(spec SessionSpec, args ...string) ([]byte, error) {
	if spec.TmuxExternal {
		return runTmuxDefaultSocket(args...)
	}
	return runTmux(args...)
}

// runTmuxWithConf 执行带 -f confPath 的 tmux 命令（用于 new-session）
func runTmuxWithConf(confPath string, args ...string) ([]byte, error) {
	fullArgs := append([]string{"-L", tmuxSocketName, "-f", confPath}, args...)
	return runTmuxBinary(fullArgs)
}

// runTmuxBinary 底层 exec 封装
func runTmuxBinary(fullArgs []string) ([]byte, error) {
	bin := "tmux"
	if tmuxBinary != "" {
		bin = tmuxBinary
	}
	cmd := exec.Command(bin, fullArgs...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("tmux %s: %v (stderr: %s)",
			strings.Join(fullArgs, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

// isTmuxAvailable 检测 tmux 是否可用（PATH 存在 + 版本 >= 3.3）
// 结果缓存，可通过 resetTmuxCache 重新检测（用于一键安装成功后无需重启服务）
func isTmuxAvailable() bool {
	tmuxCheckMu.Lock()
	defer tmuxCheckMu.Unlock()
	if tmuxChecked {
		return tmuxAvailable
	}
	tmuxChecked = true
	setTmuxResultLocked(false, "", "")

	// userbin：PATH 之外兜底用户级安装（~/.local/bin、linuxbrew 等——守护
	// 进程 PATH 常缺用户级工具链，与 providers 探测同源问题）
	path, ok := userbin.Resolve("tmux")
	if !ok {
		slog.Debug("terminal: tmux not found in PATH or user locations")
		return false
	}

	out, err := exec.Command(path, "-V").Output()
	if err != nil {
		slog.Warn("terminal: tmux -V failed", "err", err)
		return false
	}

	maj, min, ok := ParseTmuxVersion(strings.TrimSpace(string(out)))
	if !ok {
		slog.Warn("terminal: tmux version unparseable", "output", string(out))
		return false
	}

	if maj < tmuxMinMajor || (maj == tmuxMinMajor && min < tmuxMinMinor) {
		slog.Warn("terminal: tmux too old, fallback to native",
			"version", strings.TrimSpace(string(out)),
			"required", fmt.Sprintf("%d.%d+", tmuxMinMajor, tmuxMinMinor))
		return false
	}

	setTmuxResultLocked(true, path, strings.TrimSpace(string(out)))
	slog.Info("terminal: tmux available",
		"version", tmuxVersionStr, "path", path)
	return true
}

// setTmuxResultLocked 写入检测结果（调用方必须持有 tmuxCheckMu）
func setTmuxResultLocked(available bool, bin, version string) {
	tmuxAvailable = available
	tmuxBinary = bin
	tmuxVersionStr = version
}

// resetTmuxCache 清空 tmux 可用性检测结果，强制下次 isTmuxAvailable / GetTmuxInfo 重新探测
// 用于一键安装 tmux 成功后让本进程立即生效，无需重启服务
func resetTmuxCache() {
	tmuxCheckMu.Lock()
	defer tmuxCheckMu.Unlock()
	tmuxChecked = false
	setTmuxResultLocked(false, "", "")
}

// IsTmuxAvailable 公开 wrapper，供 settings API 等外部包调用
func IsTmuxAvailable() bool {
	return isTmuxAvailable()
}

// TmuxInfo 供 settings API 返回的 tmux 状态结构
type TmuxInfo struct {
	Available      bool   `json:"available"`      // 是否安装且版本 >= 3.3
	Version        string `json:"version"`        // tmux -V 输出（如 "tmux 3.4"），未安装时为空
	Path           string `json:"path"`           // tmux 二进制路径，未安装时为空
	Required       string `json:"required"`       // 最低要求版本（如 "3.3+"）
	Installable    bool   `json:"installable"`    // 是否支持一键安装（找到包管理器）
	PkgManager     string `json:"pkgManager"`     // 检测到的包管理器（如 "apt-get"）
	InstallCommand string `json:"installCommand"` // 推荐的安装命令（显示给用户参考）
	ClipboardFloor string `json:"clipboardFloor"` // 剪贴板能力地板（P-20261109-7）：ok/drag-copy/passthrough，未安装或不可解析为空
}

// GetTmuxInfo 返回 tmux 当前状态（已触发检测，调用安全）
func GetTmuxInfo() TmuxInfo {
	isTmuxAvailable() // 触发 lazy init
	pkg, cmd := detectPkgManager()
	return TmuxInfo{
		Available:      tmuxAvailable,
		Version:        tmuxVersionStr,
		Path:           tmuxBinary,
		Required:       fmt.Sprintf("%d.%d+", tmuxMinMajor, tmuxMinMinor),
		Installable:    pkg != "",
		PkgManager:     pkg,
		InstallCommand: cmd,
		// 剪贴板能力地板（P-20261109-7）：本机 tmux 二进制同时服务专属 socket
		// 与外部接管（用户默认 socket），<3.2/<3.3 两档地板提示以此为准；
		// 不可解析为空串（前端静默不显示）
		ClipboardFloor: TmuxClipboardFloorKind(tmuxVersionStr),
	}
}

// mouseSwitchValue mouse 开关的 tmux 字面量（conf 行与 set-option 共用同一拼写）
func mouseSwitchValue(on bool) string {
	if on {
		return "on"
	}
	return "off"
}

// syncTmuxServerOptions 已运行 tmux server 的选项运行同步（backend_tmux.Create
// 每次创建会话时调用；conf 只在 server 启动时读取，运行中的 server 靠这里拿到
// 最新值）。三条与 conf 关键设置一一对应：
//   - history-limit：server option，影响后续新 session 的 scrollback 上限
//   - set-clipboard on（P-20261109-7）：拖选 copy-pipe 源头兜底——<3.2 默认
//     off = 拖选源头即不发 OSC 52（拖选复制死源主因）；旧 tmux（<3.2 无此键）
//     报 unknown option 落 Debug 日志即过，无害；-s server option 只落专有
//     socket（-L codecombo），不影响用户自有 tmux
//   - mouse（P-20261109-7）：全局 session option 逐事件读取——即刻影响现存全部
//     会话，与设置页热切换（ApplyTmuxMouseOption）双路兜底
//
// 首次 Create 时 server 还没启动，set-option 会失败（正常，new-session 启动
// server 时会读 conf 拿到同源值）——失败统一 Debug 日志即过
func syncTmuxServerOptions(historyLimit int, mouseOn bool) {
	if _, err := runTmux("set-option", "-s", "history-limit", strconv.Itoa(historyLimit)); err != nil {
		slog.Debug("terminal: tmux set-option history-limit (server may not be running yet)",
			"err", err)
	}
	if _, err := runTmux("set-option", "-s", "set-clipboard", "on"); err != nil {
		slog.Debug("terminal: tmux set-option set-clipboard (server may not be running yet / tmux <3.2)",
			"err", err)
	}
	if _, err := runTmux("set-option", "-g", "mouse", mouseSwitchValue(mouseOn)); err != nil {
		slog.Debug("terminal: tmux set-option mouse (server may not be running yet)",
			"err", err)
	}
}

// ApplyTmuxMouseOption tmux 鼠标接管热切换（P-20261109-7）：设置页切换后立即
// 对专有 socket（-L codecombo）执行 set-option -g mouse——mouse 是全局 session
// option 且 tmux 逐事件读取，现存全部会话即刻生效（无需重挂）。server 尚未启动
// 时失败落 Debug 日志即过：下次 Create 的运行同步会用新值兜底。Windows stub
// 见 tmux_windows_stub.go（Windows 无 tmux 路径，恒 no-op）
func ApplyTmuxMouseOption(on bool) {
	if _, err := runTmux("set-option", "-g", "mouse", mouseSwitchValue(on)); err != nil {
		slog.Debug("terminal: tmux set-option mouse (server may not be running yet)",
			"on", on, "err", err)
	}
}

// computeTmuxSessionName 生成 tmux session 名: sc-<projectId短哈希>-<6位随机>
// projectId 哈希前缀便于重启恢复时反查项目；末尾随机串避免同项目多终端冲突
func computeTmuxSessionName(projectID string) string {
	return fmt.Sprintf("%s%s-%s", tmuxSessionPrefix, sha256Prefix(projectID, 8), randomAlnum(6))
}

// sha256Prefix 返回 data SHA-256 的前 n 位 hex 字符
// computeTmuxSessionName（生成时）与 projectHashPrefix（恢复时反查）共享此算法
func sha256Prefix(data string, n int) string {
	h := sha256.Sum256([]byte(data))
	return hex.EncodeToString(h[:])[:n]
}

// parseTmuxSessionName 反向解析 tmux session 名
// 返回 projectId 哈希前缀（8 hex）和随机串（6 alnum），无法解析时 ok=false
// Phase 3 重启恢复用
func parseTmuxSessionName(name string) (projHash, randID string, ok bool) {
	m := tmuxSessionNameRe.FindStringSubmatch(name)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// randomAlnum 生成指定长度的随机 a-z0-9 字符串
func randomAlnum(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// 极少数情况；用 pid 兜底
		return fmt.Sprintf("%06d", os.Getpid()%1000000)
	}
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = chars[int(b[i])%len(chars)]
	}
	return string(out)
}

// ============== 会话级环境注入（敏感值不经进程参数） ==============

// tmuxEnvValueSafeRe 可写入 tmux conf 行的值字符集：排除引号/反斜杠/空白与
// #/$/%（# 起注释、% 起指令），conf 按字面解析无展开风险。CC_BASE_URL（http://
// localhost:<port>）、CC_LOCK_TOKEN（sca_+hex）、CC_TERMINAL_ID（sc- 会话名）
// 均在集内；超出集内的值走 argv 直传回退
var tmuxEnvValueSafeRe = regexp.MustCompile(`^[A-Za-z0-9_:./@+-]+$`)

// tmuxSessionEnvConf 生成 source-file 用的会话级 env 写入脚本（每行一条
// set-environment）。ok=false 表示存在安全字符集外的值或键值对畸形，
// 调用方回退 argv 直传
func tmuxSessionEnvConf(session string, kvs []string) (conf string, ok bool) {
	var b strings.Builder
	for _, kv := range kvs {
		i := strings.IndexByte(kv, '=')
		if i <= 0 || !tmuxEnvValueSafeRe.MatchString(kv[i+1:]) {
			return "", false
		}
		fmt.Fprintf(&b, "set-environment -t '%s' -- '%s' '%s'\n", session, kv[:i], kv[i+1:])
	}
	return b.String(), true
}

// setTmuxSessionEnv 批量写 tmux 会话级环境变量（CC_LOCK_TOKEN 等敏感注入）。
// 值不进任何进程参数：set-environment 的值若放 argv，会在短命客户端进程的
// /proc/<pid>/cmdline 上留下竞读窗口（ps 快照/审计日志可见）。改为写入
// 0700 私有临时目录下的 0600 conf 文件，tmux source-file 由 server 端读取，
// 客户端退出（服务端已读完）后整目录即删。值含意外字符或临时文件不可用时
// 回退 argv 直传——保持旧行为可用，仅失去该加固
func setTmuxSessionEnv(session string, kvs []string) {
	if len(kvs) == 0 {
		return
	}
	if conf, ok := tmuxSessionEnvConf(session, kvs); ok && setTmuxSessionEnvFile(conf) {
		return
	}
	for _, kv := range kvs {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		if _, err := runTmux("set-environment", "-t", session, "--", kv[:i], kv[i+1:]); err != nil {
			slog.Warn("terminal: tmux set-environment failed", "err", err)
		}
	}
}

// setTmuxSessionEnvFile 把 conf 内容经 0600 临时文件 source-file 下发。
// source-file 失败也返回 true：同因重试 argv 直传大概率同败，且不得为重试
// 把敏感值放回 argv；失败已由调用方记日志
func setTmuxSessionEnvFile(conf string) bool {
	dir, err := os.MkdirTemp("", "sc-tmuxenv-")
	if err != nil {
		slog.Warn("terminal: tmux env temp dir failed", "err", err)
		return false
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "env.conf")
	if err := os.WriteFile(path, []byte(conf), 0o600); err != nil {
		slog.Warn("terminal: tmux env temp file failed", "err", err)
		return false
	}
	if _, err := runTmux("source-file", path); err != nil {
		slog.Warn("terminal: tmux source-file env failed", "err", err)
	}
	return true
}
