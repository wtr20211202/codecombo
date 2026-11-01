//go:build !windows

package terminal

import (
	"os"
)

// osShellEnv 当前用户的登录 shell（unix 惯例）：非空时作为候选清单首位——
// 用户默认环境的第一语义，排在具名候选之前
func osShellEnv() string {
	return os.Getenv("SHELL")
}

// shellCandidateNames unix 具名候选：三大主流交互 shell。$SHELL 由
// ShellCandidates 经 osShellEnv 单独并入（可能指向不在清单内的 shell，
// 如 nushell），与本清单并集去重
func shellCandidateNames() []string {
	return []string{"bash", "zsh", "fish"}
}

// platformDefaultShell 平台缺省 shell（历史 getShell 的 unix 分支原样保留）：
// $SHELL 缺省回落 bash
func platformDefaultShell() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "bash"
	}
	return shell
}
