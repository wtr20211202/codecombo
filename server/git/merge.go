package git

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"codecombo/server/errmarkers"
	"codecombo/server/filepolicy"
)

// RebaseAction 表示交互式 rebase 计划中的一行操作
type RebaseAction struct {
	Action string `json:"action"` // pick, squash, reword, drop
	Hash   string `json:"hash"`
	Msg    string `json:"msg"`
	// NewMessage reword 动作的新提交消息。本通道无 TTY，git 原生 reword/edit
	// 步骤要拉起编辑器会挂到兜底超时——reword 必须自带消息，经 exec 行以
	// `git commit --amend --only -F <文件>` 落地（--only 无路径语义 = 仅改消息，
	// 不卷入暂存变更，与 reword.go 同语义）；squash 的合并消息同样经该机制落地
	NewMessage string `json:"newMessage,omitempty"`
}

// rebasePlanVerbs 计划通道接受的动作白名单：可视化编辑器与 agent 共用同一
// 契约。edit/fixup 等会开编辑器或语义易混淆的动词不进通道（fixup 由服务端
// 在落地 squash 时内部使用，见 buildRebaseTodo）
var rebasePlanVerbs = map[string]bool{"pick": true, "squash": true, "reword": true, "drop": true}

// MaxRebasePlanSteps 计划步数上限（提案约束）：限制一次历史改写的误操作半径，
// handler 与前端共用同一值
const MaxRebasePlanSteps = 20

// RebasePlanResult rebase 计划执行结果；区间含已推送提交被拒时携影响面明细
type RebasePlanResult struct {
	Pushed         bool     `json:"pushed"`
	RemoteBranches []string `json:"remoteBranches"`
}

// ErrRebaseRangePushed 改写区间内存在已推送提交：改写公开历史后必须
// force-with-lease 推送，须调用方（前端）列出受影响远程分支并显式确认后
// 携带 ConfirmPushed 重试（对齐 reword 的 ErrCommitPushed 两段式先例）
var ErrRebaseRangePushed = errors.New("rebase range contains commits already pushed to a remote branch")

// Cherry-pick
func CherryPick(repoPath string, commit string) (string, error) {
	if err := validateRef(commit); err != nil {
		return "", err
	}
	output, err := execGit(repoPath, "cherry-pick", commit)
	if err != nil {
		return output, err
	}
	return output, nil
}

// Revert提交
func Revert(repoPath string, commit string) (string, error) {
	if err := validateRef(commit); err != nil {
		return "", err
	}
	output, err := execGit(repoPath, "revert", commit, "--no-edit")
	if err != nil {
		return output, err
	}
	return output, nil
}

// Reset
func Reset(repoPath string, mode string, commit string) error {
	if commit != "" {
		if err := validateRef(commit); err != nil {
			return err
		}
	}
	args := []string{"reset"}
	switch mode {
	case "soft":
		args = append(args, "--soft")
	case "hard":
		args = append(args, "--hard")
	default:
		args = append(args, "--mixed")
	}
	if commit != "" {
		args = append(args, commit)
	}
	_, err := execGit(repoPath, args...)
	return err
}

// CommitParent 返回提交的父提交；根提交 isRoot=true（无父）。
// 供「整理自此提交起」入口换算 rebase 基准（onto = 目标提交的父）
func CommitParent(repoPath, hash string) (parent string, isRoot bool, err error) {
	if !isCommitHash(hash) {
		return "", false, fmt.Errorf("invalid commit hash")
	}
	if _, err := execGit(repoPath, "rev-parse", hash+"^{commit}"); err != nil {
		return "", false, fmt.Errorf("commit not found: %s", hash)
	}
	out, err := execGit(repoPath, "rev-parse", hash+"^")
	if err != nil {
		// 父不存在 = 根提交（reword.go rewordViaRebase 同款判定）
		return "", true, nil
	}
	return strings.TrimSpace(out), false, nil
}

