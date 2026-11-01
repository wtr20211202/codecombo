package terminal

import (
	"net/http"

	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// ListDevPorts GET /api/terminals/ports（P-20261003-293 端口注册表查询口）：
// 当前登记的 dev 端口清单 [{port,sessionId,sessionName,projectId,label,source,
// firstSeen,lastSeen}]——agent 起 dev server 前的「选自由端口」查询原语（避开
// 已知占用；舰队运维族：与广播/检索同册 ops 手册 terminal 节），前端「端口占用
// 一览」浮层同源。会话名/项目归属读取时经 GetSession 现查（登记条目不落名，改名
// 即时生效；会话刚关闭的窄竞态下条目已随摘除面回收，此处兜底空名）。
// lastSeen（P-20261007-14 增量字段）：最近一次登记/刷新时刻，消费方标注观测
// 时效；旧字段语义不变，增量对既有调用方透明。
// 登记面 = 探测/上报面：未被探测正则覆盖或 agent 未上报的监听不在列（消费方
// 注记诚实边界）。只读无状态查询，走常规 token 门（LockMiddleware + TokenAuth），
// 无 AgentGuard
func ListDevPorts(c *gin.Context) {
	entries := terminal.DefaultManager.ListDevPorts()
	out := make([]gin.H, 0, len(entries))
	for _, e := range entries {
		item := gin.H{
			"port":      e.Port,
			"sessionId": e.SessionID,
			"label":     e.Label,
			"source":    e.Source,
			"firstSeen": e.FirstSeen,
			"lastSeen":  e.LastSeen,
		}
		if s := terminal.DefaultManager.GetSession(e.SessionID); s != nil {
			item["sessionName"] = s.Name
			item["projectId"] = s.ProjectID
		} else {
			item["sessionName"] = ""
			item["projectId"] = ""
		}
		out = append(out, item)
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}
