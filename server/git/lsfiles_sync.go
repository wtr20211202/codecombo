package git

// 多实例项目同步的 git 感知枚举（P-20261023-1）：sync 模块需要「tracked +
// 未忽略 untracked」全集（.gitignore 排除的单一事实源）与「被忽略顶层条目」
// 计数。收口在 git 包内经 execGitProbe 执行——与其他全部 git 子进程启动点
// 同走全局并发闸（P-20261004-125）与静默探测语义（枚举是后台面，不向前端
// 命令台广播），不新增裸 exec 点。参数面固定三条命令，不开放透传。

// SyncListMode ls-files 枚举档位（sync 模块专用，参数面固定防透传注入）
type SyncListMode int

const (
	// SyncListTracked tracked + 未忽略 untracked（.gitignore 感知排除的包含集）
	SyncListTracked SyncListMode = iota
	// SyncListAll tracked + 全部 untracked（「含被忽略文件」档的包含集）
	SyncListAll
	// SyncListIgnoredTop 被忽略顶层条目（--directory，忽略目录整枝计 1；
	// manifest「已排除 N 项」展示计数）
	SyncListIgnoredTop
)

// LsFilesForSync 以 NUL 分隔形态枚举工作区文件（-z 防 quotePath 八进制转义
// 路径打不开文件，patch.go untrackedPatchSegments 同法）。探测语义：失败返回
// err 且调用方回落本地走树（枚举永不因工具缺失而失败——降级可用优于拒绝）
func LsFilesForSync(workDir string, mode SyncListMode) (string, error) {
	var args []string
	switch mode {
	case SyncListTracked:
		args = []string{"ls-files", "-z", "--cached", "--others", "--exclude-standard"}
	case SyncListAll:
		args = []string{"ls-files", "-z", "--cached", "--others"}
	case SyncListIgnoredTop:
		args = []string{"ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"}
	default:
		return "", errInvalidSyncListMode
	}
	return execGitProbe(workDir, append(gitLongPathsArgs(), args...)...)
}

type syncListModeError string

func (e syncListModeError) Error() string { return string(e) }

const errInvalidSyncListMode = syncListModeError("git: invalid ls-files mode")
