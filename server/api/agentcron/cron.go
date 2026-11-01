// Package agentcron 定时智能体任务（P-20261002-43）：到点经既有 agent 终端
// 创建通道自动发起 agent 会话（prompt 经 launchArgs 通道注入），补齐周期性
// agent 任务「到点自动发起」一环。
//
// 拓扑：调度器在本包（内核模块，分钟级巡检）；存储在 server/store（AgentCron
// 仓储）；会话创建复用 server/api/terminal 的 LaunchAgentSession 核心（同层
// api 包互引，与 api/terminal 引 api/opschannel 同惯例）。任务产生的高危操作
// 照常走审批挂起——无人值守不等于免裁；done/failed 经 AgentTask 落库流（ai 模块
// 观察者旁路持久化的只读复用）回填通知中心，不抢占 opschannel 单观察者槽位。
package agentcron

import (
	"fmt"
	"strings"
	"time"

	"codecombo/server/store"
)

// dueWindow 到期窗口：槽点后该时长内的巡检命中视为「到点」。取 2 分钟吸收
// ticker 漂移/调度延迟（内核调度器为间隔制，单次巡检间隔约 1 分钟，窗口须
// 严格大于一个巡检周期，否则槽点可能落在两次巡检之间被漏判）；窗口内的重复
// 判定由 lastRunAt（跨重启）与内存 checked 标记（进程内）双保险去重
const dueWindow = 2 * time.Minute

// watchTimeout 完成回执的等待上限：任务触发后在该窗口内监听 AgentTask 落库流
// 中本会话的 task.progress done/failed 回执；超时放弃（运行结果停留在 launched，
// 会话产出仍可在终端/产出视图回看）
const watchTimeout = 24 * time.Hour

// slotKey 槽点标识（进程内去重键）：YYYY-MM-DDTHH:MM
func slotKey(t time.Time) string {
	return t.Format("2006-01-02T15:04")
}

// WeekdayMatch 周几集合命中：空集合 = 每天生效
func WeekdayMatch(weekdays []int, w time.Weekday) bool {
	if len(weekdays) == 0 {
		return true
	}
	for _, d := range weekdays {
		if int(w) == d {
			return true
		}
	}
	return false
}

// TaskLocation 任务评估时区解析（P-20261005-217）：空 = 服务器本地时区（既有
// 语义，存量任务行为完全不变）；非空经 LoadLocation，失败回落本地——保存口已
// 前置校验 IANA 名（api 层 validateCronPayload），运行期失败属平台 tz 数据缺失
// 的降级：宁可退回旧语义，不可让调度崩摆。LoadLocation 自带缓存，分钟巡检
// 级别的重复解析无 IO 热路径顾虑
func TaskLocation(tz string) *time.Location {
	if tz == "" {
		return time.Local
	}
	if loc, err := time.LoadLocation(tz); err == nil {
		return loc
	}
	return time.Local
}

// SlotTime now 所在自然日的触发时刻（按 now 自带时区的日历取值——评估任务
// 时传入 now.In(任务时区) 即得任务时区槽点）。DST 交割日不存在/歧义的时刻
// 由 time.Date 库语义归一（Go 文档：交割两侧取哪侧不保证，但保证落在其中
// 之一）——调度侧只依赖「同参数解析结果确定且唯一」，去重以绝对时刻为锚，
// 两不变量与归一侧别无关（cron_timezone_test.go 锚定）
func SlotTime(now time.Time, hour, minute int) time.Time {
	return time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, now.Location())
}

// Evaluation 单次巡检对单个任务的到期判定结论
type Evaluation struct {
	Slot time.Time // 今日槽点
	// Due 到点：now 落在 [槽点, 槽点+dueWindow) 且今日该槽未跑
	Due bool
	// Missed 错过：now 已越过到期窗口且今日该槽未跑（是否补跑由任务
	// MissCatchUp 开关决定）
	Missed bool
}

