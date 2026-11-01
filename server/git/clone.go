package git

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CloneRepo 克隆远程仓库到指定目录
func CloneRepo(url string, destDir string, branch string, depth int) (string, error) {
	// 如果目标目录不存在则创建
	if destDir == "" {
		// 从 URL 推断目录名
		parts := strings.Split(url, "/")
		name := parts[len(parts)-1]
		name = strings.TrimSuffix(name, ".git")
		// 使用当前工作目录
		dir, _ := os.Getwd()
		destDir = filepath.Join(dir, name)
	}

	args := []string{"clone", url, destDir}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	if depth > 0 {
		args = append(args, "--depth", fmt.Sprintf("%d", depth))
	}
	args = append(args, "--progress")

	_, err := execGit("", args...)
	if err != nil {
		return "", err
	}

	return destDir, nil
}

// setBranchUpstream 在克隆后显式设置当前分支跟踪远程上游。
// 如果 branch 已指定则跟踪 origin/<branch>，否则自动检测当前分支并跟踪对应的远程分支。
func setBranchUpstream(destDir, branch string) error {
	// 获取当前检出的分支名
	current, err := execGit(destDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return err
	}
	current = strings.TrimSpace(current)

	// 如果未指定分支且当前分支不存在于远程（如克隆空仓库），跳过
	if branch == "" {
		branch = current
	}

	// 显式设置上游跟踪（git clone 已默认设置，此处作为安全兜底）
	_, err = execGit(destDir, "branch", "--set-upstream-to=origin/"+branch, current)
	return err
}

// CloneRepoStreaming 流式克隆远程仓库，每行进度回调 onLine，支持 context 取消。
// extraEnv 用于注入 GIT_ASKPASS / SC_USER / SC_PASS 等凭据相关环境变量。
// 调用方需保证 destDir 非空（POST /api/clone handler 已做目录预检，
// P-20261003-26；其余调用方自行保证）。
func CloneRepoStreaming(ctx context.Context, url, destDir, branch string, depth int, extraEnv []string, onLine func(string)) (string, error) {
	args := []string{"clone", url, destDir, "--progress"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	if depth > 0 {
		args = append(args, "--depth", fmt.Sprintf("%d", depth))
	}
	err := execGitStreaming(ctx, "", onLine, extraEnv, args...)
	return destDir, err
}
