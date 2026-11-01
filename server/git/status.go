package git

import (
	"path/filepath"
	"strings"

	"codecombo/server/model"
)

// 获取工作区文件状态
func GetStatus(repoPath string) ([]model.FileStatus, error) {
	// 使用porcelain=v2格式获取结构化输出
	output, err := execGit(repoPath, "status", "--porcelain=v2", "--branch")
	if err != nil {
		return nil, err
	}

	return parseStatus(output), nil
}

func parseStatus(output string) []model.FileStatus {
	var files []model.FileStatus
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		if len(line) < 2 {
			continue
		}

		switch line[0] {
		case '1': // 普通变更
			files = append(files, parseOrdinaryEntry(line))
		case '2': // 重命名/复制
			files = append(files, parseRenameEntry(line))
		case 'u': // 未合并
			files = append(files, parseUnmergedEntry(line))
		case '?': // 未跟踪
			path := strings.TrimPrefix(line, "? ")
			files = append(files, model.FileStatus{
				Path:   filepath.ToSlash(path),
				Status: "Untracked",
				Staged: false,
			})
		case '!': // 忽略
			// 跳过忽略的文件
		}
	}

	return files
}

// 解析普通变更行
// 格式: 1 XY sub perm_h perm_i oid_h oid_i path
func parseOrdinaryEntry(line string) model.FileStatus {
	if len(line) < 3 {
		return model.FileStatus{}
	}

	xy := line[2:4]
	path := ""
	if len(line) > 113 {
		path = line[113:]
	} else {
		parts := strings.Fields(line)
		if len(parts) >= 9 {
			path = parts[8]
		}
	}

	staged, status := parseXY(xy)

	return model.FileStatus{
		Path:   filepath.ToSlash(path),
		Status: status,
		Staged: staged,
	}
}

// 解析重命名行
// 格式: 2 XY sub perm_h perm_i oid_h oid_i R orig_path path
func parseRenameEntry(line string) model.FileStatus {
	parts := strings.Fields(line)
	if len(parts) < 10 {
		return model.FileStatus{}
	}

	// porcelain v2 的 `2` 行首字段恒为字面量 "2"，XY 是第二个字段——此前取
	// parts[0][2:4] 对长度 1 的 "2" 切片越界 panic（暂存任何 rename 即触发，
	// ListFileTree/GetStatus 全链 500），回归见 TestParseRenameEntry
	if len(parts[1]) < 2 {
		return model.FileStatus{}
	}
	xy := parts[1]
	staged, status := parseXY(xy)

	origPath := parts[len(parts)-2]
	newPath := parts[len(parts)-1]

	return model.FileStatus{
		Path:    filepath.ToSlash(newPath),
		Status:  status,
		Staged:  staged,
		OldPath: filepath.ToSlash(origPath),
	}
}

// 解析未合并行（porcelain v2 格式: u XY sub m1 m2 m3 mW h1 h2 h3 path）
func parseUnmergedEntry(line string) model.FileStatus {
	// 路径取自定长前缀之后（161 字符 = 'u '+XY+' '+sub(4)+' '+三段 stage mode
	// (6×3)+' '+工作区 mode(6)+' '+三个 40 位 stage hash+' '，与 parseOrdinaryEntry
	// 的 line[113:] 同法）——此前 Fields 取 parts[8] 实为第二条 stage hash h2，
	// 冲突文件在变更树里显示成裸 SHA（P-20261003-136 冲突 chip 聚焦时首当其冲）
	const pathOffset = 161
	var path string
	if len(line) > pathOffset {
		path = line[pathOffset:]
	} else {
		parts := strings.Fields(line)
		if len(parts) >= 11 {
			path = parts[10]
		}
	}

	return model.FileStatus{
		Path:   filepath.ToSlash(path),
		Status: "Unmerged",
		Staged: false,
	}
}

// 解析XY状态码
func parseXY(xy string) (staged bool, status string) {
	x := xy[0]
	y := xy[1]

	switch {
	case x == 'M':
		return true, "Modified"
	case x == 'A':
		return true, "Added"
	case x == 'D':
		return true, "Deleted"
	case x == 'R':
		return true, "Renamed"
	case x == 'C':
		return true, "Copied"
	case y == 'M':
		return false, "Modified"
	case y == 'D':
		return false, "Deleted"
	default:
		return false, "Modified"
	}
}

// 获取被gitignore忽略的文件和目录路径集合
func GetIgnoredFiles(repoPath string) (map[string]bool, error) {
	output, err := execGit(repoPath, "ls-files", "--ignored", "--exclude-standard", "-o", "--directory")
	if err != nil {
		return nil, err
	}

	ignored := make(map[string]bool)
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// --directory 返回的目录带末尾 /
		line = strings.TrimRight(line, "/")
		ignored[filepath.ToSlash(line)] = true
	}
	return ignored, nil
}

// 获取当前分支名
func GetCurrentBranch(repoPath string) (string, error) {
	output, err := execGit(repoPath, "branch", "--show-current")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
}

// 获取远程仓库URL
func GetRemoteURL(repoPath string) (string, error) {
	output, err := execGit(repoPath, "remote", "get-url", "origin")
	if err != nil {
		// 没有origin远程仓库时返回空
		return "", nil
	}
	return strings.TrimSpace(output), nil
}

// 获取完整的仓库信息（状态、分支、远程）
func GetRepoInfo(repoPath string) (*model.Project, []model.FileStatus, error) {
	branch, _ := GetCurrentBranch(repoPath)
	remoteURL, _ := GetRemoteURL(repoPath)
	status, err := GetStatus(repoPath)
	if err != nil {
		return nil, nil, err
	}

	project := &model.Project{
		Path:          repoPath,
		CurrentBranch: branch,
		RemoteURL:     remoteURL,
	}

	return project, status, nil
}
