//go:build !windows

package terminal

import (
	"fmt"
	"os"
	"os/exec"
)

// pkgManagerCandidates 包管理器候选，按常见度排序
// bin: 二进制名；args: 安装 tmux 的完整参数（不含 bin 本身）
var pkgManagerCandidates = []struct {
	bin  string
	args []string
}{
	{"apt-get", []string{"install", "-y", "tmux"}},
	{"apt", []string{"install", "-y", "tmux"}},
	{"dnf", []string{"install", "-y", "tmux"}},
	{"yum", []string{"install", "-y", "tmux"}},
	{"pacman", []string{"-S", "--noconfirm", "tmux"}},
	{"apk", []string{"add", "tmux"}},
	{"brew", []string{"install", "tmux"}},
	{"zypper", []string{"install", "-y", "tmux"}},
	{"pkg", []string{"install", "-y", "tmux"}}, // FreeBSD
}

// detectPkgManager 返回当前系统可用的包管理器 bin 名（无则空字符串）
// 以及推荐的安装命令字符串（用于前端展示）
func detectPkgManager() (bin string, cmd string) {
	for _, pm := range pkgManagerCandidates {
		if _, err := exec.LookPath(pm.bin); err == nil {
			// 拼接完整命令字符串供 UI 展示
			full := pm.bin + " " + joinArgs(pm.args)
			if needsSudo(pm.bin) {
				full = "sudo " + full
			}
			return pm.bin, full
		}
	}
	return "", ""
}

// needsSudo 判断该包管理器是否需要 root 权限（macOS brew 不需要）
func needsSudo(bin string) bool {
	return bin != "brew"
}

func joinArgs(args []string) string {
	out := ""
	for i, a := range args {
		if i > 0 {
			out += " "
		}
		out += a
	}
	return out
}

// InstallTmuxResult 安装结果
type InstallTmuxResult struct {
	Success   bool   `json:"success"`
	Command   string `json:"command"`   // 实际执行的命令
	Output    string `json:"output"`    // 命令输出（stdout+stderr 合并）
	NeedsSudo bool   `json:"needsSudo"` // 是否因权限失败需要 sudo
}

// InstallTmux 检测包管理器并执行 tmux 安装
//
// 行为：
//   - 找到包管理器后直接执行（best-effort）
//   - 若当前进程非 root 且包管理器需要 root（apt/yum 等），命令会失败
//     返回 NeedsSudo=true，前端提示用户用 sudo 启动 simple-coding 或手动执行
//   - macOS brew 不需要 root，可直接成功
//   - 安装成功后自动重置 isTmuxAvailable 缓存，本进程内立即生效，无需重启服务
func InstallTmux() (InstallTmuxResult, error) {

	for _, pm := range pkgManagerCandidates {
		if _, err := exec.LookPath(pm.bin); err != nil {
			continue
		}
		// 检查是否需要 sudo（当前非 root 且包管理器需要 root）
		needSudo := needsSudo(pm.bin) && os.Getuid() != 0
		cmdDesc := pm.bin + " " + joinArgs(pm.args)
		if needSudo {
			// 不直接 sudo（交互式密码无法处理），返回提示
			return InstallTmuxResult{
				Success:   false,
				Command:   "sudo " + cmdDesc,
				Output:    "",
				NeedsSudo: true,
			}, nil
		}
		cmd := exec.Command(pm.bin, pm.args...)
		out, err := cmd.CombinedOutput()
		if err == nil {
			// 安装成功后清空缓存，下次 isTmuxAvailable / GetTmuxInfo 自动重新检测
			resetTmuxCache()
		}
		return InstallTmuxResult{
			Success:   err == nil,
			Command:   cmdDesc,
			Output:    string(out),
			NeedsSudo: false,
		}, err
	}
	return InstallTmuxResult{}, fmt.Errorf("no supported package manager found (apt/yum/dnf/pacman/apk/brew)")
}
