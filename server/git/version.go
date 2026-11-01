package git

// 本机 git 工具链版本探测（环境体检 P-20261003-317 用）：与仓库无关的全局读
// 命令，workDir 空串 = 进程 CWD。走 execGitProbe（探测语义——git 未安装是体检
// 结论而非命令错误，不向前端命令台广播失败，与 config --get 未配置键同款豁免）

// GitVersionOutput 返回 `git --version` 输出（如 "git version 2.51.0"）。
// 环境体检「git 工具链」条目的事实源
func GitVersionOutput() (string, error) {
	return execGitProbe("", "--version")
}

// LfsVersionOutput 返回 `git lfs version` 输出（如 "git-lfs/3.7.0 ..."）。
// git 内建 lfs 子命令缺失（未装 git-lfs）时 exec 报非零退出，体检据此判
// 「未安装」；LFS 可选（仅 LFS 仓库需要），条目降级为警告而非失败
func LfsVersionOutput() (string, error) {
	return execGitProbe("", "lfs", "version")
}