// GetRebaseTodo 获取可 rebase 的提交列表。onto 为空 = 根提交区间（rebase
// --root 全历史）：编辑器入口选中区间首条根提交时其父不存在，用空 onto 表示
// 全历史。返回按应用序（最老在前，与 git rebase todo 文件同向）——与
// InteractiveRebase 的入参同向，「取列表 → 编辑 → 提交执行」全程零翻转
func GetRebaseTodo(repoPath string, onto string) ([]RebaseAction, error) {
	logArgs := []string{"log", "--format=%H|%s"}
	if onto == "" {
		logArgs = append(logArgs, "HEAD")
	} else {
		if err := validateRef(onto); err != nil {
			return nil, err
		}
		logArgs = append(logArgs, onto+"..HEAD")
	}
	output, err := execGit(repoPath, logArgs...)
	if err != nil {
		return nil, err
	}

	var actions []RebaseAction
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) < 2 {
			continue
		}
		// git log 输出新到旧，前插翻转为应用序
		actions = append([]RebaseAction{{
			Action: "pick",
			Hash:   parts[0],
			Msg:    parts[1],
		}}, actions...)
	}
	return actions, nil
}

// InteractiveRebase 执行交互式 rebase 计划（可视化编辑器与 agent 程序化整理
// 共用通道）。actions 按应用序（最老在前，与 GetRebaseTodo 返回序同向）且
// 必须恰好覆盖改写区间的全部提交——GIT_SEQUENCE_EDITOR 整体替换 todo 文件，
// 缺行会被 git 静默 drop，此处显式核对覆盖防误删。
//   - onto 为空 = 根提交区间（rebase --root 全历史）；
//   - 区间内含合并提交：拒绝（普通 rebase 会丢 merge 结构，与 reword 同规）；
//   - 区间内任一提交已推送：需 confirmPushed=true（改写公开历史，reword 先例）；
//   - 失败（冲突等）：尽力 rebase --abort 回原状，错误携带 git 输出明细。
func InteractiveRebase(repoPath string, onto string, actions []RebaseAction, confirmPushed bool) (RebasePlanResult, error) {
	result := RebasePlanResult{}
	if onto != "" {
		if err := validateRef(onto); err != nil {
			return result, err
		}
	}
	if len(actions) == 0 {
		return result, fmt.Errorf("rebase plan is empty")
	}
	for i := range actions {
		a := &actions[i]
		if !rebasePlanVerbs[a.Action] {
			return result, fmt.Errorf("unsupported rebase action %q (pick/squash/reword/drop)", a.Action)
		}
		if !isCommitHash(a.Hash) {
			return result, fmt.Errorf("invalid commit hash: %q", a.Hash)
		}
		if a.Action == "reword" && strings.TrimSpace(a.NewMessage) == "" {
			return result, fmt.Errorf("reword requires a new message (non-interactive channel cannot open an editor)")
		}
		if a.Action != "reword" && a.NewMessage != "" {
			return result, fmt.Errorf("newMessage is only valid with the reword action")
		}
	}

	rangeArg := onto + "..HEAD"
	root := onto == ""
	if root {
		rangeArg = "HEAD"
	}

	// 区间内含合并提交：普通 rebase -i 生成的 todo 会丢掉 merge 结构
	if merges, err := execGit(repoPath, "rev-list", "--merges", rangeArg); err == nil && strings.TrimSpace(merges) != "" {
		return result, fmt.Errorf("interactive rebase refused: the rewrite range contains merge commits (use rebase --rebase-merges manually)")
	}

	// 覆盖核对：计划提交集必须与区间提交集一致（缺行 = 静默 drop，多行/越界
	// = 计划与用户所见区间不符），短哈希先解析为全哈希
	out, err := execGit(repoPath, "rev-list", rangeArg)
	if err != nil {
		return result, err
	}
	rangeSet := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			rangeSet[line] = true
		}
	}
	if len(rangeSet) == 0 {
		return result, fmt.Errorf("no commits in rebase range %s", rangeArg)
	}
	seen := make(map[string]bool, len(actions))
	for i := range actions {
		full, perr := execGit(repoPath, "rev-parse", actions[i].Hash+"^{commit}")
		if perr != nil {
			return result, fmt.Errorf("commit not found: %s", actions[i].Hash)
		}
		full = strings.TrimSpace(full)
		if !rangeSet[full] {
			return result, fmt.Errorf("commit %s is outside the rebase range %s", actions[i].Hash, rangeArg)
		}
		if seen[full] {
			return result, fmt.Errorf("duplicate commit in rebase plan: %s", actions[i].Hash)
		}
		seen[full] = true
		// 回写全哈希：后续消息读取与 todo 行使用稳定前缀，不依赖客户端传参形态
		actions[i].Hash = full
	}
	if len(seen) != len(rangeSet) {
		return result, fmt.Errorf("rebase plan must cover every commit in the range (%d of %d given)", len(seen), len(rangeSet))
	}

	// 区间内任一提交已推送 = 改写公开历史：未确认时拒绝并给全部分支列表
	//（逐提交 branch -r --contains 本地调用，区间已被上限约束；仓库无远程
	// 分支时跳过逐个探测，本地仓零额外开销）
	if !confirmPushed {
		if remotes, rerr := execGit(repoPath, "branch", "-r"); rerr == nil && strings.TrimSpace(remotes) != "" {
			pushedBranches := make(map[string]bool)
			for h := range rangeSet {
				pushed, branches, perr := CommitPushedInfo(repoPath, h)
				if perr != nil {
					return result, perr
				}
				if pushed {
					result.Pushed = true
					for _, b := range branches {
						pushedBranches[b] = true
					}
				}
			}
			if result.Pushed {
				for b := range pushedBranches {
					result.RemoteBranches = append(result.RemoteBranches, b)
				}
				sort.Strings(result.RemoteBranches)
				return result, ErrRebaseRangePushed
			}
		}
	}

	// 区间全 drop：git 对空 todo 会整体不作动（静默成功假象）——显式拒绝引导走 reset
	firstEffective := -1
	for i := range actions {
		if actions[i].Action != "drop" {
			firstEffective = i
			break
		}
	}
	if firstEffective < 0 {
		return result, fmt.Errorf("plan drops the entire range — use reset to discard commits")
	}
	if actions[firstEffective].Action == "squash" {
		return result, fmt.Errorf("squash cannot be the first action (nothing to squash into)")
	}

	// 生成 todo + reword/squash 的消息文件
	todoFile, msgFiles, err := buildRebaseTodo(repoPath, actions)
	if err != nil {
		return result, err
	}
	defer func() {
		os.Remove(todoFile)
		for _, f := range msgFiles {
			os.Remove(f)
		}
	}()

	// 使用 GIT_SEQUENCE_EDITOR 指向我们的 todo 文件。编辑器值只写拷贝命令、
	// 不引用 $1：git 对含元字符的编辑器命令以 `sh -c '<值> "$@"' <值> <todo路径>`
	// 调用（路径经 $@ 自附），值里再写 $1 会展开成同一路径、叠加成三个操作数
	// 让 cp 报「target is not a directory」。路径必须转斜杠 + shell 单引号包裹：
	// Windows 的临时目录反斜杠（C:\Users\...）会被 sh 当转义剥掉，用户名含
	// 空格时未加引号还会被分词——两种情况都让 cp 失败、rebase 中止
	script := fmt.Sprintf("cp %s", shellQuotePOSIX(filepath.ToSlash(todoFile)))

	// --autostash 兜底脏工作区（与 reword 通道同语义）：改写前自动 stash、
	// 结束后恢复；rebase 失败时 git 自行回放 autostash
	args := []string{"rebase", "-i"}
	if root {
		args = append(args, "--root")
	} else {
		args = append(args, onto)
	}
	args = append(args, "--autostash")

	// rebase -i 是 index.lock 写户，但此处裸 exec 不经 execGitWithEnvLog 汇流点
	//（历史先于写串行队列）——显式入队对齐同一互斥面，防与其他写命令并发撞锁
	release, qerr := acquireRepoWriteSlot(repoPath, args, logGitCmd)
	if qerr != nil {
		return result, qerr
	}
	defer release()

	cmd := exec.Command("git", append(gitLongPathsArgs(), args...)...)
	cmd.Dir = repoPath
	cmd.Env = append(os.Environ(), fmt.Sprintf("GIT_SEQUENCE_EDITOR=%s", script))
	setProcessGroup(cmd)

	// 兜底超时 + 进程组清理（与 execGitWithEnv 同策略）：rebase 卡住
	//（序列编辑器异常挂起等）不再永久阻塞，派生子进程一并终止
	var combined bytes.Buffer
	cmd.Stdout = &combined
	cmd.Stderr = &combined
	timeout := classifyGitTimeout([]string{"rebase", "-i"})
	// 全局并发门（P-20261004-125）：与汇流点同序（写槽位 → 全局槽位）。
	// 刻意紧贴 runWithTimeout 作用域、不用 defer 到函数尾：下方失败路径的
	// abort 兜底是刻意的裸 exec（见 abortRebaseInSlot 注释），让恢复清场
	// 跑在全局门之外——槽位释放后再 abort，调用图上不出现「持全局门起嵌套
	// git 进程」形态
	releaseGate, gerr := acquireGlobalGate(args)
	if gerr != nil {
		return result, gerr
	}
	err = runWithTimeout(cmd, timeout)
	releaseGate()
	if err != nil {
		if strings.HasPrefix(err.Error(), "timed out") {
			// 进程组已被整组终止，但被杀的 rebase 可能留下 rebase-merge 目录
			// 把仓库卡在进行中状态——与失败路径同款 abort 兜底清场
			if abortErr := abortRebaseInSlot(repoPath); abortErr != nil {
				return result, fmt.Errorf("rebase timed out after %v (rebase abort also failed: %v — run 'git rebase --abort' manually)", timeout, abortErr)
			}
			return result, fmt.Errorf("rebase timed out after %v (working tree restored via rebase --abort)", timeout)
		}
		output := ""
		if combined.Len() > 0 {
			output = strings.TrimSpace(combined.String())
		}
		// 失败（冲突等）保底恢复原状：abort 在已持有的写槽位内裸执行——
		// 不得换 execGit，写队列是容量 1 chan 且不记属主，持槽期间再入队
		// 会自等 30s 超时（互斥性由外层槽位保证，绕过汇流点不破坏串行语义）
		if abortErr := abortRebaseInSlot(repoPath); abortErr != nil {
			return result, fmt.Errorf("rebase failed: %s (rebase abort also failed: %v — run 'git rebase --abort' manually)", output, abortErr)
		}
		return result, fmt.Errorf("%s: %s", errmarkers.RebaseAbortedPrefix, output)
	}

	return result, nil
}

