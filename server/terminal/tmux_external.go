package terminal

import (
	"strconv"
	"strings"
)

// 外部 tmux 会话接管（P-20261005-189）：服务器上用户手动/脚本起的 tmux 会话
// （SSH attach 的那种、nohup 挂着的构建/训练任务）住用户默认 socket，与本系统
// 专属 socket（-L simple-coding）天然隔离。本文件承载跨平台形状（条目结构/
// 解析/校验）；执行面在 tmux_external_unix.go（unix）与 tmux_windows_stub.go。
// 接管本体在 manager.go（AttachExternalSession：跳过 new-session/环境注入/
// 引导占位，TmuxName 指向外部会话名）；接管后的读写/搜索/导出全链与自建会话
// 共用，仅 socket 经 runTmuxFor 分流

// ExternalTmuxSession 外部 tmux 会话条目（GET /api/terminals/external-sessions）
type ExternalTmuxSession struct {
	// Name tmux 会话名（接管请求的 attachTmux 即此值）
	Name string `json:"name"`
	// Attached 附着的 tmux 客户端数（SSH attach 的终端等）：≥1 时接管后多端
	// 同屏回显是 tmux 特性，UI 据此提示
	Attached int `json:"attached"`
	// CreatedAt 会话创建时刻（unix 秒；解析失败为 0，展示端空显不虚构）
	CreatedAt int64 `json:"createdAt"`
	// Windows 会话内窗口数
	Windows int `json:"windows"`
	// Activity 最近活动时刻（unix 秒；0=不可考）
	Activity int64 `json:"activity"`
	// TakenOver 已被本系统接管（Manager 在册）：前端置灰防重复接管
	TakenOver bool `json:"takenOver"`
}

// parseExternalTmuxSessions 解析 list-sessions -F 输出（纯函数，供单测）。
// \t 分隔与 recover.go 同款解析口径；畸形行跳过不致命（数字段解析失败按
// 零值处理，诚实缺省）
func parseExternalTmuxSessions(out string) []ExternalTmuxSession {
	sessions := make([]ExternalTmuxSession, 0, 8)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 1 || strings.TrimSpace(f[0]) == "" {
			continue
		}
		s := ExternalTmuxSession{Name: strings.TrimSpace(f[0])}
		if len(f) > 1 {
			s.Attached, _ = strconv.Atoi(strings.TrimSpace(f[1]))
		}
		if len(f) > 2 {
			s.CreatedAt, _ = strconv.ParseInt(strings.TrimSpace(f[2]), 10, 64)
		}
		if len(f) > 3 {
			s.Windows, _ = strconv.Atoi(strings.TrimSpace(f[3]))
		}
		if len(f) > 4 {
			s.Activity, _ = strconv.ParseInt(strings.TrimSpace(f[4]), 10, 64)
		}
		sessions = append(sessions, s)
	}
	return sessions
}

// ValidateExternalTmuxName 接管请求的会话名预检：tmux 会话名不含 '.'/':' 与
// 空白（tmux 自身约束，违规名 attach 必败，预检给出可读失败）；长度上限防御性
// 截住超长输入。返回空串 = 合法
func ValidateExternalTmuxName(name string) string {
	if name == "" {
		return "tmux session name is required"
	}
	if len(name) > 128 {
		return "tmux session name too long (max 128)"
	}
	if strings.ContainsAny(name, ".: \t\r\n") {
		return "tmux session name must not contain '.', ':' or whitespace"
	}
	return ""
}
