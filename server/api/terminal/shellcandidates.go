package terminal

import (
	"net/http"
	"runtime"

	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 终端 shell 候选探测（P-20261004-57）：设置页「默认 shell」下拉与会话创建
// 对话框「高级 · shell」共用的候选来源。候选序与探测语义见 terminal 包
// shell_windows.go / shell_unix.go / shell.go

// shellCandidatesData GET /api/terminals/shell-candidates 响应 data 段
type shellCandidatesData struct {
	// Platform windows / unix（前端据其渲染差异注记，探测本体在服务端）
	Platform string `json:"platform"`
	// SettingShell 设置里保存的默认 shell 原文（空串 = 未设置，跟随平台缺省）
	SettingShell string `json:"settingShell"`
	// DefaultShell 当前实际生效的默认 shell（getShell() 解析结果：设置有效取
	// 设置，否则平台缺省）——「跟随设置」档的展开预览与对话框缺省标注
	DefaultShell string                        `json:"defaultShell"`
	Candidates   []terminal.ShellCandidateInfo `json:"candidates"`
}

// ListShellCandidates GET /api/terminals/shell-candidates：平台 shell 候选清单
// （只读无守卫，与 agent-runtimes 同级的能力清单面）。设置值一并下发，前端免
// 二次 GET /settings 拼装下拉
func ListShellCandidates(c *gin.Context) {
	data := shellCandidatesData{
		Platform:   runtime.GOOS,
		Candidates: terminal.ShellCandidates(),
	}
	if cfg := store.Get().Settings.Get(); cfg != nil {
		data.SettingShell = cfg.Server.TerminalDefaultShell
	}
	data.DefaultShell = terminal.ResolveSessionShell("")
	c.JSON(http.StatusOK, gin.H{"data": data})
}