// buildRebaseTodo 把计划落成 GIT_SEQUENCE_EDITOR 供给的 todo 文件。
// 返回 todo 文件路径与全部消息文件路径（调用方负责清理）：
//   - pick → 原样 pick 行；
//   - drop → 不写行（等价删除）；
//   - reword → pick 行 + exec `git commit --amend --only -F <消息文件>`；
//   - squash → fixup 行（静默并入前一条，不开编辑器）+ exec amend 写入
//     合并消息（标准 squash 输出 = 各条消息按序空行连接）。
func buildRebaseTodo(repoPath string, actions []RebaseAction) (string, []string, error) {
	var todoLines []string
	var msgFiles []string
	writeMsgFile := func(content string) (string, error) {
		f, err := os.CreateTemp("", "git-rebase-msg-*")
		if err != nil {
			return "", fmt.Errorf("create temp file: %w", err)
		}
		if !strings.HasSuffix(content, "\n") {
			content += "\n"
		}
		_, _ = f.WriteString(content)
		f.Close()
		return f.Name(), nil
	}
	// curMsg 当前生效提交的完整消息（squash 合并消息的累积底座）。每行有效
	// 提交都确定性读取完整消息：squash 是否出现要走到才知道，懒加载会让
	// 「squash 前一条消息读取失败」时静默拼出残缺合并消息——有界区间（≤20）
	// 内全量读取的本地开销可忽略
	curMsg := ""
	fullMessage := func(hash string) (string, error) {
		out, err := execGit(repoPath, "log", "--format=%B", "-1", hash)
		if err != nil {
			return "", fmt.Errorf("read commit message of %s: %w", hash, err)
		}
		return strings.TrimSpace(out), nil
	}
	for _, a := range actions {
		short := a.Hash
		if len(short) > 7 {
			short = short[:7]
		}
		switch a.Action {
		case "drop":
			continue
		case "pick", "reword":
			todoLines = append(todoLines, fmt.Sprintf("pick %s %s", short, strings.ReplaceAll(a.Msg, "\n", " ")))
			if a.Action == "reword" {
				f, err := writeMsgFile(strings.TrimSpace(a.NewMessage))
				if err != nil {
					return "", nil, err
				}
				msgFiles = append(msgFiles, f)
				todoLines = append(todoLines, amendExecLine(f))
				curMsg = strings.TrimSpace(a.NewMessage)
			} else {
				msg, err := fullMessage(a.Hash)
				if err != nil {
					return "", nil, err
				}
				curMsg = msg
			}
		case "squash":
			msg, err := fullMessage(a.Hash)
			if err != nil {
				return "", nil, err
			}
			if curMsg == "" {
				curMsg = msg
			} else {
				curMsg = curMsg + "\n\n" + msg
			}
			todoLines = append(todoLines, fmt.Sprintf("fixup %s %s", short, strings.ReplaceAll(a.Msg, "\n", " ")))
			f, err := writeMsgFile(curMsg)
			if err != nil {
				return "", nil, err
			}
			msgFiles = append(msgFiles, f)
			todoLines = append(todoLines, amendExecLine(f))
		}
	}
	todoContent := strings.Join(todoLines, "\n") + "\n"

	tmpFile, err := os.CreateTemp("", "git-rebase-todo-*")
	if err != nil {
		return "", nil, fmt.Errorf("create temp file: %w", err)
	}
	_, _ = tmpFile.WriteString(todoContent)
	tmpFile.Close()
	return tmpFile.Name(), msgFiles, nil
}

