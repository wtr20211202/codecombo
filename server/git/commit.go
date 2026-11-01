package git

import (
	"codecombo/server/model"
	"fmt"
	"strings"
)

// 暂存文件
func Stage(repoPath string, files []string) error {
	args := append([]string{"add", "--"}, files...)
	_, err := execGit(repoPath, args...)
	return err
}

// 取消暂存文件
func Unstage(repoPath string, files []string) error {
	args := append([]string{"reset", "HEAD", "--"}, files...)
	_, err := execGit(repoPath, args...)
	return err
}

// 暂存所有变更
func StageAll(repoPath string) error {
	_, err := execGit(repoPath, "add", "-A")
	return err
}

// 提交
func Commit(repoPath string, req model.CommitRequest) (string, error) {
	// 先暂存指定文件
	if len(req.Files) > 0 {
		if err := Stage(repoPath, req.Files); err != nil {
			return "", err
		}
	}

	args := []string{"commit", "-m", req.Message}
	if req.Amend {
		args = append(args, "--amend", "--no-edit")
	}
	if req.Signoff {
		args = append(args, "--signoff")
	}
	if req.Author != "" {
		args = append(args, "--author", req.Author)
	}

	output, err := execGit(repoPath, args...)
	if err != nil {
		return "", err
	}
	return output, nil
}

// 修改最近一次提交的信息
func AmendMessage(repoPath string, newMessage string) error {
	_, err := execGit(repoPath, "commit", "--amend", "-m", newMessage)
	return err
}

// 回滚文件变更（ref 缺省 = HEAD，既有整文件回滚语义；非空 = 检出该提交的
// 文件版本进工作区——P-20261008-11 文件历史时间线 git 条目的恢复动作，与
// 整文件回滚同为改写工作区的高危写，确认闸在调用方 UI）。ref 拼在 `--` 之前，
// 必须先过形态闸：拒绝 '-' 开头（git 会按 flag 解析）与空白/控制字符——
// 不做存在性校验，不存在的 ref 由 git 自身报错原样上抛
func Rollback(repoPath string, files []string, ref string) error {
	if strings.TrimSpace(ref) == "" {
		ref = "HEAD"
	}
	if strings.HasPrefix(ref, "-") || strings.ContainsFunc(ref, func(r rune) bool {
		return r <= ' ' || r == 0x7f
	}) {
		return fmt.Errorf("invalid ref %q", ref)
	}
	args := append([]string{"checkout", ref, "--"}, files...)
	_, err := execGit(repoPath, args...)
	return err
}

// SquashCommits 将多个连续提交合并为一个
// commits 按从新到旧排列，将它们全部合并为一个提交
func SquashCommits(repoPath string, commits []string, message string) error {
	if len(commits) < 2 {
		return fmt.Errorf("至少需要2个提交才能squash")
	}

	// 获取最旧提交的父提交
	oldestHash := commits[len(commits)-1]
	parentLine, err := execGit(repoPath, "rev-parse", oldestHash+"^")
	if err != nil {
		return fmt.Errorf("获取父提交失败: %v", err)
	}
	parentHash := strings.TrimSpace(parentLine)

	// soft reset 到最旧提交的父提交
	_, err = execGit(repoPath, "reset", "--soft", parentHash)
	if err != nil {
		return fmt.Errorf("soft reset 失败: %v", err)
	}

	// 创建新的合并提交
	if message == "" {
		message = fmt.Sprintf("squash: %d commits combined", len(commits))
	}
	_, err = execGit(repoPath, "commit", "-m", message)
	if err != nil {
		return fmt.Errorf("创建合并提交失败: %v", err)
	}

	return nil
}

// DropCommit 删除指定提交（不创建revert提交）
func DropCommit(repoPath string, commit string) error {
	// 获取提交的父提交
	parentLine, err := execGit(repoPath, "rev-parse", commit+"^")
	if err != nil {
		return fmt.Errorf("获取父提交失败: %v", err)
	}
	parentHash := strings.TrimSpace(parentLine)

	// 使用 rebase --onto 删除该提交
	// git rebase --onto <parent> <commit> HEAD
	_, err = execGit(repoPath, "rebase", "--onto", parentHash, commit, "HEAD")
	if err != nil {
		return fmt.Errorf("drop commit 失败: %v", err)
	}

	return nil
}