// Evaluate 到期/错过判定（纯函数，单测锚点）。时刻/周几均按任务评估时区
// （t.Timezone，空 = 服务器本地）的日历解读——服务器与用户异时区部署时
// 「每天 9 点」按任务声明的时区到点，不再错点：
//   - 评估日非生效周几 → 双 false（周几门控同样约束错过补跑：补的是「当日槽」，
//     非生效日无槽可言）
//   - 已跑（LastRunAt >= 今日槽点）→ 双 false（当日去重，跨重启语义由
//     LastRunAt 持久化承载；LastRunAt 是绝对时刻，与时区换算天然正交）
//   - 停用任务调用方先过滤，本函数不重复判定
func Evaluate(t store.AgentCron, now time.Time) Evaluation {
	local := now.In(TaskLocation(t.Timezone))
	slot := SlotTime(local, t.Hour, t.Minute)
	if !WeekdayMatch(t.Weekdays, local.Weekday()) {
		return Evaluation{Slot: slot}
	}
	ranToday := !t.LastRunAt.Before(slot)
	if ranToday {
		return Evaluation{Slot: slot}
	}
	if now.Before(slot) {
		return Evaluation{Slot: slot} // 未到点
	}
	if now.Before(slot.Add(dueWindow)) {
		return Evaluation{Slot: slot, Due: true}
	}
	return Evaluation{Slot: slot, Missed: true}
}

// NextRunAt after 之后的下一次计划触发时刻（按 after 自带时区的日历逐日探测
// ——评估任务时传入 now.In(任务时区)；每日 HH:MM 模型必有解，8 天窗口覆盖
// 任意周几集合）；预览用纯函数，与调度判定共用 WeekdayMatch
func NextRunAt(hour, minute int, weekdays []int, after time.Time) time.Time {
	base := after.Truncate(time.Minute)
	for d := 0; d < 8; d++ {
		day := base.AddDate(0, 0, d)
		cand := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, after.Location())
		if cand.After(base) && WeekdayMatch(weekdays, cand.Weekday()) {
			return cand
		}
	}
	return time.Time{}
}

// promptVar 运行时变量展开值（P-20261003-167，三枚从紧集合——不开放通用
// 模板引擎，新变量须过此处白名单）。值取槽点（计划触发时刻；试跑为当下）
// 所在时区格式化——槽点按任务评估时区构造（P-20261005-217），「当日 9 点的
// 报告」里 {date}/{time} 即业务时区的日期与时刻；星期取 Go time.Weekday
// 英文全名：服务端无 UI 语言上下文，英文星期对所有 agent 消费方通用
// （中英文指令均可理解），不引语言参数面
func promptVar(token string, slot time.Time) (string, bool) {
	switch token {
	case "date":
		return slot.Format("2006-01-02"), true
	case "time":
		return slot.Format("15:04"), true
	case "weekday":
		return slot.Weekday().String(), true
	}
	return "", false
}

// expandPromptVars prompt 模板变量替换：扫 {token} 片段整枚精确命中才替换
// （非前缀替换——{dated} 不会被 {date} 规则咬掉），未知 token 原样透传：
// agent 在注入指令里读到未识别占位符即知模板笔误，好过静默吞成空串
func expandPromptVars(prompt string, slot time.Time) string {
	if !strings.Contains(prompt, "{") {
		return prompt
	}
	var b strings.Builder
	b.Grow(len(prompt))
	for {
		start := strings.IndexByte(prompt, '{')
		if start < 0 {
			b.WriteString(prompt)
			return b.String()
		}
		end := strings.IndexByte(prompt[start:], '}')
		if end < 0 {
			b.WriteString(prompt) // 孤立 { 无闭合：余量原样透传
			return b.String()
		}
		b.WriteString(prompt[:start])
		if v, ok := promptVar(prompt[start+1:start+end], slot); ok {
			b.WriteString(v)
		} else {
			b.WriteString(prompt[start : start+end+1])
		}
		prompt = prompt[start+end+1:]
	}
}

