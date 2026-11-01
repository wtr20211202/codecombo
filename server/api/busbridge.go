package api

import (
	"codecombo/server/kernel"
	"codecombo/server/model"
	"codecombo/server/terminal"
)

// WireBusBridge 把内核事件总线上既有前端消费的 topic 桥接到项目 WS 通道。
// 统一事件总线的兼容面：所有历史广播（watch 文件变更 / git 失败日志）继续以
// 原有的 WSMessage {Type, Data} 线上格式抵达前端，前端零改动；
// 新扩展面（订阅总线 topic）并行可用。Phase B 迁移 notify/opschannel 时
// 以同样方式逐个并入。
func WireBusBridge(k kernel.Kernel) {
	forward := func(env kernel.Envelope) {
		Broadcast(env.ProjectID, model.WSMessage{Type: env.Topic, Data: env.Payload})
	}
	k.Events().Subscribe("file.changed", forward)
	k.Events().Subscribe("git.command", forward)
	// TUI git 写活动定向广播（P-20261004-81）：terminal 嗅探命中经会话归属
	// 进总线，桥接到项目 WS——branch.changed 声明未发布的既有管道兑现，前端
	// useWebSocket 并轨 sc:git-panel-autorefresh 刷新链
	k.Events().Subscribe(terminal.TopicGitActivity, forward)
}

// GitBroadcastViaBus 返回把 git 失败日志发布到事件总线的广播函数。
// 替代历史上直接注入 api.Broadcast：git 包的出站事件先进总线
// （可被任何模块订阅），再经桥接落回 WS 通道
func GitBroadcastViaBus(k kernel.Kernel) func(projectID string, msg model.WSMessage) {
	return func(projectID string, msg model.WSMessage) {
		k.Events().Publish(kernel.Envelope{
			Topic:     msg.Type,
			ProjectID: projectID,
			Payload:   msg.Data,
		})
	}
}
