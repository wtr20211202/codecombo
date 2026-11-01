package git

import (
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"codecombo/server/model"
)

// BroadcastFunc 广播回调，由上层注入以解耦 git 和 api 包
type BroadcastFunc func(projectID string, msg model.WSMessage)

// PathResolver 由 workDir 反查 projectID，由上层注入
type PathResolver func(workDir string) string

var (
	// broadcastFn / pathResolverFn 出站装配点：由 git 模块 Init 直接赋值
	//（roadmap M1.5/M2.1：原导出 setter 已消除，装配收敛进模块生命周期）
	broadcastFn    BroadcastFunc
	pathResolverFn PathResolver
)

// logGitCmd 记录 git 命令日志并在失败时广播到前端命令标签
// output 为 stdout 内容（失败分支也传入，保持签名一致）
// args 经 redactArgs 脱敏——错误消息/广播里的 URL 不携带内嵌凭据
func logGitCmd(args []string, workDir string, elapsed time.Duration, err error, errStr, output string) {
	argsStr := redactArgs(args)
	if err != nil {
		slog.Debug("git command failed", "args", argsStr, "dir", workDir, "duration", elapsed, "err", errStr)
		broadcastFailure(argsStr, workDir, output, errStr)
	} else {
		slog.Debug("git command", "args", argsStr, "dir", workDir, "duration", elapsed)
	}
}

// logGitCmdQuiet 同 logGitCmd，但失败不广播——用于探测类命令
func logGitCmdQuiet(args []string, workDir string, elapsed time.Duration, err error, errStr, output string) {
	argsStr := redactArgs(args)
	if err != nil {
		slog.Debug("git probe failed (not broadcast)", "args", argsStr, "dir", workDir, "duration", elapsed, "err", errStr)
	} else {
		slog.Debug("git command", "args", argsStr, "dir", workDir, "duration", elapsed)
	}
}

// maxBroadcastOutput 单条 git 失败广播携带的 stdout/stderr 上限（字节）。
// 失败的 grep/diff 可能产生 MB 级输出，全量广播会被序列化后复制给该项目
// 每一个 WS 客户端，形成内存与广播双重放大；8KB 足够定位问题
const maxBroadcastOutput = 8 * 1024

// truncateOutput 截断超长输出并附截断标记
func truncateOutput(s string) string {
	if len(s) <= maxBroadcastOutput {
		return s
	}
	return s[:maxBroadcastOutput] + "\n...[truncated]"
}

// broadcastFailure 构造 CommandLog 并通过注入的广播函数推送
// 未注入或反查不到 projectID 时静默跳过。argsStr 为已脱敏的参数串
func broadcastFailure(argsStr string, workDir, output, errStr string) {
	if broadcastFn == nil || pathResolverFn == nil {
		return
	}
	projectID := pathResolverFn(workDir)
	if projectID == "" {
		return
	}
	broadcastFn(projectID, model.WSMessage{
		Type: "git.command",
		Data: model.CommandLog{
			Command:   "git",
			Args:      argsStr,
			Output:    truncateOutput(output),
			Error:     truncateOutput(errStr),
			WorkDir:   workDir,
			Timestamp: time.Now().Format(time.RFC3339),
		},
	})
}

// 执行git命令并返回输出
func execGit(workDir string, args ...string) (string, error) {
	return execGitWithEnv(workDir, nil, args...)
}

// gitLongPathsArgs Windows 上启用 git 超长路径支持（决策门 M5.3）：
// git for Windows 自身受 MAX_PATH(260) 限制，深嵌套工作区（node_modules 等是
// 经典重灾区）会让 status/add/checkout 失败；`-c core.longpaths=true` 按命令
// 启用 \\?\ 形式路径，短路径行为不变。直接文件操作无需此参数——Go 运行时
// 原生处理超长路径（见 server/api/files/longpath_test.go 的判定依据）。
func gitLongPathsArgs() []string {
	if runtime.GOOS == "windows" {
		return []string{"-c", "core.longpaths=true"}
	}
	return nil
}

