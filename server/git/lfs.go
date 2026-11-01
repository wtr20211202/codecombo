package git

import (
	"strings"
)

// LfsTrack 表示一个 LFS 追踪规则
type LfsTrack struct {
	Pattern string `json:"pattern"`
	Locking bool   `json:"locking"`
}

// LfsStatus 表示 LFS 文件状态
type LfsFileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"` // downloaded, pending, error
}

// LfsIsInstalled 检查 git-lfs 是否已安装
func LfsIsInstalled(repoPath string) bool {
	_, err := execGit(repoPath, "lfs", "version")
	return err == nil
}

// LfsInstall 初始化 LFS
func LfsInstall(repoPath string) error {
	_, err := execGit(repoPath, "lfs", "install")
	return err
}

// LfsGetTracks 获取 LFS 追踪规则
func LfsGetTracks(repoPath string) ([]LfsTrack, error) {
	output, err := execGit(repoPath, "lfs", "track")
	if err != nil {
		return nil, err
	}

	var tracks []LfsTrack
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Listing") || strings.HasPrefix(line, "Git") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 1 {
			track := LfsTrack{
				Pattern: parts[0],
			}
			if len(parts) >= 2 && parts[1] == "(locked)" {
				track.Locking = true
			}
			tracks = append(tracks, track)
		}
	}
	return tracks, nil
}

// LfsAddTrack 添加 LFS 追踪规则
func LfsAddTrack(repoPath string, pattern string) error {
	_, err := execGit(repoPath, "lfs", "track", pattern)
	return err
}

// LfsUntrack 移除 LFS 追踪规则
func LfsUntrack(repoPath string, pattern string) error {
	_, err := execGit(repoPath, "lfs", "untrack", pattern)
	return err
}

// LfsPull 拉取 LFS 文件
// 远程操作：私有仓库的 LFS 文件需要凭据，用 execGitWithAuth 注入
func LfsPull(repoPath string) error {
	_, err := execGitWithAuth(repoPath, "origin", "lfs", "pull")
	return err
}

// LfsPush 推送 LFS 文件
// 远程操作：注入凭据
func LfsPush(repoPath string) error {
	_, err := execGitWithAuth(repoPath, "origin", "lfs", "push", "--all", "origin")
	return err
}

// LfsFetch 获取 LFS 文件
// 远程操作：注入凭据
func LfsFetch(repoPath string) error {
	_, err := execGitWithAuth(repoPath, "origin", "lfs", "fetch")
	return err
}

// LfsStatus 获取 LFS 状态
func LfsStatus(repoPath string) ([]LfsFileStatus, error) {
	output, err := execGit(repoPath, "lfs", "status")
	if err != nil {
		return nil, err
	}

	// 简单解析
	var statuses []LfsFileStatus
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "->") {
			parts := strings.SplitN(line, "->", 2)
			if len(parts) == 2 {
				statuses = append(statuses, LfsFileStatus{
					Path:   strings.TrimSpace(parts[0]),
					Status: strings.TrimSpace(parts[1]),
				})
			}
		}
	}
	return statuses, nil
}