// amendExecLine reword/squash 消息落地的 exec 行：--amend --only 仅改消息
// 不卷入暂存变更（reword.go 同语义）。exec 行由 git 经 sh 执行，与
// GIT_SEQUENCE_EDITOR 同一平台依赖（git 发行版自带 sh），消息走 -F 文件
// 不进 argv，避免引号转义与命令行长度问题
func amendExecLine(msgFile string) string {
	return fmt.Sprintf("exec git commit --amend --only -F %s", shellQuotePOSIX(filepath.ToSlash(msgFile)))
}

// abortRebaseInSlot 已持有写队列槽位的失败路径里中止 rebase（裸 exec，原因
// 见调用处注释；P-20261004-125 起对全局并发门同为裸 exec——恢复清场若排队
// 等门可能恰恰排在造成拥堵的进程身后，60s 读档上限内尽快还原现场优先）。
// 本地清场操作走 60s 读档上限——正常毫秒级，挂起即环境异常
func abortRebaseInSlot(repoPath string) error {
	cmd := exec.Command("git", append(gitLongPathsArgs(), "rebase", "--abort")...)
	cmd.Dir = repoPath
	cmd.Env = os.Environ()
	setProcessGroup(cmd)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := runWithTimeout(cmd, gitReadTimeout); err != nil {
		return fmt.Errorf("%s", strings.TrimSpace(buf.String()))
	}
	return nil
}

