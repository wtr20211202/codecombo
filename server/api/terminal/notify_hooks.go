package terminal

import (
	"fmt"

	"codecombo/server/api/opschannel"

	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"
	"github.com/gin-gonic/gin"
)

// 管理器回调装配与通知入账（P-20261007-22 纯搬运自 terminal.go，零逻辑改动）：
// init() 把终端管理器的集合变更/端口探测/哨兵命中/空闲分离四类回调接到
// 广播与通知中心，sentinelNotifyType/portConflictNotifier 是其文案映射助手

// 会话集合变更 → 全端广播：native shell 自行退出不经 API（terminal manager
// 自移除路径），未持有其 WS 的端无法靠自身感知，统一经此回调实时对账。
// dev 端口被动探测命中 → preview.port 广播（P-20261002-83）：复用 P-70 已合入
// 的事件链（前端通知中心 + 悬浮球直达预览面板零改动），payload 追加
// source:"detected" 供前端弱化展示并区分 agent 主动上报——探测身份由服务端
// 就地标注（ops-notify 发布口对 preview.port 载荷强类型规整，外部 agent 无法
// 伪造该字段）。init 装配（先于任何会话创建），与上方广播回调同款注入手法。
// P-20261003-293：命中同时落端口注册表（探测/上报统一登记口），冲突经
// OnPortConflict 发通知——通知装配见 portConflictNotifier
func init() {
	terminal.SetOnChange(broadcastTerminalsChanged)
	terminal.OnDevPortDetected = func(sessionID string, port int, label string) {
		// 登记先行、广播无条件：登记面（会话存活校验）与广播面（P-83 既有契约）
		// 解耦，注册表缺席不回退探测广播行为
		terminal.DefaultManager.RegisterDevPort(sessionID, port, label, terminal.PortSourceDetected)
		opschannel.BroadcastEvent(opschannel.EventPreviewPort, gin.H{
			"port":   port,
			"label":  label,
			"source": "detected",
		})
	}
	terminal.OnPortConflict = portConflictNotifier
	// 输出哨兵命中（P-20261004-8）→ 通知中心入账，Action 直达触发会话
	//（P-31 action 机制 terminal:<sessionId>；ProjectID 在位时前端先切项目再跳）。
	// 第二动作（P-20261005-150）：agent-fix 一键交给智能体修复——值班响应
	// 「跳会话→看输出→复制错误→开会话贴任务」四步收为两步；payload 带
	// 「sentinel:」前缀供前端 agent-fix 分发面分流（部署链 payload 是任务 id，
	// sc_dt_ 前缀不相交），哨兵名/命中行/会话名经 MsgParams 落档供前端组装
	// 修复上下文。主动作契约不回退，第二入口走 SecondAction 槽位。
	// 会话名/项目 ID 经 manager 反查——与 sessionSnapshot 同款直读惯例
	terminal.OnSentinelHit = func(sessionID string, hit terminal.SentinelHit) {
		st := store.Get()
		if st == nil {
			return
		}
		sessionName, projectID := "", ""
		if s := terminal.DefaultManager.GetSession(sessionID); s != nil {
			sessionName, projectID = s.Name, s.ProjectID
		}
		st.Notification.Add(notification.Notification{
			Type:                sentinelNotifyType(hit.Level),
			Category:            notification.CategorySystem,
			TitleKey:            "sentinel.notify.hit.title",
			BodyKey:             "sentinel.notify.hit.body",
			Title:               "哨兵命中：" + hit.Name,
			Body:                sessionName + ": " + hit.Matched,
			MsgParams:           map[string]any{"name": hit.Name, "session": sessionName, "matched": hit.Matched},
			ProjectID:           projectID,
			Action:              "terminal",
			ActionPayload:       sessionID,
			SecondAction:        "agent-fix",
			SecondActionPayload: "sentinel:" + sessionID,
		})
	}
	// 空闲超时自动分离（P-20261003-192）→ 通知中心入账：一分离一通知。tmux
	// 档带 terminal Action 直达重连（点击跳会话，EnsureAttached 自动 Reattach）；
	// native 档会话已终结无处可跳，不带 Action（诚实面：通知只告知不误导）。
	// 文案不携带时长/阈值数字——分钟粒度阈值（e2e 档 1 分钟）与小时级生产
	// 档位共用模板，避免服务端做 locale 敏感的时长格式化
	terminal.OnIdleDetach = func(entries []terminal.IdleDetachEntry) {
		st := store.Get()
		if st == nil {
			return
		}
		for _, e := range entries {
			n := notification.Notification{
				Type:      "warning",
				Category:  notification.CategorySystem,
				TitleKey:  "terminal.idleDetach.notify.title",
				Title:     "终端空闲超时：" + e.Name,
				ProjectID: e.ProjectID,
			}
			if e.Persistent {
				n.BodyKey = "terminal.idleDetach.notify.bodyPersistent"
				n.Body = "会话已自动分离，底层会话保留，打开即可重连"
				n.Action = "terminal"
				n.ActionPayload = e.SessionID
			} else {
				n.BodyKey = "terminal.idleDetach.notify.bodyEphemeral"
				n.Body = "会话空闲超时已自动关闭并释放资源（当前后端无持久化层）"
			}
			n.MsgParams = map[string]any{"name": e.Name}
			st.Notification.Add(n)
		}
	}
}

// sentinelNotifyType 哨兵级别 → 通知条目样式（level 写入口已归一化为三值，
// 此处只做映射；未知值兜底 warning）
func sentinelNotifyType(level string) string {
	switch level {
	case "info":
		return "info"
	case "error":
		return "error"
	}
	return "warning"
}

// portConflictNotifier 端口冲突 → 通知中心入账（P-20261003-293）：第二个 dev
// server 通常起不来，通知即归因——「已知占用」措辞（登记面=探测/上报面，
// 未探测到的监听不在列，避免误导）+ Action 直达先占方终端（P-31 terminal
// action 机制；ProjectID 在位时前端先切项目再跳）。会话名经 manager 反查
// （条目不落名，改名即时生效；回调时点会话可能刚关闭，回退会话 id）。
// TitleKey/BodyKey 模板文案见前端 locales terminal.portConflict.notify
func portConflictNotifier(holder, newcomer terminal.PortEntry) {
	st := store.Get()
	if st == nil {
		return
	}
	holderName, projectID := holder.SessionID, ""
	if s := terminal.DefaultManager.GetSession(holder.SessionID); s != nil {
		holderName, projectID = s.Name, s.ProjectID
	}
	newcomerName := newcomer.SessionID
	if s := terminal.DefaultManager.GetSession(newcomer.SessionID); s != nil {
		newcomerName = s.Name
	}
	st.Notification.Add(notification.Notification{
		Type:          "warning",
		Category:      notification.CategorySystem,
		TitleKey:      "terminal.portConflict.notify.title",
		BodyKey:       "terminal.portConflict.notify.body",
		Title:         fmt.Sprintf("端口冲突预警 :%d", holder.Port),
		Body:          fmt.Sprintf(":%d %s → %s", holder.Port, holderName, newcomerName),
		MsgParams:     map[string]any{"port": holder.Port, "holder": holderName, "newcomer": newcomerName},
		ProjectID:     projectID,
		Action:        "terminal",
		ActionPayload: holder.SessionID,
	})
}