// execGitWithEnv 执行 git 命令，extraEnv 为追加的环境变量（形如 KEY=VALUE）
// 用于注入 GIT_ASKPASS / SC_USER / SC_PASS 等凭据相关变量。
// 兜底超时按命令类别分级（见 git_timeout.go：本地读类 60s，网络/重操作类可配置），
// 超时整组清理进程树（含 ssh 等派生子进程）
func execGitWithEnv(workDir string, extraEnv []string, args ...string) (string, error) {
	return execGitWithEnvLog(workDir, extraEnv, logGitCmd, args...)
}

// execGitProbe 以「探测」语义执行 git 读命令：退出码非 0 是合法结果
// （config --get 读取未配置键、--file 读不存在的配置文件等），不代表异常，
// 不向前端命令台广播失败——否则仓库管理/GPG/设置面板每次打开都会把
// 「未配置」误报成命令错误并点亮红标
func execGitProbe(workDir string, args ...string) (string, error) {
	return execGitWithEnvLog(workDir, nil, logGitCmdQuiet, args...)
}

// execGitDiffNoIndex 执行 `git diff --no-index`（仅供 untrackedPatchSegments
// 的 untracked 追补链使用，勿作他用）：diff(1) 退出码约定「有差异即退出 1」
// ——新文件对 os.DevNull 恒有差异，退出 1 是常态结果而非失败。execGit 把
// 非零退出统一当失败并丢弃 stdout（stdout 恰是补丁本体），故此处保留输出、
// 仅吞 exit 1；其余失败（真错误/超时）照常上抛。读类命令不经写队列（与
// execGit 读路径同语义），走探测式静默日志（exit 1 不当失败广播命令台）
func execGitDiffNoIndex(workDir string, args ...string) (string, error) {
	cmd := exec.Command("git", append(gitLongPathsArgs(), args...)...)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	setProcessGroup(cmd)

	// 全局并发门（P-20261004-125）：取得槽位才起进程。门错误必须在此原样
	// 上抛——下方失败组装用 stderr 文本构造错误、会吞掉 runWithTimeout 的
	// err（含稳定标记），与超时错误的既有处理同理
	releaseGate, gerr := acquireGlobalGate(args)
	if gerr != nil {
		return "", gerr
	}
	defer releaseGate()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := runWithTimeout(cmd, classifyGitTimeout(args))
	out := stdout.String()
	errStr := RedactCredentials(stderr.String())

	if err != nil && strings.Contains(err.Error(), "exit status 1") {
		// diff(1) 约定内的「有差异」：按成功语义记日志（mustDiff 同款哲学）
		logGitCmdQuiet(args, workDir, time.Since(start), nil, "", out)
		return out, nil
	}
	logGitCmdQuiet(args, workDir, time.Since(start), err, errStr, out)
	if err != nil {
		return "", fmt.Errorf("git %s: %s", redactArgs(args), errStr)
	}
	return out, nil
}

