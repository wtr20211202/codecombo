package terminal

import (
	"fmt"
	"log/slog"
	"os/exec"
	"strings"

	"codecombo/server/store"
)

// 终端 shell 选择（P-20261004-57）：
//   - 设置项 terminal.defaultShell（ServerConfig.TerminalDefaultShell）：用户
//     固定的默认 shell，getShell()（manager.go）优先采用；未配置或配置的
//     shell 已不可解析（被卸载/改名）时回落平台硬编码序（platformDefaultShell，
//     见 shell_windows.go / shell_unix.go）——存量行为零变化
//   - 会话级覆盖：POST /api/terminals 携 shell 字段（纯终端会话），优先级
//     会话覆盖 > 设置 > 平台默认（ResolveSessionShell）
//   - 候选探测：ShellCandidates 按平台枚举候选并 LookPath 标注可用性，供
//     设置页下拉与会话创建对话框渲染

// configuredShell 读取设置里的默认 shell，仅在 LookPath 可解析时返回非空——
// 「配置先于环境消失」时不阻塞会话创建，降级平台默认并告警（排障锚点）
func configuredShell() string {
	st := store.Get()
	if st == nil {
		return ""
	}
	cfg := st.Settings.Get()
	if cfg == nil {
		return ""
	}
	v := strings.TrimSpace(cfg.Server.TerminalDefaultShell)
	if v == "" {
		return ""
	}
	if _, err := exec.LookPath(v); err != nil {
		slog.Warn("terminal: configured default shell not resolvable, falling back to platform default",
			"shell", v, "err", err)
		return ""
	}
	return v
}

// ValidateShellPath 会话/设置写入端的 shell 存在性校验：LookPath 同时覆盖
// 裸名（沿 PATH 搜）与含分隔符的路径（直接验文件）。失败返回错误原文供
// HTTP 400（显式选择的 shell 不存在时明确报错优于静默换 shell）
func ValidateShellPath(shell string) error {
	v := strings.TrimSpace(shell)
	if v == "" {
		return fmt.Errorf("shell is empty")
	}
	if _, err := exec.LookPath(v); err != nil {
		return fmt.Errorf("shell not found: %s", v)
	}
	return nil
}

// ResolveSessionShell 会话级 shell 覆盖解析（优先级：会话覆盖 > 设置 > 平台
// 默认）：override 非空且可解析 → 用之；空或失效 → getShell()。API 层已对
// 显式覆盖做过 400 校验，此处再验一次是纵深防御（覆盖值失效宁可回落默认也
// 不让会话起不来）
func ResolveSessionShell(override string) string {
	v := strings.TrimSpace(override)
	if v == "" {
		return getShell()
	}
	if _, err := exec.LookPath(v); err != nil {
		slog.Warn("terminal: session shell override not resolvable, falling back",
			"shell", v, "err", err)
		return getShell()
	}
	return v
}

// ShellCandidateInfo 平台 shell 候选行（GET /api/terminals/shell-candidates 出参）
type ShellCandidateInfo struct {
	// Name 候选键（pwsh/powershell/cmd/bash/zsh/fish/$SHELL）
	Name string `json:"name"`
	// Path LookPath 解析出的完整路径；未检测到为空
	Path string `json:"path"`
	// Available 该候选在本机是否可启动（LookPath 命中）
	Available bool `json:"available"`
}

// ShellCandidates 平台候选探测：候选序见 shell_windows.go / shell_unix.go，
// 逐个 LookPath；unix 侧额外并入 $SHELL（用户登录 shell 恒为首选语义）。
// 按 LookPath 解析路径去重——$SHELL 与具名候选常指向同一二进制，重复条目
// 只会让下拉出现两行同值。候选数 ≤5，每次调用一次全量探测：设置页/对话框
// 打开时取一次，非热路径
func ShellCandidates() []ShellCandidateInfo {
	seen := map[string]bool{}
	out := make([]ShellCandidateInfo, 0, 5)
	add := func(name string) {
		path := ""
		if p, err := exec.LookPath(name); err == nil {
			path = p
		}
		key := path
		if key == "" {
			key = "\x00" + name // 未命中的候选按名字去重（多平台同名不重复出行）
		}
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, ShellCandidateInfo{Name: name, Path: path, Available: path != ""})
	}
	if shell := osShellEnv(); shell != "" {
		add(shell)
	}
	for _, name := range shellCandidateNames() {
		add(name)
	}
	return out
}