// AbortRebase 中止 rebase
func AbortRebase(repoPath string) error {
	_, err := execGit(repoPath, "rebase", "--abort")
	return err
}

// ContinueRebase 继续 rebase
// core.editor=true：服务端无 TTY，若 rebase 停在 edit/squash 等需要打开提交
// 信息编辑器的步骤，默认会拉起 vi 卡在管道上直到超时——editor=true（/usr/bin/true）
// 原样接受消息立即返回。普通冲突后的 --continue 本就不开编辑器，此兜底仅影响编辑器步骤
func ContinueRebase(repoPath string) error {
	_, err := execGit(repoPath, "-c", "core.editor=true", "rebase", "--continue")
	return err
}

// SkipRebase 跳过当前提交
func SkipRebase(repoPath string) error {
	_, err := execGit(repoPath, "rebase", "--skip")
	return err
}

// ConflictFile 表示一个冲突文件
type ConflictFile struct {
	Path    string `json:"path"`
	Status  string `json:"status"` // both-modified, added-by-us, added-by-them, deleted-by-us, deleted-by-them
	Content string `json:"content,omitempty"`
}

// GetConflictFiles 获取冲突文件列表
func GetConflictFiles(repoPath string) ([]ConflictFile, error) {
	output, err := execGit(repoPath, "status", "--porcelain")
	if err != nil {
		return nil, err
	}

	var conflicts []ConflictFile
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if len(line) < 3 {
			continue
		}

		xy := line[:2]
		file := strings.TrimSpace(line[2:])

		// 冲突标记: DD, AU, UD, UA, DU, AA, UU
		if (xy[0] == 'U' || xy[1] == 'U') || xy == "AA" || xy == "DD" {
			status := "both-modified"
			if xy == "AU" {
				status = "added-by-us"
			} else if xy == "UA" {
				status = "added-by-them"
			} else if xy == "DU" {
				status = "deleted-by-us"
			} else if xy == "UD" {
				status = "deleted-by-them"
			}

			conflicts = append(conflicts, ConflictFile{
				Path:   file,
				Status: status,
			})
		}
	}

	return conflicts, nil
}

