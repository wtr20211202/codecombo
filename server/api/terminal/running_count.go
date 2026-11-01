package terminal

import (
	"net/http"

	shared "codecombo/server/api/shared"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// GetRunningCount GET /api/terminals/running-count?kind=（P-20261004-63）：
// OSC 133 运行态的服务端计数口——「现在有多少会话命令在跑」的跨设备真值。
//
// 消费位：
//   - 安全设置 Agent Token 轮换/撤销警示（前端 SecuritySettings 改读本端点，
//     替代浏览器 runningMap 快照——手机/桌面多端场景下单设备快照有盲区，
//     服务端计数是全局视角）；
//   - agent 自查「我的会话在跑吗」：响应带运行点亮会话 id 清单，agent 比对
//     $CC_TERMINAL_ID 即可，与计数同一往返。
//
// kind 过滤：空 = 全体会话 / shell / agent；非法值 400（稳定口径，不静默
// 归零——调用方拼错 kind 拿到 0 会误判「没有在跑的会话」）。
// 只读无状态查询，走常规 token 门（LockMiddleware + TokenAuth），无 AgentGuard
// （ListDevPorts 同款取向）。零运行态时 count=0 是诚实值：shell 集成未注入或
// 重启前已开始的命令不在计数（宁漏报不误报，边界见 oscstate.go 头注）
func GetRunningCount(c *gin.Context) {
	kind := c.Query("kind")
	if kind != "" && kind != terminal.KindShell && kind != terminal.KindAgent {
		shared.Error(c, http.StatusBadRequest, "invalid kind (shell or agent)", nil)
		return
	}
	count, total, runningIDs := terminal.DefaultManager.RunningCount(kind)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"kind":    kind,
		"count":   count,
		"total":   total,
		"running": runningIDs,
	}})
}
