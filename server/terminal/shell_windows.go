//go:build windows

package terminal

import (
	"log/slog"
	"os"
	"os/exec"
)

// osShellEnv Windows 无 $SHELL 惯例（环境里偶见的同名变量指向 unix 侧路径，
// 不是本机可启动 shell），返回空串跳过该候选来源
func osShellEnv() string { return "" }

// shellCandidateNames Windows 候选序：pwsh（PowerShell 7）→ powershell
// （Windows PowerShell）→ cmd → bash（git-bash / 其他 MSYS 形态）。bash 排
// 最后：PATH 里它可能是 WSL 启动器（System32\bash.exe），由 LookPath 的实际
// 命中路径如实呈现，可用性判断交给探测而非臆测
func shellCandidateNames() []string {
	return []string{"pwsh", "powershell", "cmd", "bash"}
}

// platformDefaultShell 平台缺省 shell（历史 getShell 的 Windows 分支原样保留）：
// 优先 PowerShell 7 (pwsh)，其次 Windows PowerShell，最后 COMSPEC（缺省 cmd.exe）
func platformDefaultShell() string {
	for _, name := range []string{"pwsh", "powershell"} {
		if path, err := exec.LookPath(name); err == nil {
			slog.Debug("terminal: selected shell", "name", name, "path", path)
			return name
		}
	}
	shell := os.Getenv("COMSPEC")
	if shell == "" {
		shell = "cmd.exe"
	}
	slog.Warn("terminal: fallback shell", "shell", shell)
	return shell
}