// contentHash 内容字节流的 sha256 hex——与 files.ReadFile / remote 编辑器写回的
// hash 字段同源同形（各包小实现惯例见 remotehost_filecontent.go，避免 server/git
// 反向依赖 api 层包）
func contentHash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ConflictStaleMarker baseHash 乐观锁失配的对外稳定标记（P-20261004-27）：
// 前端 KNOWN_ERROR_I18N 据此映射「文件在解决期间被修改，请重新解析」；
// 带固定 "conflict " 前缀与 files.WriteFile 的既有 409 原文（file was modified
// externally...）互不误配——改措辞须与前端正则两侧同步。文本唯一事实源在
// errmarkers 注册表（P-20261004-29），此处保名别名
const ConflictStaleMarker = errmarkers.ConflictStale

// ConflictStaleError 冲突文件在载入解析与写回之间被外部修改（baseHash 乐观锁
// 失配）。CurrentContent 携磁盘当前解码文本，409 载荷契约对齐 files.WriteFile
// 的 currentContent；调用方以 errors.As 分流，不读字符串
type ConflictStaleError struct {
	CurrentContent string
}

func (e *ConflictStaleError) Error() string { return ConflictStaleMarker }

// conflictFileAbsPath 校验并解析冲突文件的仓库内绝对路径（Clean + Rel 双重防
// 穿越，防 Windows 盘符等绕过）。读（GetConflictContent）与写（冲突内容写回）
// 共用同一路径口径
func conflictFileAbsPath(repoPath string, file string) (string, error) {
	clean := filepath.Clean(file)
	if filepath.IsAbs(clean) || strings.HasPrefix(clean, "..") {
		return "", fmt.Errorf("invalid file path: %s", file)
	}
	full := filepath.Join(repoPath, clean)
	// 二次校验拼接结果仍在仓库内（防 Windows 盘符等绕过）
	if rel, err := filepath.Rel(repoPath, full); err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("invalid file path: %s", file)
	}
	return full, nil
}

// ConflictContent 冲突文件快照：解码文本 + 探测编码 + 磁盘原始字节 hash。
// Hash 与 Content 同源一次读出（P-20261004-27 baseHash 乐观锁基线）——分两次
// 读会让 hash 与内容错位，基线从根上不可信
type ConflictContent struct {
	Content  string // 含冲突标记的工作区真实文本（解码后）
	Encoding string // 探测编码标签（空 = UTF-8）：写回时原样回传按原编码落盘
	Hash     string // 磁盘原始字节的 sha256 hex（与 files.ReadFile 的 hash 字段同形）
}

// GetConflictContent 获取冲突文件内容（读工作区文件：含冲突标记的真实内容）
// 注意不能用 `git show :file`——冲突文件在 index 中只有 stage 1/2/3 条目、无 stage 0，
// 新版 git 直接报错 "path is in the index, but not at stage 0"。
// 返回探测编码标签：冲突标记是 ASCII（任何候选编码下字节不变），正文按原
// 编码解码展示；用户解决冲突后前端回传标签，ResolveConflictWithContent 按
// 原编码落盘——避免解决一次冲突就把 GBK 文件转成 UTF-8
func GetConflictContent(repoPath string, file string) (ConflictContent, error) {
	full, err := conflictFileAbsPath(repoPath, file)
	if err != nil {
		return ConflictContent{}, err
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return ConflictContent{}, err
	}
	content, encoding := filepolicy.DecodeText(data)
	return ConflictContent{Content: content, Encoding: encoding, Hash: contentHash(data)}, nil
}

// ConflictSections 解析后的冲突片段
type ConflictSections struct {
	Ours   string `json:"ours"`
	Theirs string `json:"theirs"`
}

// ParseConflictContent 解析冲突标记，提取 ours 和 theirs 部分
func ParseConflictContent(content string) *ConflictSections {
	var ours, theirs []string
	inOurs := false
	inTheirs := false

	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "<<<<<<<") {
			inOurs = true
			continue
		}
		if strings.HasPrefix(line, "=======") {
			inOurs = false
			inTheirs = true
			continue
		}
		if strings.HasPrefix(line, ">>>>>>>") {
			inTheirs = false
			continue
		}
		if inOurs {
			ours = append(ours, line)
		} else if inTheirs {
			theirs = append(theirs, line)
		}
	}

	return &ConflictSections{
		Ours:   strings.Join(ours, "\n"),
		Theirs: strings.Join(theirs, "\n"),
	}
}

