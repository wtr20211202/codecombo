package compareexp

// 完成监听（P-20261003-46 ②）：复用 P-15 完成链——智能体经 ops-notify 上报
// task.progress done/failed 时，ai 模块观察者旁路落库（store.AgentTask），
// 本包观察者同流消费：按载荷 terminalId 找 running 实验的对应侧写入终结回执，
// 双侧齐备即翻 ready（迁移语义收敛在 store.ApplySideResult，单测钉死）。
//
// 与 agentcron 巡检式消费的分工：巡检有分钟级延迟，对比实验是用户挂机等待
// 的交互面，事件驱动即时翻转；代价是「重启窗口内到达的回执」错过观察者——
// 详情读路径不回补（回执事实已在 AgentTask 落库流里，对比视图按产出清单
// 实时计算，状态滞后只影响徽标不影响对比本身）。智能体未上报进度（纯
// shell 降级 / 未带 SC skill 的运行时）的实验停留 running，属预期降级语义
//（与 agentcron lastResult=launched 同口径）。

import (
	"encoding/json"
	"log/slog"
	"strings"

	"codecombo/server/api/opschannel"
	"codecombo/server/store"
)

// taskEventObserver 完成链观察者（模块 Init 注册）：只认 task.progress 的
// done/failed 终结态；载荷 terminalId 归属（与 ai 模块落库同一拼装事实源——
// 载荷里没有 terminalId 的上报无从归属，静默跳过）
func taskEventObserver(ev opschannel.Event) {
	if ev.Type != opschannel.EventTaskProgress {
		return
	}
	terminalID, status, agentSessionID := extractTaskProgress(ev.Payload)
	if terminalID == "" || (status != "done" && status != "failed") {
		return
	}
	applyTaskResult(terminalID, status, agentSessionID)
}

// extractTaskProgress 载荷提取（二次编解码而非 map 断言：广播载荷是
// map[string]interface{} 形态，直取断言脆弱；与 ai 模块 persistTaskEvent、
// opsentry decodePreviewPortPayload 同款二次编解码）
func extractTaskProgress(payload interface{}) (terminalID, status, agentSessionID string) {
	if payload == nil {
		return "", "", ""
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", "", ""
	}
	var p struct {
		TerminalID string `json:"terminalId"`
		Status     string `json:"status"`
		SessionID  string `json:"sessionId"`
	}
	if json.Unmarshal(b, &p) != nil {
		return "", "", ""
	}
	return strings.TrimSpace(p.TerminalID), strings.TrimSpace(p.Status), strings.TrimSpace(p.SessionID)
}

// applyTaskResult 回执落位：遍历 running 实验找双侧命中的会话。实验量有
// compareExpKeepMax 容量上限（50）兜底，running 实验是其中一小撮，线性扫
// 无性能面；store.SetSideResult 幂等（异侧/重复回执 no-op）。回执真实落位
// （任一侧 Result 变化）即广播 experiment.changed（P-20261004-33）：状态迁移
// 出服务进程，前端面板与 agent 脚本即时对账——重复回执/迟到 no-op 不广播防
// 事件噪声。广播在落库之后：收到事件的消费方拉详情必读到迁移后状态
func applyTaskResult(terminalID, status, agentSessionID string) {
	exps, err := store.Get().CompareExp.List()
	if err != nil {
		return // 查询失败不阻塞广播主链路（观察者语义：尽力而为）
	}
	for _, exp := range exps {
		if exp.Status != store.CompareExpRunning {
			continue
		}
		if exp.A.SessionID != terminalID && exp.B.SessionID != terminalID {
			continue
		}
		updated, err := store.Get().CompareExp.SetSideResult(exp.ID, terminalID, status, agentSessionID)
		if err != nil {
			slog.Warn("compare experiment side result failed", "exp", exp.ID, "err", err)
			continue
		}
		if updated.A.Result != exp.A.Result || updated.B.Result != exp.B.Result {
			opschannel.BroadcastEvent(opschannel.EventExperimentChanged, map[string]any{
				"id":      updated.ID,
				"status":  updated.Status,
				"resultA": updated.A.Result,
				"resultB": updated.B.Result,
			})
		}
	}
}
