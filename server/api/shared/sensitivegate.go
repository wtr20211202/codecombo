package shared

import (
	"codecombo/server/store"
)

// 会话敏感标记出域闸门（P-20261003-155）：AgentSessionMeta.Sensitive 是人工
// 策展的安全标注（调试时贴过凭据/token 的会话），导出/分享等出域动作命中时
// 返回 warnings 拦下第一跳，前端弹「确认出域」后带 override 二次请求才放行
// ——与 P-26 分享敏感文件扫描的 warnings+override 同一交互契约。标记只管
// 出域不管可见性：本地检索（列表/输出检索/命令历史）零变化。
// token 与判定收口在本包：终端输出导出（api/terminal）与终端直播分享
//（api/share）两条出域链共用同一事实源，防契约漂移（ContentDisposition
// 净化 helper 同款「多出域端点共用收口」先例）。

// SensitiveSessionWarning 出域闸门的警示标记（warnings 数组元素原文）：消费方
// （前端警示框 / agent 程序化分支）按该稳定 token 识别「会话被标记敏感」，
// 不呈现会话原文
const SensitiveSessionWarning = "sensitive-session"

// SensitiveContentWarning 内容敏感扫描的警示标记（P-20261004-113）：导出内容
// 命中凭据形态/敏感文件名时，warnings 携该稳定 token，命中明细另置
// sensitiveHits（类型+计数，绝不含原文）。会话导出三面（md/jsonl/终端 txt）
// 同 token——agent 按 warnings 含该值即可编程感知「需 confirm=1 二段确认」
const SensitiveContentWarning = "sensitive-content"

// IsSessionSensitive 会话是否被人工标记敏感。meta 缺失/未标记一律 false——
// 默认无标 = 现状零变化，闸门只在用户显式标注后生效
func IsSessionSensitive(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	m, err := store.Get().AgentSession.Get(sessionID)
	if err != nil || m == nil {
		return false
	}
	return m.Sensitive
}
