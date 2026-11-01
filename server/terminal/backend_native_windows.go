//go:build windows

package terminal

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"unsafe"

	"github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/windows"
)

// nativeBackend 原生 PTY 后端（Windows）
// 通过 aymanbagabas/go-pty ConPTY 启动 shell 子进程
type nativeBackend struct{}

// newNativeBackend 创建 native 后端实例
func newNativeBackend() PtyBackend {
	return &nativeBackend{}
}

// winPtyConn Windows ConPTY 连接
type winPtyConn struct {
	pty.Pty
	proc *os.Process
	cmd  *pty.Cmd
	// cleanupJob 非 nil 时 Close 调用它会关闭 JobObject 句柄，触发 KILL_ON_JOB_CLOSE
	// 把 shell 及其子孙进程（npm run dev / build 工具链等）整组清理，避免孤儿进程
	// 用闭包封装避免把 windows.Handle 这种平台类型暴露到跨文件结构体字段
	cleanupJob func()
}

func (c *winPtyConn) Close() error {
	if c.proc != nil {
		_ = c.proc.Kill()
	}
	if c.cleanupJob != nil {
		c.cleanupJob()
		c.cleanupJob = nil
	}
	return c.Pty.Close()
}

// Wait 等待子进程退出，返回进程状态
func (c *winPtyConn) Wait() (*os.ProcessState, error) {
	if c.cmd != nil {
		err := c.cmd.Wait()
		return c.cmd.ProcessState, err
	}
	if c.proc != nil {
		return c.proc.Wait()
	}
	return nil, fmt.Errorf("no process to wait")
}

// Create 启动 shell 子进程并返回 ConPTY 连接
// Start 成功后立即把 shell 进程绑定到 JobObject（KILL_ON_JOB_CLOSE），
// 让 Close() 能整组清理，避免 npm/dev server 等子进程成为孤儿
func (b *nativeBackend) Create(spec SessionSpec) (ptyConn, error) {
	// go-pty 的 lookExtensions 在设置了 Dir 时会将 shell 名拼接到工作目录下查找，
	// 导致找不到 powershell.exe 等系统命令。这里先解析完整路径。
	shellPath, err := exec.LookPath(spec.Shell)
	if err != nil {
		return nil, fmt.Errorf("shell not found in PATH: %s: %v", spec.Shell, err)
	}
	slog.Debug("terminal: resolved shell", "from", spec.Shell, "to", shellPath)

	p, err := pty.New()
	if err != nil {
		return nil, fmt.Errorf("create conpty: %v", err)
	}

	args := []string{}
	env := spec.Env
	if spec.Setup != nil {
		args = append(args, spec.Setup.Args...)
		env = append(env, spec.Setup.Env...)
	}

	cmd := p.Command(shellPath, args...)
	cmd.Dir = spec.Dir
	cmd.Env = env

	if err := cmd.Start(); err != nil {
		p.Close()
		return nil, fmt.Errorf("start command: %v", err)
	}

	// 创建 JobObject 并绑定 shell 进程（KILL_ON_JOB_CLOSE：JobObject 关闭时整组被杀）
	// 失败仅记录，不影响主流程（fallback 到原 Kill 主进程行为，可能有孤儿但终端仍可用）
	conn := &winPtyConn{Pty: p, proc: cmd.Process, cmd: cmd}
	job, jobErr := createKillOnCloseJob()
	if jobErr != nil {
		slog.Warn("terminal: create job object failed, orphans possible",
			"pid", cmd.Process.Pid, "err", jobErr)
	} else if err := assignProcessToJob(job, cmd.Process.Pid); err != nil {
		slog.Warn("terminal: assign process to job failed, orphans possible",
			"pid", cmd.Process.Pid, "err", err)
		_ = windows.CloseHandle(job)
	} else {
		// 闭包捕获 handle，Close 时通过 cleanupJob 触发整组清理
		conn.cleanupJob = func() {
			_ = windows.CloseHandle(job)
		}
		slog.Debug("terminal: process bound to job object", "pid", cmd.Process.Pid)
	}

	slog.Info("terminal: process started", "pid", cmd.Process.Pid, "dir", spec.Dir)
	return conn, nil
}

// createKillOnCloseJob 创建带 KILL_ON_JOB_CLOSE flag 的 JobObject
// Close 关闭句柄时，所有绑定到该 Job 的进程（含子孙）会被整组杀掉
func createKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create job object: %v", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("set job object info: %v", err)
	}
	return job, nil
}

// assignProcessToJob 把指定 PID 的进程绑定到 JobObject
// 通过 OpenProcess 重新拿一份句柄用于 Assign，Assign 后立即释放该临时句柄
// （JobObject 会持续持有进程引用，临时句柄无需保留）
// AssignProcessToJobObject 实际需要 SET_QUOTA + TERMINATE 双权限：仅申请
// SET_QUOTA 时每次都 Access denied（×200/实例，作业绑定全数失败→退出孤儿
// 化）。最小权限让位于功能正确性
func assignProcessToJob(job windows.Handle, pid int) error {
	procHandle, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(pid),
	)
	if err != nil {
		return fmt.Errorf("open process: %v", err)
	}
	defer func() { _ = windows.CloseHandle(procHandle) }()
	return windows.AssignProcessToJobObject(job, procHandle)
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

// Resize 调整 ConPTY 尺寸
func (b *nativeBackend) Resize(conn ptyConn, spec SessionSpec, rows, cols uint16) error {
	if wc, ok := conn.(*winPtyConn); ok {
		return wc.Pty.Resize(int(cols), int(rows))
	}
	return nil
}

// Kill native 模式下彻底关闭等同 ptyConn.Close()（杀 shell 进程 + Job 整组）
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
