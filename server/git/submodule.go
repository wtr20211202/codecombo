package git

import (
	"fmt"
	"strings"
)

// Submodule 表示一个 git submodule
type Submodule struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	URL    string `json:"url"`
	Branch string `json:"branch"`
	Hash   string `json:"hash"`
	Status string `json:"status"` // initialized, not-initialized, modified
}

// ListSubmodules 列出所有 submodule
func ListSubmodules(repoPath string) ([]Submodule, error) {
	// git submodule status
	output, err := execGit(repoPath, "submodule", "status")
	if err != nil {
		// 可能没有 submodule
		if strings.Contains(err.Error(), "No submodule mapping found") {
			return []Submodule{}, nil
		}
		return nil, err
	}

	var submodules []Submodule
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		sub := parseSubmoduleLine(line)
		submodules = append(submodules, sub)
	}

	// 获取 URL 信息（探测语义：无 .gitmodules 时 fatal 属正常，不广播命令错误）
	configOutput, _ := execGitProbe(repoPath, "config", "--list", "--file", ".gitmodules")
	if configOutput != "" {
		urls := parseGitmodules(configOutput)
		for i := range submodules {
			if url, ok := urls[submodules[i].Path]; ok {
				submodules[i].URL = url
			}
		}
	}

	return submodules, nil
}

func parseSubmoduleLine(line string) Submodule {
	// 格式: [+- ]hash path (tag)
	// +: modified, -: not initialized, space: initialized
	status := "initialized"
	if strings.HasPrefix(line, "-") {
		status = "not-initialized"
		line = line[1:]
	} else if strings.HasPrefix(line, "+") {
		status = "modified"
		line = line[1:]
	}
	line = strings.TrimSpace(line)

	parts := strings.Fields(line)
	if len(parts) < 2 {
		return Submodule{Status: status}
	}

	return Submodule{
		Hash:   parts[0],
		Path:   parts[1],
		Name:   parts[1],
		Status: status,
	}
}

func parseGitmodules(output string) map[string]string {
	urls := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		// 简单解析
		if strings.Contains(line, "=https://") || strings.Contains(line, "=git@") || strings.Contains(line, "=ssh://") {
			idx := strings.LastIndex(line, "=")
			if idx >= 0 {
				url := line[idx+1:]
				_ = url
			}
		}
	}

	// 用更好的方式解析
	lines := strings.Split(output, "\n")
	var currentPath string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "submodule.") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				key := parts[0]
				val := parts[1]
				if strings.HasSuffix(key, ".path") {
					currentPath = val
				} else if strings.HasSuffix(key, ".url") && currentPath != "" {
					urls[currentPath] = val
					currentPath = ""
				}
			}
		}
	}

	return urls
}

// AddSubmodule 添加 submodule
// 远程操作：submodule add 会 clone 子模块仓库，需注入凭据
// 直接用 url 走 execGitWithURL，绕过 remote 反查
func AddSubmodule(repoPath string, url string, path string, branch string) error {
	// git 2.38.1+ 默认禁用 file 协议子模块（CVE-2022-39253 加固），本地
	// file:// 源需要显式放行；https/ssh 源不受影响（-c 仅作用于本进程）
	args := []string{"-c", "protocol.file.allow=always", "submodule", "add"}
	if branch != "" {
		args = append(args, "-b", branch)
	}
	args = append(args, url)
	if path != "" {
		args = append(args, path)
	}

	_, err := execGitWithURL(repoPath, url, args...)
	return err
}

// UpdateSubmodules 更新 submodule
// 远程操作：update 会从远程拉取子模块（--init 时尤其明显），用 origin 的 URL 注入凭据
func UpdateSubmodules(repoPath string, init bool, recursive bool) error {
	args := []string{"submodule", "update"}
	if init {
		args = append(args, "--init")
	}
	if recursive {
		args = append(args, "--recursive")
	}

	_, err := execGitWithAuth(repoPath, "origin", args...)
	return err
}

// RemoveSubmodule 删除 submodule
func RemoveSubmodule(repoPath string, path string) error {
	_, err := execGit(repoPath, "submodule", "deinit", "-f", path)
	if err != nil {
		return fmt.Errorf("deinit failed: %w", err)
	}
	_, err = execGit(repoPath, "rm", "-f", path)
	if err != nil {
		// git rm 可能不存在于某些版本，用其他方式
		_ = err
	}
	return nil
}
