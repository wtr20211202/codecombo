package middleware

import (
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// AuditAppend 审计写入中央收口（P-20261006-53）：gin handler 的审计事件一律
// 经此口入账——从 gin context 直读 RequestID 中间件注入的请求关联 ID
// （requestid.go 写 context，本包内零导入取同值），填入 AuditEvent.Rid 结构化
// 字段（与访问日志行尾 rid=<短码> 同值同源，app.go ginLogFormatter），再透传
// 底层 Append（尽力而为/脱敏/写失败计数语义全部原样保留，本函数零旁路）。
//
// 双口并存（与 store.AuditLogStore 文档对齐）：
//   - 有 *gin.Context 的调用点（handler 及其私有 auditXxx helper）→ 本口；
//     新增审计点不再裸 Append（P-20261006-45 起 agentguard 三出口同此口径）
//   - 无请求上下文的调用点（后台任务/巡检/SSH 回调等）→ 裸
//     store.Get().Audit.Append，Rid 留零值；强行为后台路径造 rid 没有意义，
//     两口各明适用面
//
// rid 缺席容忍：RequestID 中间件挂在路由引擎全局第一顺位，api 组正常请求必有
// id；中间件未挂载（裸测试 context）时 RequestIDFromGin 返回空串，Rid 零值
// 序列化即省略（omitempty）——存量消费者与测试断言零感知。
// 量级：一次 map 取值（Get），人操作级低频写路径，成本可忽略。
func AuditAppend(c *gin.Context, e store.AuditEvent) {
	e.Rid = RequestIDFromGin(c)
	store.Get().Audit.Append(e)
}
