package git

import (
	"fmt"
	"path/filepath"
	"strings"
)

// Worktree 表示一个 git worktree
type Worktree struct {
	Path         string `json:"path"`
	Branch       string `json:"branch"`
	Hash         string `json:"hash"`
	IsMain       bool   `json:"isMain"`
	IsPrunable   bool   `json:"isPrunable"`
	IsLocked     bool   `json:"isLocked"`
	LockedReason string `json:"lockedReason"`
}

// ListWorktrees 列出所有 worktree
func ListWorktrees(repoPath string) ([]Worktree, error) {
	output, err := execGit(repoPath, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}

	return parseWorktrees(output), nil
}

func parseWorktrees(output string) []Worktree {
	var worktrees []Worktree
	var current *Worktree

	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			if current != nil {
				worktrees = append(worktrees, *current)
				current = nil
			}
			continue
		}

		if current == nil {
			current = &Worktree{}
		}

		if strings.HasPrefix(line, "worktree ") {
			current.Path = strings.TrimPrefix(line, "worktree ")
		} else if strings.HasPrefix(line, "HEAD ") {
			current.Hash = strings.TrimPrefix(line, "HEAD ")
		} else if strings.HasPrefix(line, "branch ") {
			current.Branch = strings.TrimPrefix(line, "branch ")
			// 去掉 refs/heads/ 前缀
			current.Branch = strings.TrimPrefix(current.Branch, "refs/heads/")
		} else if line == "bare" {
			current.IsMain = true
		} else if strings.HasPrefix(line, "locked") {
			current.IsLocked = true
			reason := strings.TrimSpace(strings.TrimPrefix(line, "locked"))
			if reason != "" {
				current.LockedReason = reason
			}
		}
	}
	if current != nil {
		worktrees = append(worktrees, *current)
	}

	if len(worktrees) > 0 {
		worktrees[0].IsMain = true
	}

	return worktrees
}

// AddWorktree 创建新 worktree
func AddWorktree(repoPath string, path string, branch string) error {
	args := []string{"worktree", "add"}
	if branch != "" {
		args = append(args, "-b", branch)
	}
	args = append(args, path)

	_, err := execGit(repoPath, args...)
	return err
}

// AddWorktreeFromRef 从已有分支创建 worktree
func AddWorktreeFromRef(repoPath string, path string, ref string) error {
	_, err := execGit(repoPath, "worktree", "add", path, ref)
	return err
}

// RemoveWorktree 删除 worktree
func RemoveWorktree(repoPath string, path string, force bool) error {
	// git 对 worktree remove 的路径形态敏感（Windows 下注册路径与传入路径的
	// 分隔符/大小写不一致时报 "is not a working tree"）——先解析为注册表中
	// 记录的精确路径再执行
	anchored, err := resolveWorktreePath(repoPath, path)
	if err != nil {
		return err
	}
	args := []string{"worktree", "remove"}
	if force {
		// 双 -f：单 -f 仍无法移除 locked 工作树（git 提示 use 'remove -f -f'）；
		// UI 流程为非 force 失败后弹「强制删除」确认，此处对应用户显式意图
		args = append(args, "--force", "--force")
	}
	args = append(args, anchored)
	_, err = execGit(repoPath, args...)
	return err
}

// normalizeWorktreePath worktree 路径比对键：统一正斜杠 + Clean + 真实化。
// 真实化必须做：git worktree list 登记的是 git 自己解析的**长名**（runneradmin），
// 而调用方输入可能来自 t.TempDir()/环境 TMP 的 8.3 短名（RUNNER~1）——裸形态
// 比对永远失配（Windows 大小写回落掩盖不了长短名差异，runner 实锚）
func normalizeWorktreePath(p string) string {
	p = filepath.ToSlash(filepath.Clean(strings.TrimSpace(p)))
	if real := evalSymlinksNormalized(filepath.FromSlash(p)); real != "" {
		p = filepath.ToSlash(real)
	}
	return p
}

// resolveWorktreePath 把任意形态的 worktree 路径解析为 git 注册表中记录的
// 精确路径。AddWorktree 的路径来自用户输入（分隔符/相对路径任意），而
// `git worktree remove` 对形态不匹配的路径报 "is not a working tree"
func resolveWorktreePath(repoPath, path string) (string, error) {
	output, err := execGit(repoPath, "worktree", "list", "--porcelain")
	if err != nil {
		return "", err
	}
	want := normalizeWorktreePath(path)
	var ciMatch string
	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, "worktree ") {
			continue
		}
		registered := strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
		if normalizeWorktreePath(registered) == want {
			return registered, nil
		}
		if strings.EqualFold(registered, path) && ciMatch == "" {
			ciMatch = registered
		}
	}
	if ciMatch != "" {
		return ciMatch, nil
	}
	return "", fmt.Errorf("worktree not found: %s", path)
}

// PruneWorktrees 清理无效的 worktree 引用
func PruneWorktrees(repoPath string) error {
	_, err := execGit(repoPath, "worktree", "prune")
	return err
}

// MoveWorktree 移动 worktree
func MoveWorktree(repoPath string, oldPath string, newPath string) error {
	_, err := execGit(repoPath, "worktree", "move", oldPath, newPath)
	return err
}

// LockWorktree 锁定 worktree
func LockWorktree(repoPath string, path string, reason string) error {
	args := []string{"worktree", "lock"}
	if reason != "" {
		args = append(args, "--reason", reason)
	}
	args = append(args, path)
	_, err := execGit(repoPath, args...)
	return err
}

// UnlockWorktree 解锁 worktree
func UnlockWorktree(repoPath string, path string) error {
	_, err := execGit(repoPath, "worktree", "unlock", path)
	return err
}

// IsWorktreeSupported 检查是否支持 worktree
func IsWorktreeSupported(repoPath string) bool {
	_, err := execGit(repoPath, "worktree", "list")
	return err == nil
}

// Ensure Go compile: use fmt
var _ = fmt.Sprintf
