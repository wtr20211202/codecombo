package agentchain

// 操作手册分节（P-20261004-38 ⑤）：agent 侧可知链存在、上下文占位符约定，
// 以及经 CRUD API 自定义链（智能体操作面：REST CRUD + chain.triggered 事件
// 广播——agent 既能定义链也能感知触发，自动化闭环）。

import "codecombo/server/agentops"

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "agent-chain", Title: "会话接续链（完成后自动接棒）", Order: 71,
		Summary: "会话 A 完成后自动拉起会话 B 接续：链定义经 CRUD API 管理，触发时广播 chain.triggered——多 agent 串行自动化的地基件",
		Body: `- 会话接续链 = 「链源会话上报 task.progress 终态（done，onFailure=true 时含
  failed）→ 服务端自动拉起下一棒 agent 会话，prompt 模板注入上一棒上下文」。
  链定义是用户/agent 都可创建的持久配置（车道 1 kind agentchain）。
- POST /api/agent-chains   新建链
  body: {"sourceTerminalId":"<链源会话id，通常即你的 $CC_TERMINAL_ID>",
         "promptTemplate":"上一棒任务：{prevTask}（{prevStatus}），请继续：<你的指令>",
         "runtime":"<可选：auto|shell|claude|codex|dsh|自定义注册名，缺省 auto>",
         "dir":"<可选：下一棒工作目录，缺省用户主目录>",
         "onFailure":false}
  校验：sourceTerminalId 必填且创建时该会话须在册；promptTemplate 必填 ≤500
  字节；源会话关闭后链自动失效（列表 sourceAlive=false 置灰，可删除重建）。
- GET /api/agent-chains   链列表（含 sourceAlive / sourceName / 最近触发事实
  lastTriggeredAt / lastSessionId / lastStatus / triggerCount）
- DELETE /api/agent-chains/:id   删除链（已拉起的会话不受影响）
- prompt 模板占位符（触发时服务端替换为上一棒 task.progress 载荷三元组）：
  {prevTask}=任务简称 / {prevStatus}=done|failed / {prevStep}=最后一步摘要。
  未知占位符原样透传（占位符拼错会被下一棒 agent 读到原文，自纠即可）。
  展开结果超 500 字节时自动裁剪任务/步骤摘要，模板正文保真。
- 节制语义（不可配置，常量）：全局链深度上限 3——链拉起的第 2 棒完成后仍可
  接第 3 棒，第 3 棒完成后不再接续（防失控级联）；同链一次触发后 1 分钟冷却
  （防终态抖动重入）；拉起的会话是普通 agent 会话，AgentGuard/审批语义全量
  适用——下一棒遇到高危操作照常挂审批卡等人裁决。
- chain.triggered 事件（/ws/ops-channel 广播）：payload
  {"chainId","sourceTerminalId","status":"done|failed","sessionId"(下一棒id),"runtime"}。
  你若在链清单/自动化脚本里监听此事件，即可感知「自己被链拉起」或接力进度。
- 典型组合：A 跑测试 → 链拉起 B 修复失败项（promptTemplate 写明「若
  {prevStatus}=done 且有遗留问题请继续处理」）；生成→审查→修订三段流；
  长任务分段接力。`,
	})
}
