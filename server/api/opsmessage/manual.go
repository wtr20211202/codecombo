package opsmessage

// 操作手册分节（P-20261004-68）：agent 侧可知会话间定向消息存在、投递/拉取
// 语义与协作约定——多 agent 并行协作的通信地基（接续链是「接力」，消息是
// 「并行协作」）。

import "codecombo/server/agentops"

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "agent-message", Title: "会话间定向消息（收件箱）", Order: 73,
		Summary: "向另一个 agent 会话定点留言（配置在哪/哪个套件在抖/我改了 Z 你别动）：有地址、拉取即读、24h 过期——协作矩阵 agent↔agent 腿",
		Body: `发现别的会话需要的信息时不要写笔记碰运气（笔记库所有人可见、无已读
语义）——用定向消息直达目标会话的收件箱。与笔记分工一句话：**定向瞬态用消息、
共享持久用笔记**。

- POST /api/ops-message    投递 {"to":"<目标会话id>","body":"<正文 ≤2KB>"}
  发送方 = 你的 $CC_TERMINAL_ID（X-Session-ID 头，必携）；目标会话不存在 404
  （ops.message_target_not_found）——先 GET /api/terminals 核对 id。
- GET  /api/ops-message    本会话收件箱（X-Session-ID 头定位），**拉取即读**：
  每次返回自上次拉取以来的全部新留言（投递序）并标记已读，再次拉取返回空——
  在任务关键节点（启动时/每完成一步/收尾前）拉取即可，无需自记游标。
- 保留策略（不可配置）：单会话环形 20 条 + 24h 过期即焚；建议收尾前清读
  收件箱，不留悬空留言。
- 事件（/ws/ops-channel）：terminal.message 广播新留言到达
  {"from","to","summary"(首行 ≤80 字),"at"}——监听它可免轮询感知；
  terminal.message.read 广播收件箱被拉取 {"sessionId","count"}。

## 协作约定

- 留言写对方能直接用的信息：路径/命令/结论/「别动 X」，一两句说完；长上下文
  写进笔记库「[项目名] 交接」篇后留言指路（「详见笔记 <日期> 节」）。
- 收到留言请尽快拉取消化：投递成功不代表对方会再提醒（一次性瞬态层）。
- 消息可能经过人的通知中心（「A → B 留言」弱条目）——内容当作半公开写，
  密钥等敏感值不要进消息正文（与 ops-notify 同级敏感面）。

## 示例

` + "```bash" + `
# 发送（A 会话内）：告诉 B 配置位置
curl -X POST {{BASE}}/api/ops-message -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -H "X-Session-ID: $CC_TERMINAL_ID" \
  -d '{"to":"agent-1728000000000000000","body":"集成测试配置在 scripts/test.env，跑前先 source"}'
# {"message":"message delivered","data":{"to":"agent-...","pending":1}}

# 接收（B 会话内）：拉取即读
curl {{BASE}}/api/ops-message -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -H "X-Session-ID: $CC_TERMINAL_ID"
# {"data":[{"id":"msg-...","from":"agent-...","body":"集成测试配置在...","at":"...","read":true}]}
` + "```" + ``,
	})
}