// GetDirectoryLog 获取指定目录的提交历史。
// 必须走 -z + logFormat（US/NUL 分隔）：曾用 %H|%h|... 竖线格式而 parseLog
// 按 \x00/\x1f 切分，输出永远解析出 0 条——目录历史恒为空的存量 bug
func GetDirectoryLog(repoPath string, dirPath string, limit, skip int) ([]model.Commit, error) {
	args := []string{"log", "-z", "--format=" + logFormat}
	if limit > 0 {
		args = append(args, "-n", fmt.Sprintf("%d", limit))
	}
	if skip > 0 {
		args = append(args, "--skip", fmt.Sprintf("%d", skip))
	}
	args = append(args, "--", dirPath)

	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}

	return parseLog(output), nil
}

// ListTreeAtRef 列出指定版本下的文件树
func ListTreeAtRef(repoPath string, ref string, path string) ([]map[string]interface{}, error) {
	target := ref
	if path != "" {
		target = ref + ":" + path
	}
	output, err := execGit(repoPath, "ls-tree", "--long", target)
	if err != nil {
		return nil, err
	}

	var result []map[string]interface{}
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// 格式: <mode> <type> <hash> <size>\t<name>
		// 使用 --long 后格式: <mode> <type> <hash> <size>\t<name>
		tabIdx := strings.LastIndex(line, "\t")
		if tabIdx < 0 {
			continue
		}
		meta := line[:tabIdx]
		name := line[tabIdx+1:]

		parts := strings.Fields(meta)
		if len(parts) < 4 {
			continue
		}

		objType := parts[1]
		hash := parts[2]
		size := parts[3]

		entry := map[string]interface{}{
			"name": name,
			"type": objType,
			"hash": hash,
			"size": size,
		}

		// 对于tree类型，构建完整路径
		if objType == "tree" {
			if path != "" {
				entry["path"] = path + "/" + name
			} else {
				entry["path"] = name
			}
		} else {
			if path != "" {
				entry["path"] = path + "/" + name
			} else {
				entry["path"] = name
			}
		}

		result = append(result, entry)
	}

	return result, nil
}

// ShowFileAtRef 获取指定版本下的文件内容
func ShowFileAtRef(repoPath string, ref string, filePath string) (string, error) {
	return execGit(repoPath, "show", ref+":"+filePath)
}

// ExtractChanges 从指定提交中提取特定文件为独立新提交
func ExtractChanges(repoPath string, commit string, files []string, message string) error {
	if message == "" {
		message = fmt.Sprintf("extract: files from %s", commit[:7])
	}

	// 1. 获取该提交的父提交
	parentLine, err := execGit(repoPath, "rev-parse", commit+"^")
	if err != nil {
		return fmt.Errorf("获取父提交失败: %v", err)
	}
	parentHash := strings.TrimSpace(parentLine)

	// 2. 暂存当前工作区变更
	_, stashErr := execGit(repoPath, "stash", "--include-untracked")
	hasStash := stashErr == nil

	// 3. soft reset 到该提交的父提交
	_, err = execGit(repoPath, "reset", "--soft", parentHash)
	if err != nil {
		return fmt.Errorf("soft reset 失败: %v", err)
	}

	// 4. 取消暂存所有文件
	_, err = execGit(repoPath, "reset", "HEAD")
	if err != nil {
		return fmt.Errorf("unstage 失败: %v", err)
	}

	// 5. 只暂存并提交指定的文件
	args := append([]string{"add", "--"}, files...)
	_, err = execGit(repoPath, args...)
	if err != nil {
		return fmt.Errorf("暂存指定文件失败: %v", err)
	}

	_, err = execGit(repoPath, "commit", "-m", message)
	if err != nil {
		return fmt.Errorf("创建提取提交失败: %v", err)
	}

	// 6. 暂存剩余的变更
	_, err = execGit(repoPath, "add", "-A")
	if err != nil {
		return fmt.Errorf("暂存剩余文件失败: %v", err)
	}

	// 如果还有剩余变更，创建第二个提交（原始提交的其余部分）
	statusOutput, _ := execGit(repoPath, "status", "--porcelain")
	if strings.TrimSpace(statusOutput) != "" {
		_, err = execGit(repoPath, "commit", "-m", "rest: remaining changes from "+commit[:7])
		if err != nil {
			return fmt.Errorf("提交剩余变更失败: %v", err)
		}
	}

	// 7. 恢复之前暂存的工作区变更
	if hasStash {
		_, _ = execGit(repoPath, "stash", "pop")
	}

	return nil
}
