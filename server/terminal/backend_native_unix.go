//go:build !windows

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty/v2"
)

// nativeBackend 原生 PTY 后端（Unix）
// 通过 creack/pty 启动 shell 子进程，行为与重构前的 pty_unix.go 完全一致
type nativeBackend struct{}

// newNativeBackend 创建 native 后端实例
func newNativeBackend() PtyBackend {
	return &nativeBackend{}
}

// unixPtyConn Unix PTY 连接，包装 *os.File 与 exec.Cmd
type unixPtyConn struct {
	*os.File
	cmd *exec.Cmd
}

func (c *unixPtyConn) Close() error {
	// 整组清理：pty.Start 以 Setsid 启动（子进程为会话首，pgid=pid），
	// 对进程组发 SIGKILL 连带忽略 SIGHUP 的孙进程（npm dev、构建工具），
	// 与 Windows 侧 JobObject 整组杀语义对齐（历史缺陷只杀 shell 本体）
	if c.cmd.Process != nil {
		if err := syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL); err != nil {
			_ = c.cmd.Process.Kill()
		}
	}
	return c.File.Close()
}

// Wait 等待子进程退出，返回进程状态
func (c *unixPtyConn) Wait() (*os.ProcessState, error) {
	err := c.cmd.Wait()
	return c.cmd.ProcessState, err
}

// Create 启动 shell 子进程并返回 PTY 连接
func (b *nativeBackend) Create(spec SessionSpec) (ptyConn, error) {
	args := []string{}
	env := spec.Env
	if spec.Setup != nil {
		args = append(args, spec.Setup.Args...)
		env = append(env, spec.Setup.Env...)
	}

	cmd := exec.Command(spec.Shell, args...)
	cmd.Dir = spec.Dir
	cmd.Env = env

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("start pty: %v", err)
	}

	return &unixPtyConn{File: ptmx, cmd: cmd}, nil
}

// CaptureScrollback native 模式无 scrollback 重放能力，返回 nil
func (b *nativeBackend) CaptureScrollback(spec SessionSpec, maxLines int) ([]byte, error) {
	return nil, nil
}

// CaptureHistory native 无持久化会话，重放走 Session 自身的字节环缓冲（含可视区）
func (b *nativeBackend) CaptureHistory(spec SessionSpec, maxLines int) ([]byte, error) {
	return nil, nil
}

// RedrawClient native 无 tmux 客户端重绘概念，no-op
func (b *nativeBackend) RedrawClient(spec SessionSpec) {}

// Resize 调整 PTY 尺寸
func (b *nativeBackend) Resize(conn ptyConn, spec SessionSpec, rows, cols uint16) error {
	if uc, ok := conn.(*unixPtyConn); ok {
		return pty.Setsize(uc.File, &pty.Winsize{Rows: rows, Cols: cols})
	}
	return nil
}

// Kill native 模式下彻底关闭等同 ptyConn.Close()（杀 shell 进程）
func (b *nativeBackend) Kill(conn ptyConn, spec SessionSpec) error {
	return conn.Close()
}

// Alive native 模式下始终返回 true（直到 Close 被调用）
func (b *nativeBackend) Alive(spec SessionSpec) bool {
	return true
}

// IsPersistent native 模式下 shell 进程死即 session 终结，无法重连
func (b *nativeBackend) IsPersistent() bool {
	return false
}

// Reattach native 模式不支持重连，返回 error
func (b *nativeBackend) Reattach(spec SessionSpec) (ptyConn, error) {
	return nil, fmt.Errorf("native backend does not support reattach")
}
