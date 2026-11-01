package git

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrCommitPushed 提交已存在于某个远程分支：改写公开历史后必须 force 推送，
// 须调用方（前端）向用户说明后果并显式确认后携带 ConfirmPushed 重试
var ErrCommitPushed = errors.New("commit already pushed to a remote branch")

// RewordResult 修改提交信息的结果
type RewordResult struct {
	// Amended 目标是 HEAD：走 --amend --only 路径（不重写更早历史）
	Amended bool `json:"amended"`
	// Pushed 提交已存在于远程分支（改写后需 force-with-lease 推送）
	Pushed bool `json:"pushed"`
	// RemoteBranches 包含该提交的远程分支（pushed 时非空，前端展示给用户判断影响面）
	RemoteBranches []string `json:"remoteBranches"`
}

// CommitPushedInfo 检测提交是否已被推送到任何远程分支
func CommitPushedInfo(repoPath, hash string) (bool, []string, error) {
	out, err := execGit(repoPath, "branch", "-r", "--contains", hash, "--format=%(refname:short)")
	if err != nil {
		return false, nil, err
	}
	var branches []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			branches = append(branches, line)
		}
	}
	return len(branches) > 0, branches, nil
}

// RewordCommitMessage 修改提交信息（不改内容）。
//   - 目标为 HEAD：git commit --amend --only（--only 无路径语义 = 仅改信息，
//     绝不把用户已暂存的变更卷入提交——裸 --amend 会）；
//   - 更早提交：非交互 rebase -i reword（GIT_SEQUENCE_EDITOR 把 todo 中目标行
//     改为 reword，GIT_EDITOR 用 cp 覆写提交信息文件），--autostash 兜底脏工作区；
//   - 已推送提交：需调用方确认（改写公开历史，权威共识是共享分支禁止改写，
//     个人分支 reword + force-with-lease 是通行做法）；
//   - 合并提交 / 改写区间内含合并提交：拒绝（普通 rebase 会丢 merge 结构）。
func RewordCommitMessage(repoPath, hash, message string, confirmPushed bool) (RewordResult, error) {
	result := RewordResult{}
	if strings.TrimSpace(message) == "" {
		return result, fmt.Errorf("commit message must not be empty")
	}
	// hash 形态门禁（7-40 位十六进制；防御性——参数不进 shell，仅防误用）
	if !isCommitHash(hash) {
		return result, fmt.Errorf("invalid commit hash")
	}

	full, err := execGit(repoPath, "rev-parse", hash+"^{commit}")
	if err != nil {
		return result, fmt.Errorf("commit not found: %s", hash)
	}
	full = strings.TrimSpace(full)

	// 合并提交（存在第二父）不可 reword
	if _, err := execGit(repoPath, "rev-parse", full+"^2"); err == nil {
		return result, fmt.Errorf("reword of a merge commit is not supported")
	}

	pushed, branches, err := CommitPushedInfo(repoPath, full)
	if err != nil {
		return result, err
	}
	result.Pushed = pushed
	result.RemoteBranches = branches
	if pushed && !confirmPushed {
		return result, ErrCommitPushed
	}

	head := strings.TrimSpace(mustRevParse(repoPath, "HEAD"))
	if head == full {
		result.Amended = true
		if _, err := execGit(repoPath, "commit", "--amend", "--only", "-m", message); err != nil {
			return result, err
		}
		return result, nil
	}
	return result, rewordViaRebase(repoPath, full, message)
}

// rewordViaRebase 非交互改写历史中段的提交信息
func rewordViaRebase(repoPath, fullHash, message string) error {
	parent, perr := execGit(repoPath, "rev-parse", fullHash+"^")
	isRoot := perr != nil
	if !isRoot {
		// 改写区间内含合并提交：普通 rebase -i 生成的 todo 会丢掉 merge 结构
		if merges, err := execGit(repoPath, "rev-list", "--merges", strings.TrimSpace(parent)+"..HEAD"); err == nil && strings.TrimSpace(merges) != "" {
			return fmt.Errorf("reword refused: the rewrite range contains merge commits (use amend for HEAD or rebase --rebase-merges manually)")
		}
	}

	// 两个临时文件：信息文件（GIT_EDITOR 经 cp 覆写提交信息）+ 序列编辑脚本
	tmpMsg, err := os.CreateTemp("", "git-reword-msg-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmpMsg.Name())
	msg := message
	if !strings.HasSuffix(msg, "\n") {
		msg += "\n"
	}
	_, _ = tmpMsg.WriteString(msg)
	tmpMsg.Close()

	tmpScript, err := os.CreateTemp("", "git-reword-seq-*.sh")
	if err != nil {
		return err
	}
	defer os.Remove(tmpScript.Name())
	// GIT_SEQUENCE_EDITOR 被以 "$EDITOR <todo文件>" 形式调用：把目标行 pick → reword。
	// 用 cat > 覆写而非 sed -i（BSD/GNU sed 的 -i 参数不兼容，跨平台写法）
	key := fullHash[:7]
	fmt.Fprintf(tmpScript, "#!/bin/sh\nsed \"s/^pick \\(%s\\)/reword \\1/\" \"$1\" > \"$1.sc-rw\" && cat \"$1.sc-rw\" > \"$1\" && rm -f \"$1.sc-rw\"\n", key)
	tmpScript.Close()

	args := []string{"rebase", "-i"}
	if isRoot {
		args = append(args, "--root")
	} else {
		args = append(args, strings.TrimSpace(parent))
	}
	args = append(args, "--autostash")
	env := []string{
		"GIT_SEQUENCE_EDITOR=sh " + shellQuotePOSIX(filepath.ToSlash(tmpScript.Name())),
		"GIT_EDITOR=cp " + shellQuotePOSIX(filepath.ToSlash(tmpMsg.Name())),
	}
	if _, err := execGitWithEnv(repoPath, env, args...); err != nil {
		// rebase 中途失败会留下进行中状态：尽力回滚恢复原历史
		if _, abortErr := execGit(repoPath, "rebase", "--abort"); abortErr != nil {
			return fmt.Errorf("%w (rebase abort also failed: %v — run 'git rebase --abort' manually)", err, abortErr)
		}
		return fmt.Errorf("%w (working tree restored via rebase --abort)", err)
	}
	return nil
}

// mustRevParse 解析引用到完整哈希（失败返回空串）
func mustRevParse(repoPath, ref string) string {
	out, err := execGit(repoPath, "rev-parse", ref)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// isCommitHash 7-40 位十六进制哈希形态
func isCommitHash(s string) bool {
	if len(s) < 7 || len(s) > 40 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F':
		default:
			return false
		}
	}
	return true
}
