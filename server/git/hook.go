package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// GitHook 表示一个 Git hook
type GitHook struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	Content string `json:"content"`
}

// GetHooksPath 获取 hooks 目录路径
func GetHooksPath(repoPath string) string {
	hooksDir, err := execGit(repoPath, "rev-parse", "--git-path", "hooks")
	if err != nil {
		// 回退到默认路径
		return filepath.Join(repoPath, ".git", "hooks")
	}
	hooksDir = strings.TrimSpace(hooksDir)
	// --git-path 的输出是相对 git 进程 CWD（= repoPath）的相对路径（标准仓库
	// 返回 ".git/hooks"）。必须锚定回仓库绝对路径——否则后续读写会落在服务
	// 进程 CWD 下的同名目录，钩子被误写到别的仓库（实测曾写入服务自身仓库）
	if !filepath.IsAbs(hooksDir) {
		hooksDir = filepath.Join(repoPath, hooksDir)
	}
	return hooksDir
}

// ListHooks 列出所有 Git hooks
func ListHooks(repoPath string) ([]GitHook, error) {
	hooksDir := GetHooksPath(repoPath)

	hookNames := []string{
		"pre-commit", "commit-msg", "prepare-commit-msg",
		"post-commit", "pre-push", "pre-rebase",
		"post-merge", "post-checkout",
	}

	var hooks []GitHook
	for _, name := range hookNames {
		hook := GitHook{Name: name}
		hookPath := filepath.Join(hooksDir, name)

		content, err := os.ReadFile(hookPath)
		if err == nil {
			hook.Enabled = true
			hook.Content = string(content)
		}
		// 也检查 .sample 文件
		if !hook.Enabled {
			samplePath := hookPath + ".sample"
			sampleContent, err := os.ReadFile(samplePath)
			if err == nil {
				hook.Content = string(sampleContent)
			}
		}

		hooks = append(hooks, hook)
	}

	return hooks, nil
}

// GetHookContent 获取单个 hook 的内容
func GetHookContent(repoPath string, name string) (string, error) {
	hooksDir := GetHooksPath(repoPath)
	hookPath := filepath.Join(hooksDir, name)

	content, err := os.ReadFile(hookPath)
	if err != nil {
		// 尝试 .sample
		content, err = os.ReadFile(hookPath + ".sample")
		if err != nil {
			return "", fmt.Errorf("hook %s not found", name)
		}
	}
	return string(content), nil
}

// UpdateHook 更新 hook 内容
func UpdateHook(repoPath string, name string, content string, enabled bool) error {
	hooksDir := GetHooksPath(repoPath)

	// 确保目录存在
	if err := os.MkdirAll(hooksDir, 0755); err != nil {
		return err
	}

	hookPath := filepath.Join(hooksDir, name)

	if !enabled {
		// 禁用: 移除执行权限
		_ = os.Chmod(hookPath, 0644)
		// 或者重命名
		return nil
	}

	// CRLF 归一化：Windows/浏览器侧带入的 \r\n 会损坏 shebang
	//（Linux 报 "bad interpreter: /bin/sh\r"），统一 LF 落盘
	content = strings.ReplaceAll(content, "\r\n", "\n")

	// 写入并设置可执行权限
	if err := os.WriteFile(hookPath, []byte(content), 0755); err != nil {
		return err
	}
	// os.WriteFile 对已存在文件不改变权限位：先禁用（0644）再启用的 hook
	// 会保持无执行位而静默不执行（Linux 真实缺陷），显式 Chmod 兜住
	if err := os.Chmod(hookPath, 0755); err != nil {
		return err
	}

	return nil
}

// DeleteHook 删除 hook
func DeleteHook(repoPath string, name string) error {
	hooksDir := GetHooksPath(repoPath)
	hookPath := filepath.Join(hooksDir, name)
	return os.Remove(hookPath)
}