// ComposeLaunchArgs 触发时的 launchArgs 组装（服务端常量模板 + 任务配置拼接，
// 守 argv 红线：除任务自身的 prompt 与服务端格式化的时间戳外无任何外部拼接面）：
//   - prompt 归一为单行（launchArgs 经 PTY 注入 shell 执行，换行会被解释成
//     回车提交，多行指令在 TUI 内必然断行错意）
//   - prompt 中的运行时变量替换（P-20261003-167）：{date}=当日 YYYY-MM-DD、
//     {time}=HH:mm（槽点本地时区）、{weekday}=星期——见 expandPromptVars
//   - 尾部追加服务端格式化的计划槽点时间戳，智能体据此解释 prompt 中的
//     「当日/本周」等相对时间
//
// 配额口径注记（P-20261003-167）：500 字节配额按存储态模板计（保存口
// cronPromptMax 与 launchArgs 上限同口径）；变量展开发生在触发时、单枚增量
// 有界（至多 +4 字节/枚，{date} 6B→10B；{time} 收缩、{weekday} 最宽持平
// 9B），与既有 [scheduled] 后缀同为「存储配额外的注入面增量」——内部调用方
// 自证长度合规（terminal.LaunchAgentSession 契约），上限锚定见
// TestComposeLaunchArgs_VarExpansionQuota
func ComposeLaunchArgs(prompt string, slot time.Time) string {
	single := strings.Join(strings.Fields(prompt), " ")
	return fmt.Sprintf("%s [scheduled %s]", expandPromptVars(single, slot), slot.Format("2006-01-02 15:04 -0700"))
}

// AfterModeAccepts 前序完成触发的档位判定（纯函数，单测锚点；P-20261003-124）：
//   - 父状态非终态（done/failed）→ 恒 false（error: 启动失败 = 父任务从未执行，
//     两档都不触发子任务——「完成即触发」的前提是前序确曾执行）
//   - success（默认，空值同）：仅父 done 触发——每日构建→测试→报告的默认档，
//     前序失败时后续任务不应在错误状态上执行（提案动机本义）
//   - always 完成即触发：done/failed 都触发——不论前序成果质量、流程必须继续
//     （如「无论构建成败都要发报告」）
func AfterModeAccepts(mode, parentStatus string) bool {
	if parentStatus != resultDone && parentStatus != resultFailed {
		return false
	}
	if mode == store.CronAfterAlways {
		return true
	}
	return parentStatus == resultDone
}

// ChainHasCycle 依赖环检测（纯函数，保存口校验锚点；P-20261003-124）：
// 从 parentID 沿 AfterCronID 链上溯，命中 selfID 即成环。每任务至多一个父
// （单链模型），visited 集合兜住脏数据里已存在的环（不依赖 selfID 也能终止）；
// selfID 传空串 = 新建任务（新 ID 不可能被既有链引用，理论上恒 false，仍走
// 同一上溯以校验父链自身健康）。parentID 不在 crons 里返回 false——父不存在
// 是另一个校验（parentMissing），不在这里混判
func ChainHasCycle(crons []store.AgentCron, selfID, parentID string) bool {
	if parentID == "" {
		return false
	}
	if parentID == selfID {
		return true
	}
	byID := make(map[string]store.AgentCron, len(crons))
	for _, c := range crons {
		byID[c.ID] = c
	}
	visited := map[string]bool{}
	cur := parentID
	for {
		if cur == selfID || visited[cur] {
			return true
		}
		visited[cur] = true
		p, ok := byID[cur]
		if !ok || !p.IsAfterTrigger() {
			return false // 链顶：父不存在或父是定时任务，链合法终止
		}
		cur = p.AfterCronID
		if cur == "" {
			return false // 脏数据：after 任务缺父指向，按链终止处理（存在性另有校验面）
		}
	}
}
