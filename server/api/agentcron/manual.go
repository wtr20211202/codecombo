package agentcron

// 操作手册分节（P-20261005-207 接力 / P-20261005-237 指标抽取 / P-20261006-22
// 错过槽可见性 / P-20261005-217 评估时区 / P-20261007-13 运行书协同——例程
// prompt 引用运行书，改书即改例程）：agent 侧可知定时任务可编程「自动
// 续命」「输出数值序列化」「错过槽运维答案」与「按业务地时区到点」——cron
// 创建 API 的 relayFrom 参数与接力降级事件、extract 探测规则与指标时序读面、
// missedHistory 错过槽三态账、timezone 评估时区（智能体操作面：REST CRUD
// 即配置面，列表载荷即趋势/错过/时区读面，agent 巡检可编程做回归告警与值守
// 简报）。

import "codecombo/server/agentops"

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "agent-cron", Title: "定时任务（cron 到期自动接力）", Order: 74,
		Summary: "每日 HH:MM 定时拉起 agent 会话（timezone 可按业务地时区评估避免错点）；relayFrom 可注入上次会话结论自动续命，降级广播 task.relaySkipped；extract 规则把输出数值入时序趋势",
		Body: `- 定时任务 = 服务端分钟级巡检的持久配置（车道 1 kind agentcron）：到点经
  LaunchAgentSession 自动发起 agent 会话，prompt 经 launchArgs 通道注入。
- POST /api/agent-crons   新建任务
  body: {"name":"<任务名>","hour":2,"minute":0,"weekdays":[],"timezone":"<可选
  IANA 时区名，见下>","runtime":"<可选 auto|shell|claude|codex|dsh|自定义注册名>",
  "prompt":"<指令 ≤500 字节，支持 {date}/{time}/{weekday} 触发时展开>",
  "dir":"<可选：会话工作目录>","enabled":true,
  "missCatchUp":<可选：停机错过槽点后启动补跑>,
  "relayFrom":"<可选：接力源，见下>","extract":"<可选：指标抽取规则，见下>"}
- timezone 评估时区（P-20261005-217）：任务的时刻与周几按声明时区的日历评估
  （Evaluate/补跑判定/nextRunAt 预览同源），agent 建任务时可显式指定时区避免
  错点——服务器与业务地异时区部署（容器默认 UTC、用户东八区）时「每天 9 点」
  不再错 8 小时。空 = 按服务器本地时区（既有语义，存量任务零迁移）；非空须为
  IANA 名（如 "Asia/Shanghai"/"UTC"/"America/New_York"），保存口 LoadLocation
  校验、非法名 400。DST 交割由库处理；{date}/{time}/{weekday} 变量与
  [scheduled] 时间戳按任务时区取值——跨时区指令里的「当日」语义与业务地对齐。
  列表响应 server 段 {"name","now","utcOffset"} 为服务器时区快照（对表用）。
- relayFrom 自动续命（定时接力）：非空时触发先取接力源会话尾部最后一条
  assistant 结论（遮蔽后装箱进 launchArgs 前言「Conclusions from the previous
  session: … Please continue.」），长周期任务跨会话延续上下文。两形态：
  "latest" = 动态解析 dir 项目最近已结束的 claude 会话（推荐——每天自动接最新
  一棒；dir 为空则降级）；其余非空值 = 显式 claude 会话 id。
  降级语义：源无结论/会话不存在/配额不够 → 任务如实无前言照常启动（定时任务
  不因接力失败停摆），同时广播 task.relaySkipped 事件、任务 lastRelayNote 记
  "skipped: <原因>"；成功记 "relayed"。
- extract 指标抽取（P-20261005-237 探测配置）：任务完成回执落定时从会话输出
  尾窗按规则抽取一个数值，入 per-任务时序（环形 30 点）。两形态（保存口压实，
  运行期只可能「无数据」不可能「坏规则」）：
    正则      Go RE2，首个命名捕获组承载数值、组名即指标名，如
              "(?:build in) (?P<sec>[0-9.]+)s"
    JSON 路径 "json:" 前缀 + 点分路径，如 "json:duration.seconds"（整窗优先、
              末行 JSON 摘要兜底）
  无命中/会话已销毁/值不可解析一律不落点（「无数据」如实，绝不硬凑 0）。
  extract 规则即 agent 可编程配置的探测面：把「跑构建/探测命令」的定时任务
  配上规则，性能回归（耗时/内存/计数）从人盯输出变自动曲线。
- GET /api/agent-crons   任务列表（含 nextRunAt 预览 / lastRunAt / lastResult /
  lastRelayAt / lastRelayNote / history 最近 20 条运行历史 / missedHistory 最近
  20 条错过槽历史——agent 巡检可编程查「昨晚哪些任务错过」（值守简报数据源），
  条目 {"slot":<计划槽点>,"action":"skipped|caught-up|failed","errSummary":<补跑
  失败摘要>}：skipped = 未开补偿只标记、caught-up = 补跑发起成功（运行终态在
  history）、failed = 补跑发起失败；无错过 = 键缺席。配置 extract 且已有
  抽取点的任务带 metric 段 {"name":<指标名>,"points":[{"at","value"},…]}
  ——points 时间升序（旧→新），无数据 = metric 键缺席。agent 巡检可编程读
  「构建时长趋势」做回归告警，无需新端点）
- PUT /api/agent-crons/:id   全量替换可编辑字段（运行期事实不可写）
- DELETE /api/agent-crons/:id   删除（有依赖链子任务时 409 先解除；指标时序级联清理）
- POST /api/agent-crons/:id/run   立即试跑（与到期触发同一执行链，不做当日去重）
- task.relaySkipped 事件（/ws/ops-channel 广播，直通分发）：payload
  {"cronId","name","reason"}。自动化脚本可监听此事件监控续命断链
  （如源会话被清理后改用 "latest" 形态自愈）。
- 协同运行书（P-20261007-13，单一事实源）：例程 prompt 引用运行书而非手抄
  命令——「GET /api/runbooks 按『<场景关键词>』检索目标书 → POST
  /api/runbooks/:id/run 执行」。流程步骤日后演进改书即生效（改书即改例程），
  手抄进 prompt 的命令则与书脱节；无人值守场景优先选无 {参数} 占位符的书，
  确需参数的在 prompt 里写明取值（缺参 400 runbook.params_missing 即空跑）。
- 拉起的会话是普通 agent 会话：AgentGuard/审批语义全量适用——无人值守不等于免裁。`,
	})
}