// ConflictHunk 单个冲突块：工作区文件里一对 <<<<<<< / >>>>>>> 标记围出的分段。
// 行号基于工作区真实内容（1-based，含两端标记行），前端据此做范围替换合成
// 解决结果（逐块解决 P-20261003-59）
type ConflictHunk struct {
	Ours      string `json:"ours"`           // 我方段正文（不含标记行）
	Theirs    string `json:"theirs"`         // 他方段正文
	Base      string `json:"base,omitempty"` // diff3/zdiff3 基准段（||||||| 至 ======= 之间，P-20261004-28）；双子段冲突恒为空
	StartLine int    `json:"startLine"`      // <<<<<<< 标记行号（1-based）
	EndLine   int    `json:"endLine"`        // >>>>>>> 标记行号（1-based，含）
}

// ParseConflictHunks 把含冲突标记的内容按块拆分。ok=false 表示不可信形态
// （段内嵌套 <<<<<<<、||||||| 计数/顺序异常、EOF 处未闭合标记）——调用方
// 降级到既有整文件解决模式，绝不带着可疑分段写回用户文件。
// 标记形态自适应（P-20261004-28，不读 git config）：双子段形态 ours=<<<<<<<..=======、
// theirs========..>>>>>>>；diff3/zdiff3 形态在 ours 与分隔线之间多一段 |||||||
// 基准段（base），两者五标记骨架相同——zdiff3 只是把两侧共同行外提到标记外，
// 对解析器就是普通上下文行，base 段允许为空（共同祖先空/被外提）。按 |||||||
// 是否出现自适应提取：ours/theirs 语义不变，base 随块附带返回。
// 不可信边界不放宽：块内出现第二个 |||||||（基准段计数异常）或 ======= 之后
// 再现 |||||||（顺序异常，任何 git conflictStyle 都不产出该形态）一律降级——
// 旧解析把这两种形态静默吞进 theirs 正文，属误解析，改为拒绝。
// 标记判定与 git 口径一致：起始/结束/diff3 标记允许后跟标签（<<<<<<< HEAD）、
// 分隔线必须恰为 7 个 =（正文里的长 ===== 规则线不会误判为分隔，这比
// ParseConflictContent 的前缀匹配更严格——逐块解析要按行号写回，误判代价高；
// 代价之一：diff3 块 ours 段内恰为 7 个 = 的正文行会被当分隔线、随后的
// ||||||| 触发顺序异常降级——歧义形态宁可降级也不误写回）。
// CRLF 文件的标记行尾带 \r，前缀匹配与 \r 剥离后比较均兼容
func ParseConflictHunks(content string) (hunks []ConflictHunk, ok bool) {
	lines := strings.Split(content, "\n")
	inOurs, inBase, inTheirs := false, false, false
	cur := -1 // 当前块在 hunks 中的下标；不能用指针——append 扩容后指针失效
	for i, line := range lines {
		switch {
		case strings.HasPrefix(line, "<<<<<<<"):
			if inOurs || inBase || inTheirs {
				return nil, false // 嵌套标记（criss-cross 等产物）：降级
			}
			hunks = append(hunks, ConflictHunk{StartLine: i + 1})
			cur = len(hunks) - 1
			inOurs = true
		case strings.HasPrefix(line, "|||||||") && (inOurs || inBase || inTheirs):
			if !inOurs {
				// 第二个基准段开头（计数异常）或基准段出现在他方段之后（顺序异常）：
				// 不可信形态，降级
				return nil, false
			}
			inOurs, inBase = false, true // diff3/zdiff3：进入基准段
		case strings.TrimSuffix(line, "\r") == "=======" && (inOurs || inBase):
			inOurs, inBase, inTheirs = false, false, true
		case strings.HasPrefix(line, ">>>>>>>") && inTheirs:
			hunks[cur].EndLine = i + 1
			inOurs, inBase, inTheirs, cur = false, false, false, -1
		case inOurs:
			hunks[cur].Ours = appendHunkLine(hunks[cur].Ours, line)
		case inBase:
			hunks[cur].Base = appendHunkLine(hunks[cur].Base, line)
		case inTheirs:
			hunks[cur].Theirs = appendHunkLine(hunks[cur].Theirs, line)
		}
	}
	if cur != -1 || inOurs || inBase || inTheirs {
		return nil, false // 未闭合（文件被截断等）：降级
	}
	return hunks, true
}

// appendHunkLine 块正文按行累积（空行/空段保留原样：某侧删空是合法冲突形态）
func appendHunkLine(acc, line string) string {
	if acc == "" {
		return line
	}
	return acc + "\n" + line
}

