// 会话回放只读分享（P-20261003-77）：分享一条 Claude 会话的完整过程
// （user/assistant/thinking/tool/result）——「你看 agent 刚才怎么干活的」的
// 现场展示件。与 cast 回放（P-20261004-103，终端输出录制）是并列的两个
// 回放域：cast 看终端字节流，session 看对话/思考/工具动作的结构化时间线。
//
// 数据面：创建时刻把 claudesessions 解析出的条目序列序列化为 JSON 写进
// SnapshotsRoot 隔离区（单文件快照，同 terminal-frozen/cast 同一清账通道）——
// 会话继续写不影响访客所见，会话被删除后链接仍按独立 TTL 存活。快照写盘前
// 按 P-108 模式集对标题/正文/工具输入做敏感值兜底遮蔽（mask.MaskText，与
// 会话回放展示面/终端录制同源模式集）：快照即净本，访客面零二次处理，也
// 不存在「访客点开显示原文」的放行开关——匿名访客没有这个授权语境。
//
// 本文件只做快照形态与净化（零 IO），落盘原语在 snapshot.go，访客页在
// sessionpage.go。
package share

import (
	"encoding/json"

	"codecombo/server/claudesessions"
	"codecombo/server/mask"
)

// SessionSnapshot 会话回放快照的落盘/取数形态（访客页 /session 端点原样
// 输出）。Entries 复用 claudesessions.TimelineEntry 的 JSON 契约（kind/at/
// text/tool/input/status），含 Kind=thinking 条目（回放时间线跳过、分享按
// 提案保留）与 tool 的输入摘要、result 的结果摘要
type SessionSnapshot struct {
	Title     string                         `json:"title"`
	Truncated bool                           `json:"truncated,omitempty"`
	Entries   []claudesessions.TimelineEntry `json:"entries"`
}

// BuildSessionSnapshot 把解析结果装箱为分享快照并完成 P-108 敏感值遮蔽。
// 遮蔽面 = 标题 + 每条正文/工具输入（tool 名/时刻/状态非敏感原样透传）；
// 与回放展示面 maskSensitive/MaskText 同一模式集（sc 令牌 / password 赋值 /
// 云密钥 + 自定义敏感模式），命中值落 ***。导出明文不套用该口径（导出是
// 显式带走），分享是发给匿名访客的展示面，必须默认遮蔽
func BuildSessionSnapshot(res claudesessions.ShareSnapshotResult) SessionSnapshot {
	out := SessionSnapshot{
		Title:     mask.MaskText(res.Title),
		Truncated: res.Truncated,
		Entries:   make([]claudesessions.TimelineEntry, 0, len(res.Entries)),
	}
	for _, e := range res.Entries {
		if e.Text != "" {
			e.Text = mask.MaskText(e.Text)
		}
		if e.Input != "" {
			e.Input = mask.MaskText(e.Input)
		}
		out.Entries = append(out.Entries, e)
	}
	return out
}

// MarshalSessionSnapshot 快照序列化（写盘前的最后一步）：JSON 是本形态的
// 落盘/取数契约，错误向上传播（handler 拒绝创建，不产出坏链）
func MarshalSessionSnapshot(snap SessionSnapshot) ([]byte, error) {
	return json.Marshal(snap)
}
