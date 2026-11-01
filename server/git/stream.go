package git

import (
	"bufio"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// progressSplit 是 bufio.Scanner 的自定义 SplitFunc，
// 按 \r 和 \n 同时切分（git --progress 的进度行用 \r 分隔更新，逐行刷新）
func progressSplit(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\r' || b == '\n' {
			if i == 0 {
				// 连续分隔符，跳过避免空 token
				return 1, nil, nil
			}
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// scanLines 从 reader 按进度行扫描，每个非空行回调 onLine
func scanLines(reader io.Reader, onLine func(string)) {
	scanner := bufio.NewScanner(reader)
	// 进度行可能较长（含百分比、计数、速率），缓冲设大一些
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	scanner.Split(progressSplit)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), " \t")
		if line != "" {
			onLine(line)
		}
	}
}

// execGitStreaming 流式执行 git 命令，stderr/stdout 按行回调 onLine。
// 支持 context 取消（CommandContext 会在 ctx 取消时自动 kill 子进程）。
// extraEnv 为追加的环境变量（如 GIT_ASKPASS、SC_USER/SC_PASS），形如 KEY=VALUE。
// 注意：onLine 会在两个 goroutine 里并发调用（stdout + stderr），调用方需自行保证线程安全。
func execGitStreaming(ctx context.Context, workDir string, onLine func(string), extraEnv []string, args ...string) error {
	// 全局并发门（P-20261004-125）：克隆属长耗时网络操作、占槽可达分钟级，
	// 但它同样是真实 git 进程——总量防线必须计入（容量 8 下克隆最多挤占 8 格，
	// 读类仍有槽位轮转）。排队等待传用户 ctx：取消中的克隆不该继续在门上傻等。
	// 临界区只有进程启动/流式读/等待，无嵌套 execGit（死锁审查见 globalgate.go）
	releaseGate, gerr := acquireGlobalGateCtx(ctx, args, gitGateWaitTimeout)
	if gerr != nil {
		return gerr
	}
	defer releaseGate()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = workDir
	// GIT_TERMINAL_PROMPT=0：避免 git 在需要凭据时卡在 TTY 输入等待
	// 未设置时，遇到重定向/认证等情况，git.exe 会阻塞等待 stdin 输入，导致克隆挂起
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if len(extraEnv) > 0 {
		cmd.Env = append(cmd.Env, extraEnv...)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	// 并发消费 stdout 和 stderr（git --progress 的进度走 stderr）
	// 必须用 WaitGroup 等待 scanner 结束后再调 cmd.Wait：StdoutPipe 文档明确要求
	// "Wait 之前必须读完所有数据"，否则 Wait 会关闭管道导致 scanner 读到 EOF 后才返回，
	// 进程级别的资源释放也会推迟，整体表现就是 git.exe 卡住不退出。
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		scanLines(stdout, onLine)
	}()
	go func() {
		defer wg.Done()
		scanLines(stderr, onLine)
	}()
	wg.Wait()

	err = cmd.Wait()
	// context 取消优先返回取消错误
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
