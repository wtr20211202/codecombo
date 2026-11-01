package remoteterminal

import "time"

// SessionSpec 创建远程终端会话所需参数
type SessionSpec struct {
	ID     string
	HostID string
	Rows   uint16
	Cols   uint16
	// TmuxName 非空时在远端 tmux 会话中启动（attach-or-create，缺失 tmux 时回退原生 shell）。
	// 命名由 API 层生成并校验字符集（[A-Za-z0-9_-]，可安全内嵌 shell 命令）
	TmuxName string
}

// PTYConn 远程 PTY 连接抽象（SSH channel 的最小契约）
// 生产实现包装 sshclient 连接（由 Task 6 的 API 层接线）；测试注入 mock
type PTYConn interface {
	// Write 键盘输入 → 远端
	Write(p []byte) (int, error)
	// Read 远端输出 ←
	Read(p []byte) (int, error)
	// Resize 同步远端 PTY 尺寸
	Resize(rows, cols uint16) error
	// Close 关闭连接
	Close() error
	// SetReadDeadline Kill 时唤醒阻塞在 Read 上的 readLoop
	//（生产实现尽力而为；无 deadline 能力的实现可 no-op，靠 Close 兜底）
	SetReadDeadline(t time.Time) error
}

// Dialer SSH 拨号抽象：按 spec 建立远程主机的 PTY 连接
// 生产实现的凭据解析在 API 层（Task 6 注入），本包只依赖接口——测试注入 mock
type Dialer interface {
	DialPTY(spec SessionSpec) (PTYConn, error)
}
