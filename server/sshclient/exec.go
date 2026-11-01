package sshclient

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/ssh"
)

// ExecOptions 执行参数
type ExecOptions struct {
	Env  map[string]string
	Cmd  string
	Sudo bool
}

// ExecOutput 命令输出
type ExecOutput struct {
	Stdout   []string
	Stderr   []string
	ExitCode int
}

// LineHandler 实时行处理器（stream = "stdout" | "stderr"）
type LineHandler func(stream string, line string)

// Exec 执行命令并实时回调每行输出
func (c *Client) Exec(ctx context.Context, opts ExecOptions, handler LineHandler) (*ExecOutput, error) {
	cmd := opts.Cmd
	if opts.Sudo {
		cmd = "sudo " + cmd
	}
	// 通过 export 注入 env（不依赖 ssh Setenv）
	if len(opts.Env) > 0 {
		var exports []string
		for k, v := range opts.Env {
			exports = append(exports, fmt.Sprintf("export %s=%s", k, shellQuote(v)))
		}
		cmd = strings.Join(exports, "; ") + "; " + cmd
	}

	session, err := c.UnderlyingClient().NewSession()
	if err != nil {
		return nil, fmt.Errorf("new session: %w", err)
	}
	defer session.Close()

	stdoutPipe, err := session.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := session.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	var stdoutBuf, stderrBuf bytes.Buffer

	// goroutine 扫描输出，同时写入 buffer 和触发 handler
	scan := func(r io.Reader, stream string, buf *bytes.Buffer) {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			buf.WriteString(line)
			buf.WriteString("\n")
			if handler != nil {
				handler(stream, line)
			}
		}
	}
	scanDone := make(chan struct{}, 2)
	go func() { scan(stdoutPipe, "stdout", &stdoutBuf); scanDone <- struct{}{} }()
	go func() { scan(stderrPipe, "stderr", &stderrBuf); scanDone <- struct{}{} }()

	done := make(chan error, 1)
	go func() { done <- session.Run(cmd) }()

	select {
	case <-ctx.Done():
		// 取消时仅 session.Signal 在很多 SSH 服务端不可靠（RFC 4254 §6.9 可选），
		// sudo 密码提示、卡在 I/O 的进程都不会响应 SIGKILL。必须 Close 通道，
		// 强制 session.Run 返回，否则 <-done 会永久阻塞 → 取消按钮失灵。
		_ = session.Signal(ssh.SIGKILL)
		_ = session.Close()
		<-done
		<-scanDone
		<-scanDone
		return nil, ctx.Err()
	case err := <-done:
		<-scanDone
		<-scanDone
		exitCode := 0
		if err != nil {
			if ee, ok := err.(*ssh.ExitError); ok {
				exitCode = ee.ExitStatus()
			} else {
				exitCode = 1
			}
		}
		return &ExecOutput{
			Stdout:   splitLines(stdoutBuf.String()),
			Stderr:   splitLines(stderrBuf.String()),
			ExitCode: exitCode,
		}, err
	}
}

func splitLines(s string) []string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// shellQuote 简易 shell 引号包裹，避免特殊字符注入
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if !needsQuoting(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

// QuoteArg 导出版 shellQuote：供跨包拼装远端命令串时引用路径等用户可控
// 值（P-20261004-34 git 对照命令模板）——引号规则与 Exec 的 env 注入同源，
// 单一实现防两处漂移
func QuoteArg(s string) string { return shellQuote(s) }

func needsQuoting(s string) bool {
	for _, r := range s {
		switch r {
		case ' ', '\'', '"', '$', '`', '\\', '\n', ';', '|', '&', '>', '<':
			return true
		}
	}
	return false
}

// SanitizeCommandForLog 在日志中隐藏 token/password 等敏感值
func SanitizeCommandForLog(cmd string) string {
	lines := strings.Split(cmd, "; ")
	for i, l := range lines {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "export ") && strings.Contains(l, "=") {
			eq := strings.Index(l, "=")
			lines[i] = l[:eq+1] + "***"
		}
	}
	return strings.Join(lines, "; ")
}