// execGitWithEnvLog 执行体的公共实现，日志/广播策略由调用方注入。
// 写类命令先按仓库进串行队列（writequeue.go，防 agent 与人的并发写撞
// index.lock），读/网络类直通——所有 execGit* 路径（含凭据注入的
// execGitWithAuth/WithURL）都汇于此，push/fetch/pull 经分类直通不持锁
func execGitWithEnvLog(workDir string, extraEnv []string, logFn func(args []string, workDir string, elapsed time.Duration, err error, errStr, output string), args ...string) (string, error) {
	release, qerr := acquireRepoWriteSlot(workDir, args, logFn)
	if qerr != nil {
		return "", qerr
	}
	defer release()

	cmd := exec.Command("git", append(gitLongPathsArgs(), args...)...)
	cmd.Dir = workDir
	// GIT_TERMINAL_PROMPT=0：避免 git 在需要凭据时卡在 TTY 输入等待
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if len(extraEnv) > 0 {
		cmd.Env = append(cmd.Env, extraEnv...)
	}
	setProcessGroup(cmd)

	// 全局并发门（P-20261004-125）：在写队列（per-repo 互斥）之下兜底进程
	// 总量，取锁顺序恒为「写槽位 → 全局槽位」（无反向路径，见 globalgate.go
	// 死锁审查）。门错误必须在此原样上抛——下方失败组装用 stderr 文本构造
	// 错误、会吞掉 runWithTimeout 的 err（含稳定标记）
	releaseGate, gerr := acquireGlobalGate(args)
	if gerr != nil {
		return "", gerr
	}
	defer releaseGate()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := runWithTimeout(cmd, classifyGitTimeout(args))
	output := stdout.String()
	// stderr 进入广播与错误返回前统一脱敏：push/fetch 失败时 git 会把
	// remote URL（可能内嵌凭据）原样写进 stderr
	errStr := RedactCredentials(stderr.String())

	logFn(args, workDir, time.Since(start), err, errStr, output)

	// 写操作统一失效钩子：提交/推送/切分支等成功后使仓库缓存失效，
	// 保证 ahead 徽章与项目卡片信息在缓存窗口内依然即时正确
	maybeInvalidateCaches(workDir, args, err)

	if err != nil {
		// 遗留锁检测（P-20261002-150）：写命令因 index.lock 失败且锁已陈旧时
		// 错误升级为可识别标记，前端据此出修复条
		return "", upgradeIndexLockError(workDir, args, errStr, fmt.Errorf("git %s: %s", redactArgs(args), errStr))
	}
	return output, nil
}

// 通过stdin执行git命令（超时与进程组清理策略同 execGitWithEnv）。
// apply --cached / am 等经此路径的写命令同样按仓库串行（与 execGitWithEnvLog
// 共用同一队列，两类入口互斥对齐）
func execGitWithStdin(workDir string, stdinContent string, args ...string) (string, error) {
	release, qerr := acquireRepoWriteSlot(workDir, args, logGitCmd)
	if qerr != nil {
		return "", qerr
	}
	defer release()

	cmd := exec.Command("git", append(gitLongPathsArgs(), args...)...)
	cmd.Dir = workDir
	cmd.Stdin = strings.NewReader(stdinContent)
	setProcessGroup(cmd)

	// 全局并发门（P-20261004-125）：与 execGitWithEnvLog 同序（写槽位 →
	// 全局槽位）；门错误原样上抛（下方失败组装会吞 err 文本）
	releaseGate, gerr := acquireGlobalGate(args)
	if gerr != nil {
		return "", gerr
	}
	defer releaseGate()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := runWithTimeout(cmd, classifyGitTimeout(args))
	output := stdout.String()
	errStr := RedactCredentials(stderr.String())

	logGitCmd(args, workDir, time.Since(start), err, errStr, output)

	if err != nil {
		// 同 execGitWithEnvLog：apply --cached / am 等经 stdin 的写命令同样受
		// index.lock 遗留锁影响，失败时走同一检测升级
		return "", upgradeIndexLockError(workDir, args, errStr, fmt.Errorf("git %s: %s", redactArgs(args), errStr))
	}
	return output, nil
}

// 检查路径是否为有效的Git仓库
func IsRepo(path string) bool {
	_, err := execGit(path, "rev-parse", "--git-dir")
	return err == nil
}

// IsRepoProbe 同 IsRepo 但走探测语义（execGitProbe）：非仓库目录的 rev-parse
// 失败是合法探测结果而非异常，不向前端命令台广播。对任意 cwd 的预检面
// （command-preview，用户终端可能停在非 git 目录）用它，避免每次预检都把
// 「不是仓库」误报成命令错误点亮红标
func IsRepoProbe(path string) bool {
	_, err := execGitProbe(path, "rev-parse", "--git-dir")
	return err == nil
}
