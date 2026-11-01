package terminal

// agent 长会话正常完成提醒（P-20261002-140）：进程退出钩子的补充通知路径。
//
// P-15 完成链（task.progress done/failed → 前端 OpsChannelBridge 入账 /
// agentcron 巡检入账）依赖智能体主动上报；未上报进度的长会话（运行时无
// SC skill、纯手工会话）正常退出时在此补一条「完成」知情——挂机等待场景
// 不用盯屏刷新。纯 shell 会话（一等 shell 选项 / 选型降级）不打扰；智能体
// 已上报过终态的会话沉默（P-15 链已通知，同一完成不双发）。
//
// 通知走 store.Add 既有出站口：WS 广播 + P-31 webhook 外发共用该单点，
// 本路径只 Add 一次，外发侧天然无第二重复面。

import (
	"fmt"
	"strings"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// 通知中心模板键（notify.longSession.*，前端按 titleKey/bodyKey 渲染；
// Title/Body 原文为无模板消费方——webhook 外发、API 直读——的回退）
const (
	longSessionTitleKey = "notify.longSession.done.title"
	longSessionBodyKey  = "notify.longSession.done.body"
)

// longSessionGate 退出提醒闸门（纯函数，表驱动单测）：
//   - 仅 agent 会话（KindAgent；项目终端维持既有「异常退出才提醒」语义）
//   - 真实注入了运行时命令：launched 且非一等 shell 运行时（prompt/启动命令
//     经 WriteInput 注入，StartHead 只是 git 基线不带该事实，故以创建时的
//     选型结果为准）；选型降级 launched=false = 纯 shell，不打扰
//   - 正常退出（exitCode == 0）且时长 ≥ 阈值（默认 5 分钟，通知设置可调；
//     阈值在退出时刻读偏好——会话存续期间调整即刻对本次退出生效）
func longSessionGate(kind, runtimeName string, launched bool, exitCode int, elapsed, threshold time.Duration) bool {
	if kind != terminal.KindAgent {
		return false
	}
	if !launched || runtimeName == agentRuntimeShell {
		return false
	}
	if exitCode != 0 {
		return false
	}
	return elapsed >= threshold
}

// hasAgentFinalProgress 会话自 since 起是否已有 task.progress 终态上报
// （P-15 完成链的数据面：ai 模块观察者落库，SessionID 形如 "terminalId" 或
// "terminalId claudeSessionId"，归属匹配与 agentcron.findFinalStatus 同一规则）。
// 命中 = 该会话的完成/失败已由 P-15 链通知，退出钩子沉默防双发
func hasAgentFinalProgress(sessionID string, since time.Time) bool {
	tasks, err := store.Get().AgentTask.List(200, "")
	if err != nil {
		return false // 查询失败不阻塞提醒主链（宁可极小概率双发不漏发）
	}
	for _, t := range tasks {
		if t.Type != opschannel.EventTaskProgress || t.At.Before(since) {
			continue
		}
		if t.SessionID != sessionID && !strings.HasPrefix(t.SessionID, sessionID+" ") {
			continue
		}
		// 终态字面量与 agentcron resultDone/resultFailed 同值（包未导出，跨包
		// 引用会引 import 环——api/terminal 已被 agentcron 反向依赖）
		if t.Status == "done" || t.Status == "failed" {
			return true
		}
	}
	return false
}

// notifyLongSessionDone 完成提醒入账通知中心（success / task 类，Action 省略：
// 通知到达时会话已退出，terminal:<id> 跳转无落点）。耗时按分钟取整——阈值本身
// 分钟级，秒精度对「挂机知情」无增量价值。Body 为语言中立明细（模板摘要行之后
// 渲染，webhook 外发原文可见），同日报 P-20261001-30 惯例
func notifyLongSessionDone(sessionID, name string, elapsed time.Duration) {
	minutes := int(elapsed.Minutes())
	if minutes < 1 {
		minutes = 1
	}
	store.Get().Notification.Add(notification.Notification{
		Type:     "success",
		Category: notification.CategoryTask,
		TitleKey: longSessionTitleKey,
		BodyKey:  longSessionBodyKey,
		Title:    "智能体会话已完成",
		Body:     fmt.Sprintf("%s (%d min)", name, minutes),
		MsgParams: map[string]any{
			"name":    name,
			"minutes": minutes,
		},
	})
}

// registerLongSessionExitHook 为真实拉起过运行时的 agent 会话注册退出钩子
// （LaunchAgentSession 创建链调用；注册即生效，会话关闭时随 handler map 回收）
func registerLongSessionExitHook(session *terminal.Session, runtimeName string, launched bool) {
	unregister := session.OnExit(func(exitCode int) {
		handleAgentSessionExit(session, runtimeName, launched, exitCode)
	})
	_ = unregister // 回调在 session 关闭时随 map 一起回收（同项目终端异常退出钩子）
}

// handleAgentSessionExit 退出钩子主体（独立成函数供单测以会话快照直接调用，
// 不经 waitLoop）：异常退出走验尸通知（P-20261004-60，含退出记录落 meta）；
// 正常退出经闸门 → P-15 去重 → 完成提醒入账，前两段不过即静默返回
func handleAgentSessionExit(session *terminal.Session, runtimeName string, launched bool, exitCode int) {
	if exitCode != 0 {
		// 异常退出（P-20261004-60 一键验尸）：此前 agent 会话退出止于沉默，
		// 第一追问「为什么挂」要手动翻已死会话现场——通知携验尸摘要 +
		// Action=postmortem 打开验尸弹层，与项目终端退出链共用 notifyAbnormalExit
		//（同步执行，代价与既有入账链同量级，见该函数注记）
		notifyAbnormalExit(session, exitCode)
		return
	}
	elapsed := time.Since(session.CreatedAt)
	threshold := store.Get().Notification.GetPrefs().LongSessionThreshold()
	if !longSessionGate(session.Kind, runtimeName, launched, exitCode, elapsed, threshold) {
		return
	}
	if hasAgentFinalProgress(session.ID, session.CreatedAt) {
		return
	}
	notifyLongSessionDone(session.ID, session.Name, elapsed)
}
