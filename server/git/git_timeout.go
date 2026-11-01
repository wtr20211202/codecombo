package git

import (
	"fmt"
	"os/exec"
	"time"

	"codecombo/server/store"
)

// ── git 命令兜底超时（按命令类别分级 + 进程组整组清理） ──
//
// 历史：cmd.Run() 无任何超时，push/pull 卡住时 gin worker 与 git 进程持续累积；
// 后加固定 15 分钟兜底。遗留问题：本地读命令（status/log）因 index.lock 竞争或
// 存储挂起时同样吊满 15 分钟，且持有 index.lock 的挂起进程会让后续命令连锁挂起，
// 用户只能重启服务自救；超时 Kill 只杀 git 本身，网络操作派生的 ssh 子进程可能残留。
//
// 现策略：
//   - 本地读类命令 → 60s（正常毫秒级，挂起即环境异常，快速失败快速恢复）
//   - 其余（fetch/push/pull/merge/rebase/lfs 等网络与重操作）→ 可配置兜底
//     （settings.gitNetworkTimeoutSec，默认 900；语义与历史一致，仅新增可配置）
//   - 克隆走 stream.go 自带 ctx，不经此处
//
// 注意：不绑定 HTTP 请求 ctx——页面刷新/断网不能杀掉服务端正在执行的
// fetch/push（客户端断开 ≠ 用户想取消远端操作）。

// gitReadTimeout 本地读类命令兜底超时
const gitReadTimeout = 60 * time.Second

// gitNetworkTimeoutFallback 网络/重操作类默认兜底（未配置时与历史常量一致）
const gitNetworkTimeoutFallback = 15 * time.Minute

// gitNetworkTimeoutMin 允许配置的下限（防误配过小值导致正常远端操作被误杀）
const gitNetworkTimeoutMin = 30 * time.Second

// gitReadVerbs 本地只读命令动词（经 findSubcommand 定位）。这些命令不触网、
// 不改仓库状态，正常耗时毫秒级——挂起即环境异常（锁竞争/存储挂起）
var gitReadVerbs = map[string]bool{
	"status": true, "log": true, "diff": true, "show": true, "blame": true,
	"ls-files": true, "cat-file": true, "rev-parse": true, "rev-list": true,
	"for-each-ref": true, "grep": true, "reflog": true, "shortlog": true,
	"merge-base": true, "merge-tree": true, "describe": true, "symbolic-ref": true,
	"check-ignore": true, "version": true,
	// merge-tree：对象库内合成虚拟合并结果的只读原语（P-20261005-174 预演面），
	// 不触工作区不持 index，与 merge-base 同读档
}

// 部分动词带子命令，仅特定子命令是只读的（未列入的子命令保守归网络/重操作档）
var gitReadVerbSub = map[string]map[string]bool{
	"remote": {"-v": true, "get-url": true, "show": true},
	"stash":  {"list": true, "show": true},
	"config": {"--get": true, "--list": true, "--get-all": true},
}

// gitNetworkTimeout 当前网络/重操作类兜底超时（动态读设置，修改即时生效；
// store 未装配（部分单测环境）或未配置时回落默认）
func gitNetworkTimeout() time.Duration {
	st := store.Get()
	if st == nil {
		return gitNetworkTimeoutFallback
	}
	cfg := st.Settings.Get()
	if cfg == nil || cfg.Server.GitNetworkTimeoutSec <= 0 {
		return gitNetworkTimeoutFallback
	}
	d := time.Duration(cfg.Server.GitNetworkTimeoutSec) * time.Second
	if d < gitNetworkTimeoutMin {
		return gitNetworkTimeoutMin
	}
	return d
}

// classifyGitTimeout 按命令动词归类兜底超时（findSubcommand 复用 repo_cache 的
// 全局选项扫描，-C path / -c key=value 等形态已被正确跳过）
func classifyGitTimeout(args []string) time.Duration {
	verb := findSubcommand(args)
	if gitReadVerbs[verb] {
		return gitReadTimeout
	}
	// 带子命令的动词：仅白名单子命令算只读（如 stash list / remote -v）；
	// 子命令也可能是 flag 形态（remote -v），故 flag 与非 flag 都要过白名单
	if subs := gitReadVerbSub[verb]; subs != nil {
		// 定位动词位次（跳过全局选项及其值，与 findSubcommand 同款语义）
		i := 0
		for ; i < len(args); i++ {
			a := args[i]
			if globalOptsWithValue[a] {
				i++
				continue
			}
			if hasFlagPrefix(a) {
				continue
			}
			break
		}
		// 动词之后第一个命中白名单的参数（flag 或子命令）即定档
		for j := i + 1; j < len(args); j++ {
			a := args[j]
			if subs[a] {
				return gitReadTimeout
			}
			if hasFlagPrefix(a) {
				continue
			}
			break
		}
	}
	return gitNetworkTimeout()
}

func hasFlagPrefix(s string) bool { return len(s) > 0 && s[0] == '-' }

// runWithTimeout 带兜底超时的执行；超时时整组清理进程树后返回可读的超时错误。
// 等待 cmd 退出后才返回调用方，保证 stdout/stderr buffer 停止写入
func runWithTimeout(cmd *exec.Cmd, timeout time.Duration) error {
	// 兜底入组：unix 的整组清理依赖 Setpgid，构建路径（execGit 等）已设置，
	// 但任何未经过构建路径的裸调（如测试、未来新调用点）在此补齐——否则
	// killProcessTree 的负 PID 打在不存在的进程组上（静默 ESRCH），子进程
	// 杀不掉、<-done 挂到自然退出（WSL/Linux 实测：TestRunWithTimeout 挂 30s）
	if cmd.SysProcAttr == nil {
		setProcessGroup(cmd)
	}
	// Start 同步执行（原 cmd.Run() 整体丢 goroutine）：兜底极短时 timer 可能
	// 在 Start 仍在初始化 cmd.Process 时触发，killProcessTree 读 Process 字段
	// 与 Start 的写入构成 data race（WSL race 门禁实测报毒）。Start 提前后
	// kill 路径看到的 Process 必然完整；Start 错误同步返回、Wait 仍异步等，
	// 行为与原 Run 分解等价（顺带修复，A/B 实证纯 HEAD 即现，非 P-20261002-78 引入）
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		killProcessTree(cmd)
		<-done
		return fmt.Errorf("timed out after %v", timeout)
	}
}
