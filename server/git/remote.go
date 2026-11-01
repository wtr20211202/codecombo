package git

import (
	"bytes"
	"codecombo/server/model"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Fetch远程仓库
// 通过 execGitWithAuth 反查 remote URL 拿协议，自动注入 GIT_CONFIG_GLOBAL（HTTPS）或 GIT_SSH_COMMAND（SSH）。
// 固定携带 --prune --tags：GUI 刷新语义下「远程新增的分支/tag 要能看到，远程已删的分支要清掉」——
// 裸 fetch 既不拉取不可达 tag 也不清理失效的远程跟踪分支（用户反馈：别人新推的 tag 刷新后看不到）
func Fetch(repoPath string, remote string) (string, error) {
	args := []string{"fetch", "--prune", "--tags"}
	if remote != "" {
		args = append(args, remote)
		output, err := execGitWithAuth(repoPath, remote, args...)
		if err != nil {
			return "", err
		}
		return output, nil
	}
	// remote 为空时无法反查 URL（execGitWithAuth 需要 remoteName）
	output, err := execGitWithEnv(repoPath, nil, args...)
	if err != nil {
		return "", err
	}
	return output, nil
}

// PullResult pull 回执（P-20261003-202 结果摘要）
type PullResult struct {
	// Output git pull 原始输出，语义与历史 string 返回一致（错误面板留痕等）
	Output string
	// NewCommits 本次拉进来的新提交数 = `rev-list --count <pull前HEAD>..HEAD`——
	// 比解析 pull 输出措辞（"Already up to date"/各语言本地化）更稳。
	// pull 前 HEAD 不可解析（零提交仓库等）或计数失败时为 -1，前端据此跳过摘要
	NewCommits int
}

// Pull远程仓库
// 同 Fetch：通过 execGitWithAuth 注入凭据。
// 成功回执附 NewCommits 计数（前后 HEAD 快照，两个本地读命令的开销对涉网 pull 可忽略）
func Pull(repoPath string, remote, branch string) (PullResult, error) {
	if branch != "" {
		if err := validateRef(branch); err != nil {
			return PullResult{}, err
		}
	}
	headBefore := headCommitID(repoPath)
	args := []string{"pull"}
	if remote != "" && branch != "" {
		args = append(args, remote, branch)
	} else if remote != "" {
		args = append(args, remote)
	}
	if remote != "" {
		output, err := execGitWithAuth(repoPath, remote, args...)
		if err != nil {
			return PullResult{Output: output}, err
		}
		return PullResult{Output: output, NewCommits: countCommitsSince(repoPath, headBefore)}, nil
	}
	// remote 为空时无法反查 URL
	output, err := execGitWithEnv(repoPath, nil, args...)
	if err != nil {
		return PullResult{Output: output}, err
	}
	return PullResult{Output: output, NewCommits: countCommitsSince(repoPath, headBefore)}, nil
}

// headCommitID 当前 HEAD 指向的 commit id；未出生 HEAD（零提交仓库）/解析失败
// 返回空串。探测语义：失败是合法结果（空仓 pull 本身合法），不广播命令台
func headCommitID(repoPath string) string {
	out, err := execGitProbe(repoPath, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// countCommitsSince headBefore..HEAD 区间计数；headBefore 为空（pull 前无 HEAD，
// 典型：零提交仓库首拉）或计数失败时返回 -1 =「无法计量」，调用方不渲染摘要
func countCommitsSince(repoPath, headBefore string) int {
	if headBefore == "" {
		return -1
	}
	out, err := execGitProbe(repoPath, "rev-list", "--count", headBefore+"..HEAD")
	if err != nil {
		return -1
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil || n < 0 {
		return -1
	}
	return n
}

// resolvePushTarget 补全 Push 的缺省参数，保证 push 永远显式携带 <remote> <branch>：
//   - branch 为空（quick push 语义）：取当前分支
//   - remote 为空：优先该分支 upstream 的 remote（branch@{upstream} 形如 origin/feat），
//     其次 origin，再次唯一 remote；无任何 remote 时报错
//
// 此前 Remote 为空时 Branch 参数被静默忽略、退化为裸 `git push`（只推当前分支），
// 分支右键"推送"推的其实是当前分支——目标分支 ahead 永不归零，首页持续显示待推送
func resolvePushTarget(repoPath, remote, branch string) (string, string, error) {
	if branch == "" {
		b, err := GetCurrentBranch(repoPath)
		if err != nil || b == "" {
			return "", "", fmt.Errorf("cannot determine current branch")
		}
		branch = b
	}
	if remote == "" {
		if up, err := execGit(repoPath, "rev-parse", "--abbrev-ref", branch+"@{upstream}"); err == nil {
			// remote 名不含 /，首个 / 之前即 remote（"origin/feat" → "origin"）
			if i := strings.Index(strings.TrimSpace(up), "/"); i > 0 {
				remote = strings.TrimSpace(up)[:i]
			}
		}
	}
	if remote == "" {
		remotes, err := GetRemotes(repoPath)
		if err != nil || len(remotes) == 0 {
			return "", "", fmt.Errorf("no remote configured for push")
		}
		for _, r := range remotes {
			if r.Name == "origin" {
				remote = r.Name
				break
			}
		}
		if remote == "" {
			remote = remotes[0].Name
		}
	}
	return remote, branch, nil
}

// PushResult push 回执（P-20261005-215 首推判定）
type PushResult struct {
	// Output git push 原始输出，语义与历史 string 返回一致（错误面板留痕等）
	Output string
	// NewBranch 本次推送是否新建了远端分支（首推）。判定源是 push 前的本地事实：
	// 跟踪引用 refs/remotes/<remote>/<目标分支> 缺失——git 把「* [new branch]」
	// 回执写 stderr 而 execGitWithEnvLog 成功路径只回传 stdout，输出特征不可用。
	// 前端据此在成功 toast 附「创建 PR」外链（仅首推展示，PR 已建场景不重复打扰）
	NewBranch bool
}

// trackingRefExists 探测 refs/remotes/<remote>/<branch> 是否已有本地跟踪引用
// （探测语义：引用不存在等 rev-parse 失败一律视为「无」，是合法结果）。
// 表达的是本地事实（上次 fetch 时该远端分支存在）：远端已建而本地从未 fetch 的
// 分支会误判为首推——但该形态的 push 多因分叉被拒（失败路径不出成功 toast），
// 误判窗口可忽略；反向（分支曾被推送/拉取过）恒判非首推，正是「PR 已建不重复
// 打扰」要守的面。一次本地读命令，对涉网 push 开销可忽略（pull 前后 HEAD 快照
// P-20261003-202 同款取舍）
func trackingRefExists(repoPath, remote, branch string) bool {
	_, err := execGitProbe(repoPath, "rev-parse", "--verify", "--quiet", "refs/remotes/"+remote+"/"+branch)
	return err == nil
}

// Push到远程仓库
// 通过 execGitWithAuth 反查 remote URL 拿协议自动注入凭据
//
// 注意：曾经直接使用 `git push --set-upstream` 单条命令，但在某些凭据环境下
// 该组合会触发额外的 ls-remote 校验，进而引发 `Failed to authenticate user`。
// 现拆分为两步：先做不带 --set-upstream 的 push（远程分支不存在时也会自动创建），
// 成功后再通过 `branch --set-upstream-to` 设置跟踪关系，规避该认证问题。
func Push(repoPath string, req model.PushRequest) (PushResult, error) {
	remote, branch := req.Remote, req.Branch
	if remote == "" || branch == "" {
		r, b, err := resolvePushTarget(repoPath, remote, branch)
		if err != nil {
			return PushResult{}, err
		}
		if remote == "" {
			remote = r
		}
		if branch == "" {
			branch = b
		}
	}
	// 首推判定取 push 前快照（时序必须先于 push：推送成功后的 post-push fetch
	// 会创建跟踪引用，再探测恒为「存在」）。改推改名目标（local:remote）时以
	// 远端命名为准——远端分支是否新建看的是目标名
	target := branch
	if req.RemoteBranch != "" && req.RemoteBranch != branch {
		target = req.RemoteBranch
	}
	newBranch := !trackingRefExists(repoPath, remote, target)
	args := []string{"push"}
	if req.Force {
		args = append(args, "--force")
	} else if req.ForceWithLease {
		args = append(args, "--force-with-lease")
	}
	if req.FollowTags {
		args = append(args, "--follow-tags")
	} else if req.Tags {
		args = append(args, "--tags")
	}
	if req.RemoteBranch != "" && req.RemoteBranch != branch {
		args = append(args, remote, branch+":"+req.RemoteBranch)
	} else {
		args = append(args, remote, branch)
	}
	// 注入凭据：execGitWithAuth 反查 remote URL 后自动选 HTTPS / SSH 注入路径
	output, err := execGitWithAuth(repoPath, remote, args...)
	if err != nil {
		return PushResult{}, err
	}
	// push 后主动 fetch：确保本地 refs/remotes/<remote>/<branch> 最新，ahead 计数才能及时归零。
	// 注意：必须用 `git fetch <remote>`（无分支名），按 remote.<name>.fetch refspec 更新 tracking ref；
	// `git fetch <remote> <branch>` 只更新 FETCH_HEAD 不更新 refs/remotes/<remote>/<branch>。
	// 覆盖所有 push 入口（PushDialog/GitPanel/ChangesView/BranchesPanel）
	// 同样需要凭据注入：fetch private remote 时 helper 必须可达
	if _, ferr := execGitWithAuth(repoPath, remote, "fetch", remote); ferr != nil {
		// fetch 失败不影响 push 成功结果，仅附加警告
		output += "\n[warn] post-push fetch failed: " + ferr.Error()
	}
	if req.SetUpstream {
		remoteBranch := req.RemoteBranch
		if remoteBranch == "" {
			remoteBranch = branch
		}
		if _, upErr := execGit(repoPath, "branch", "--set-upstream-to="+remote+"/"+remoteBranch, branch); upErr != nil {
			output += "\n[warn] set-upstream failed: " + upErr.Error()
		}
	}
	return PushResult{Output: output, NewBranch: newBranch}, nil
}

// BranchExistsOnRemote 检查远程分支是否存在
// ls-remote 需要访问远程，必须注入凭据
func BranchExistsOnRemote(repoPath string, remote string, branch string) (bool, error) {
	output, err := execGitWithAuth(repoPath, remote, "ls-remote", "--heads", remote, branch)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(output) != "", nil
}

// LsRemoteWithURL 用注入的凭据对 rawURL 跑 ls-remote，验证 HTTPS 凭据是否有效
// 用途：generic 平台凭据测试——generic 无标准 /user API，改用真实 git 操作验证
// 成功（exit 0）= 凭据有效且仓库可达；失败 = 凭据无效 / 无权限 / 仓库不存在 / 网络不通
// 不带 repoPath：ls-remote 直接操作远程 URL，不依赖本地工作区
func LsRemoteWithURL(rawURL string) error {
	_, err := execGitWithURL("", rawURL, "ls-remote", "--heads", rawURL)
	return err
}

// lsRemoteBranchesTimeout 克隆前分支预取的 ls-remote 兜底超时（P-20261003-93）。
// 分支列表是克隆前的轻量探测、用户在前端等结果——远端拖过 10s 对随后的克隆
// 也好不了，快速失败让用户改走默认分支克隆；不用 classifyGitTimeout 的网络档
// 兜底（默认 15min 对预取而言过长）。
const lsRemoteBranchesTimeout = 10 * time.Second

// ListRemoteBranchesFromURL 克隆前预取远端分支名列表（P-20261003-93）：对 rawURL
// 跑 `ls-remote --heads`，按 ref 顺序返回 refs/heads/* 的分支名。
// 凭据注入与克隆同源：buildAuthEnvForURLWithKey 按 URL 协议注入（HTTPS 走
// credential-helper，SSH 按 sshKeyID 精确取钥匙——克隆对话框选钥语义），
// 不走 execGitWithURL：那条固定无选定密钥，且网络档兜底超时不合预取语义。
// 超时/进程组清理走 runWithTimeout（整组 kill 含 ssh 派生子进程）。
// 失败返回的 error 携带脱敏后的 git stderr——调用方（POST /api/clone/branches）
// 按其内容分类为「认证失败/仓库不可达」等稳定标记；脱敏必须先行，git 会把
// 含内嵌凭据的 URL 原样写进 stderr。
func ListRemoteBranchesFromURL(rawURL, sshKeyID string) ([]string, error) {
	env, cleanups, err := buildAuthEnvForURLWithKey(rawURL, sshKeyID)
	if err != nil {
		return nil, err
	}
	defer func() {
		for _, c := range cleanups {
			c()
		}
	}()

	args := []string{"ls-remote", "--heads", rawURL}
	cmd := exec.Command("git", append(gitLongPathsArgs(), args...)...)
	// ls-remote 直接操作远程 URL，本不需要任何本地仓库，但 cmd.Dir 留空会继承
	// 进程 cwd，git 启动期照常做仓库发现：本仓库的 dev worktree 由 Windows 创建，
	// 其 .git 指针文件写的是 Windows 绝对路径（gitdir: D:/...），在 Linux（wsl-verify
	// 于 worktree 内跑 go test）下解析必败——「fatal: not a git repository」先于
	// URL 处理直接致死（实测）。钉到系统临时目录让发现走空，命令只面对 rawURL。
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(), env...)
	setProcessGroup(cmd)

	// 全局并发门（P-20261004-125）：取得槽位才起进程。探测有 10s 兜底超时、
	// 占槽有界；门错误原样上抛（下方失败组装只带 stderr 文本）
	releaseGate, gerr := acquireGlobalGate(args)
	if gerr != nil {
		return nil, gerr
	}
	defer releaseGate()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	if err := runWithTimeout(cmd, lsRemoteBranchesTimeout); err != nil {
		detail := RedactCredentials(stderr.String())
		// 探测类失败不广播命令台（无项目归属），debug 记录便于排障
		slog.Debug("git ls-remote --heads failed", "url", redactArgs(args), "duration", time.Since(start), "err", detail)
		return nil, fmt.Errorf("git ls-remote: %s", strings.TrimSpace(detail))
	}
	return parseRemoteHeads(stdout.String()), nil
}

// parseRemoteHeads 解析 ls-remote --heads 输出：每行 `<sha>\t<ref>`，取 refs/heads/
// 前缀后的分支名，保持 git 的 ref 字典序。空行、无 tab 的行、非 heads ref（防御，
// --heads 下理论不出现）一律跳过；同名分支去重（Peeled 行 sha^{} 同理被 ref 前缀
// 过滤兜住）
func parseRemoteHeads(output string) []string {
	var branches []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		sha, ref, ok := strings.Cut(line, "\t")
		if !ok || sha == "" {
			continue
		}
		name, ok := strings.CutPrefix(ref, "refs/heads/")
		if !ok || name == "" || seen[name] {
			continue
		}
		seen[name] = true
		branches = append(branches, name)
	}
	return branches
}

// 获取远程仓库列表
func GetRemotes(repoPath string) ([]model.Remote, error) {
	output, err := execGit(repoPath, "remote", "-v")
	if err != nil {
		return nil, err
	}

	return parseRemotes(output), nil
}

// 添加远程仓库
func AddRemote(repoPath string, name string, url string) error {
	_, err := execGit(repoPath, "remote", "add", name, url)
	return err
}

// 删除远程仓库
func RemoveRemote(repoPath string, name string) error {
	_, err := execGit(repoPath, "remote", "remove", name)
	return err
}

func parseRemotes(output string) []model.Remote {
	var remotes []model.Remote
	seen := make(map[string]bool)
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}

		name := parts[0]
		url := parts[1]

		// 去重（fetch和push会有两行）
		key := name
		if seen[key] {
			continue
		}
		seen[key] = true

		remoteType := "fetch"
		if len(parts) >= 3 && parts[2] == "(push)" {
			remoteType = "push"
		}

		remotes = append(remotes, model.Remote{
			Name: name,
			URL:  url,
			Type: remoteType,
		})
	}

	return remotes
}
