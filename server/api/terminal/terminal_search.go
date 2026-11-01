package terminal

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	shared "codecombo/server/api/shared"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 跨会话输出检索（P-20261003-290）：GET /api/terminals/search?q=&limit=
// 「那个编译错误/端口号到底是哪个终端打的」的检索面——十几个会话常态下
// 逐个 Ctrl+F 不可运维，服务端 scrollback 缓存与读取口现成，本端点只补
// 跨会话聚合。取文本经 Session.CaptureScrollback（与 GET /terminals/:id/scrollback
// 同一规整化路径，tmux capture-pane / native 环形缓冲），ANSI 剥离复用
// terminal.StripANSI 单实现；扫描窗口/上限护栏见 terminal/search.go 常量。
// 只读检索走常规 token 门（LockMiddleware + TokenAuth）即可，无 AgentGuard。

// terminalOutputSearchMinRunes 查询词下限（rune 计，CJK 单字查询不被误伤，
// 与命令历史检索同参）：更短的宽泛词会在全部会话 scrollback 上扫出满屏噪声
const terminalOutputSearchMinRunes = 2

// SearchTerminalOutput GET /api/terminals/search?q=&limit=
// 遍历活会话（创建序）检索最近输出，返回 [{sessionId,sessionName,projectId,
// lineText,hitIndex}]（含 projectId 供前端跳转链切项目，超出提案原文四字段
// 的加列，向前兼容）。q TrimSpace 后 ≥2 字符，limit 收敛到 1~terminal.
// SearchTotal（默认总量上限）
func SearchTerminalOutput(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if utf8.RuneCountInString(q) < terminalOutputSearchMinRunes {
		shared.Error(c, http.StatusBadRequest, "query too short",
			fmt.Errorf("q must be at least %d characters", terminalOutputSearchMinRunes))
		return
	}
	limit := terminal.SearchTotal
	if n, err := strconv.Atoi(c.Query("limit")); err == nil && n > 0 && n < limit {
		limit = n
	}
	hits := terminal.SearchSessionsOutput(terminal.DefaultManager.ListSessions(), q, terminal.SearchPerSession, limit)
	if hits == nil {
		hits = []terminal.OutputHit{}
	}
	c.JSON(http.StatusOK, gin.H{"data": hits})
}
