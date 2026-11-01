package system

// 操作手册分节（P-20261004-52）：agent 侧可知「用户现场」能力存在、读取语义
// 与隐私边界——从「盲问」变「看着问」的地基件（ask 提问与汇报引用现场提升
// 精准度；上下文相关问询的第一原语）。

import "codecombo/server/agentops"

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "ui-snapshot", Title: "用户现场（用户此刻在看什么）", Order: 73,
		Summary: "GET /api/ui/snapshot 读用户正在看的文件/行号/面板/终端会话——提问与汇报引用现场提升精准度；仅位置不内容，不得据此推断用户行为",
		Body: `- 用户与 agent 共处同一工作台：前端把「用户此刻在看什么」低频聚合上报
  （显著变化去抖 2s + 60s 心跳），你随时可读——「帮我看看这个」类问询先读现场，
  不要让用户自述「哪个文件哪里」。
- GET /api/ui/snapshot   读取现场（你的 sca_ 令牌直达）
  返回 {"data":{"activeProjectId","activeFile":{"path","line","column"},
  "visiblePanels":{"side","sideOpen","bottom","bottomOpen"},
  "activeTerminalSessionId","updatedAt","ageSeconds"}}，字段均可为空
  （activeFile 缺 = 用户在首页/欢迎页；activeTerminalSessionId 缺 = 未看终端）。
- 404（code=ui.snapshot_unavailable）= 无在报现场：用户设置关闭 / 10 分钟无
  心跳过期（浏览器关闭/休眠/停在首页）/ 从未上报。三类同语义，直接走无现场
  降级路径提问，不要重试等待。
- ageSeconds 现场年龄（0~600）：措辞按陈旧度分档（刚在看 / 几分钟前在看）。
- 使用约定（隐私边界，强约束）：
  1) 仅位置不内容——快照只含「哪个项目/哪个文件第几行/哪些面板开着/哪个终端
     会话在前」，绝不含文件内容、终端输出、剪贴板；你读到的也只有位置。
  2) 不得据此推断用户行为——位置 ≠ 意图（用户停在报错行可能只是在浏览）。
     现场只用于：定位上下文（open-file-at 汇报对齐用户视线）、ask 提问附默认
     选项、汇报引用「你正打开的 <path>:<line>」。不要写「你在改 X」类行为断言。
  3) 多标签页最后写入优先：用户多开标签页时现场是最后活跃标签页的投影，
     引用前留意 activeProjectId 与你手头任务的项目是否一致。
- 典型用法：用户发来「帮我看看这个」却没说位置 → 先 GET 现场拿到
  activeFile.path/line → 直接读该文件该行附近上下文开始分析；结论汇报用
  open-file-at 把用户带回相关位置。`,
	})
}
