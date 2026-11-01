package terminal

import (
	"codecombo/server/api/opschannel"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 会话快照与变更广播（P-20261007-22 纯搬运自 terminal.go，零逻辑改动）：
// sessionSnapshot 是 ListTerminals 响应体与 terminals.changed 广播 payload
// 的共用构造，broadcastTerminalsChanged 是变更对账的唯一出口

// sessionSnapshot 全部会话的对外字段快照（ListTerminals 响应体与
// terminals.changed 广播 payload 共用，保证两处结构一致）。
// running 为服务端前台探测事实源（已知时携带；未知字段缺省，前端保持既有
// OSC 状态），前端刷新/重连时据此恢复"运行中/空闲"
func sessionSnapshot() []gin.H {
	sessions := terminal.DefaultManager.ListSessions()
	result := make([]gin.H, 0, len(sessions))
	for _, s := range sessions {
		item := gin.H{
			"id":        s.ID,
			"name":      s.Name,
			"projectId": s.ProjectID,
			"path":      s.Path,
			"createdAt": s.CreatedAt,
			"kind":      s.Kind,
			// 会话来源（P-20261005-189）：self/external——前端关闭分流（外部
			// 会话关闭=解除接管）与接管徽标的判据
			"origin": s.Origin,
		}
		if running, known := s.RunningState(); known {
			item["running"] = running
		}
		// 服务端活动时钟（P-20261003-192）：PTY 输入/输出双面刷新的最近活动
		// 时刻（ISO）。观测面字段——空闲分离判定的对账依据 + 列表侧可核「这
		// 会话多久没动了」；缺 key 视为未知（前端可选消费，零破坏）
		if last := s.LastActivity(); !last.IsZero() {
			item["lastActivity"] = last
		}
		// OSC 7 实时 cwd（P-20261004-59）：shell 提示符上报的当前工作目录（本机
		// 路径口径）。运行态观测字段——缺 key = 无帧（旧 shell/新会话无 prompt/
		// 重启恢复），消费方回落 path（创建 dir）；agent 经列表即可感知会话
		// 真实位置，无需开 WS 读输出流
		if dir, known := s.CurrentDir(); known {
			item["currentDir"] = dir
		}
		// 会话元数据快照（P-20261003-134 / P-20261003-238）：meta 反查，一次读
		// 同携两个字段——runtimeVersion（创建时预检顺取落库，刷新/重连后 tooltip
		// 仍可得）与 runtime（会话中心按 runtime 分组视图数据面：runtime 注册名
		// 只在创建响应内存态携带过，快照不落则刷新后前端运行时知识全失，分组
		// 视图退化单组）。旧会话/项目会话 meta 无记录 → 键不携带（前端空值归
		// shell 组）。每会话一次小 JSON 文件读：会话量级个位数~几十且快照只在
		// 列表拉取/增删改广播时构造，非热路径
		applySessionMetaSnapshot(item, s.ID)
		result = append(result, item)
	}
	return result
}

// applySessionMetaSnapshot 把会话元数据（meta 反查）投影进快照条目：runtime
// 与 runtimeVersion 一次 meta 读同携（两字段同文档，分开反查会双倍文件读）。
// 空值键不携带——快照对外契约「缺 key = 无记录」，前端空显/归组不虚构。
// initialPrompt（P-20261003-146）同契约：会话行「重新发起」预填的数据面，
// 无注入/旧会话不落键（前端预填退化为 dir/runtime，不虚构空指令）。同文档零额外读。
// 独立成函数供单测（sessionSnapshot 依赖真实 manager 会话，meta 投影面不必）
func applySessionMetaSnapshot(item gin.H, sessionID string) {
	if store.Get() == nil {
		return
	}
	m, err := store.Get().AgentSession.Get(sessionID)
	if err != nil || m == nil {
		return
	}
	if m.Runtime != "" {
		item["runtime"] = m.Runtime
	}
	if m.RuntimeVersion != "" {
		item["runtimeVersion"] = m.RuntimeVersion
	}
	if m.InitialPrompt != "" {
		item["initialPrompt"] = m.InitialPrompt
	}
	// 敏感标记（P-20261003-155）：仅置位时携带（缺 key = 未标记），前端角标
	// 与出域前置判断的数据面；未标记会话零键增量、旧客户端零影响
	if m.Sensitive {
		item["sensitive"] = true
	}
	// 编队批元数据（P-20261005-145）：仅编队成员携带（缺 key = 非编队会话），
	// 值班聚合卡按批分组与 ?fleet= 过滤的数据面；同文档零额外读
	if m.FleetBatch != nil {
		item["fleetBatch"] = gin.H{
			"batchId":    m.FleetBatch.BatchID,
			"launchedAt": m.FleetBatch.LaunchedAt,
			"members":    m.FleetBatch.Members,
		}
	}
	// 会话身份标记（P-20261023-3）：仅置位携键（缺 key = false）——名字系统
	// 派生（derived）与恢复旗标创建（resumed），侧栏「新/接续」徽标与命名
	// 来源呈现的数据面；旧会话缺字段反序列化 false 同形
	if m.Derived {
		item["derived"] = true
	}
	if m.Resumed {
		item["resumed"] = true
	}
}

// broadcastTerminalsChanged 会话列表变更后向所有前端广播快照：
// 终端会话管理页与底部终端 tab 据此实时对账（新建即现、关闭即清、改名即跟）。
// 覆盖 API 驱动的变更（创建/关闭/重命名——UI 侧全部变更都经这三条路）+ 经
// SetOnChange 注册的 native shell 自行退出（terminal manager 自移除时触发）
func broadcastTerminalsChanged() {
	opschannel.BroadcastEvent(opschannel.EventTerminalsChanged, gin.H{"sessions": sessionSnapshot()})
}

// BroadcastTerminalsChanged 会话列表变更广播的包外桥（P-20261004-108）：运行书
// 服务端执行（api/system）经 LaunchAgentSession 新建执行现场后调用，让新会话
// 即时进前端列表（会话管理页/底部终端 tab 对账）；P-20261008-6 起链拉起
// （agentchain trigger）同桥广播——下一棒会话是值班观察面（协作流卡接续行/
// 会话卡/通知直达）的在场前提，后台拉起无 HTTP 创建响应，唯有此桥能对账。
// agentcron 定时拉起仍不广播（存量行为，定时面由既有清单刷新对账）
func BroadcastTerminalsChanged() { broadcastTerminalsChanged() }