// ResolveConflict 使用指定策略解决冲突
func ResolveConflict(repoPath string, file string, strategy string) error {
	switch strategy {
	case "ours":
		_, err := execGit(repoPath, "checkout", "--ours", "--", file)
		if err != nil {
			return err
		}
	case "theirs":
		_, err := execGit(repoPath, "checkout", "--theirs", "--", file)
		if err != nil {
			return err
		}
	case "manual":
		// 手动解决，只需 git add
	}

	// 标记为已解决
	_, err := execGit(repoPath, "add", "--", file)
	return err
}

// ResolveConflictWithContent 使用指定内容解决冲突。encoding 为读取时探测的
// 原编码标签（GetConflictContent 回传）：按原编码落盘，空 = UTF-8。
// baseHash 为调用方载入解析时的磁盘内容 hash（ConflictContent.Hash）：非空时
// 写回前与磁盘当前内容比对，失配返回 *ConflictStaleError——解析快照到写回
// 之间隔着用户逐块斟酌的分钟级窗口（多 agent 并发最密集场景），防静默覆盖
// 窗口期他人改动（P-20261004-27）；空 = 直写（旧调用方兼容）。
// 文件已删除/读取失败时跳过检测：写回重建是用户显式意图，无数据可丢
// （与 files.WriteFile 的跳过口径一致）
func ResolveConflictWithContent(repoPath string, file string, content string, encoding string, baseHash string) error {
	fullPath, err := conflictFileAbsPath(repoPath, file)
	if err != nil {
		return err
	}
	if baseHash != "" {
		if cur, err := os.ReadFile(fullPath); err == nil && contentHash(cur) != baseHash {
			curText, _ := filepolicy.DecodeText(cur)
			return &ConflictStaleError{CurrentContent: curText}
		}
	}
	data, err := filepolicy.EncodeText(content, encoding)
	if err != nil {
		return err
	}
	// 原子写（与 files.WriteFile 同模式，中途崩溃不留半截文件）
	tmp := fullPath + ".sc-conflict-tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, fullPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// resolveGitDir 解析仓库的实际 git 目录：普通仓库即 <repo>/.git；worktree 的
// .git 是一个内容为 "gitdir: /path/to/repo/.git/worktrees/xxx" 的指针文件。
// 解析失败返回 ok=false
func resolveGitDir(repoPath string) (gitDir string, ok bool) {
	gitDir = filepath.Join(repoPath, ".git")
	info, err := os.Stat(gitDir)
	if err != nil {
		return "", false
	}
	if info.IsDir() {
		return gitDir, true
	}
	// worktree 场景：.git 文件内容类似 "gitdir: /path/to/repo/.git/worktrees/xxx"
	data, err := os.ReadFile(gitDir)
	if err != nil {
		return "", false
	}
	content := strings.TrimSpace(string(data))
	if !strings.HasPrefix(content, "gitdir: ") {
		return "", false
	}
	return strings.TrimPrefix(content, "gitdir: "), true
}

// OperationInProgress 检测进行中的有序 git 操作类型，返回
// "rebase"（rebase-merge/rebase-apply 目录，交互式与普通 rebase 均落盘）
// / "merge"（MERGE_HEAD）/ "cherry-pick"（CHERRY_PICK_HEAD），无进行中操作返回空串。
// 供冲突列表接口顺带返回：前端在冲突全解后据此显示「继续变基/完成合并」操作条，
// 补齐 rebase 冲突解决链的最后一米（此前用户只能去终端手打 git rebase --continue）
func OperationInProgress(repoPath string) string {
	gitDir, ok := resolveGitDir(repoPath)
	if !ok {
		return ""
	}
	if _, err := os.Stat(filepath.Join(gitDir, "rebase-merge")); err == nil {
		return "rebase"
	}
	if _, err := os.Stat(filepath.Join(gitDir, "rebase-apply")); err == nil {
		return "rebase"
	}
	if _, err := os.Stat(filepath.Join(gitDir, "MERGE_HEAD")); err == nil {
		return "merge"
	}
	if _, err := os.Stat(filepath.Join(gitDir, "CHERRY_PICK_HEAD")); err == nil {
		return "cherry-pick"
	}
	return ""
}

// IsRebasing 检查是否正在 rebase 中
func IsRebasing(repoPath string) bool {
	return OperationInProgress(repoPath) == "rebase"
}

// shellQuotePOSIX POSIX sh 单引号包裹（GIT_SEQUENCE_EDITOR 等 shell 单行
// 脚本内的路径引用；git 在 Windows 上也用 sh 执行序列编辑器）
func shellQuotePOSIX(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
