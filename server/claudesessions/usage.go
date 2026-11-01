// 会话 token 用量聚合（P-20261002-139）：扫描链路（scanFile 全文逐行）顺带
// 累计 assistant 消息 message.usage（input+output+cache_read），按会话聚合，
// 供会话列表「总 token」展示与日报当日消耗维度。
//
// 与 P-58 压力指示（pressure.go）的分工：两者共享同一 usage 解析基建
// （parseAssistantUsage）但语义不同——压力取尾部最近一条做「此刻窗口占用」
// 近似（≈ 前缀标注）；本文件把每条 assistant 行的用量全量精确累计成「累计
// 处理量」账目（每轮请求的 input/cache_read 都真实计费/计算过，逐条求和即
// 总工作量）。展示上 P-58 带 ≈、本聚合为精确值，互不冲突。
package claudesessions

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Usage 会话累计 token 用量（对外 JSON 形态即 API 契约）。口径 = input +
// output + cache_read（提案原文；cache_creation 不计入）。Total 即会话列表
// 展示值，分项留存供后续细分展示
type Usage struct {
	InputTokens     int64 `json:"inputTokens"`
	OutputTokens    int64 `json:"outputTokens"`
	CacheReadTokens int64 `json:"cacheReadTokens"`
	TotalTokens     int64 `json:"totalTokens"`
}

// usageKey usage 键子串预滤：assistant 行才可能携带 message.usage，其余行
// 零解析成本直接跳过（ transcript 行数远多于 assistant 行）
var usageKey = []byte(`"usage"`)

// accumulateUsage 单行累计钩子（scanFile 扫描循环调用）：携带有效 usage 的
// assistant 行累计入会话聚合。isAssistantLine 预滤 + parseAssistantUsage 宽容
// 解析——type=assistant 之外的行（合成条目/工具结果内嵌 usage 串）、sidechain、
// usage 缺失/全零/坏 JSON 行一律不计（坏数据宽容，绝不因单行让扫描失败）
func accumulateUsage(s *Session, line []byte) {
	if !bytes.Contains(line, usageKey) || !isAssistantLine(line) {
		return
	}
	u, _, ok := parseAssistantUsage(line)
	if !ok {
		return
	}
	if s.Usage == nil {
		s.Usage = &Usage{}
	}
	s.Usage.InputTokens += int64(u.InputTokens)
	s.Usage.OutputTokens += int64(u.OutputTokens)
	s.Usage.CacheReadTokens += int64(u.CacheReadTokens)
	s.Usage.TotalTokens += int64(u.InputTokens + u.OutputTokens + u.CacheReadTokens)
}

// SpendThresholdHit 会话累计用量是否达到花费告警阈值（P-20261003-157 纯判定，
// 与通知/防重解耦——通知侧在 api/terminal）：threshold<=0 = 功能关恒 false；
// 无 usage 数据（「无数据」≠「零消耗」）恒 false——不能因 transcript 缺 usage
// 行就告警；≥ 语义（达到即告警，会话总量单调增长，后续由标记位防重）
func SpendThresholdHit(u *Usage, threshold int) bool {
	if threshold <= 0 || u == nil {
		return false
	}
	return u.TotalTokens >= int64(threshold)
}

// UsageWindow 单条 transcript 在 [start, end) 时间窗内的用量合计（日报当日
// 消耗维度用）：按 usage 行自身 timestamp 归窗——会话可跨天 resume，条目级
// 聚合是生命周期总量，按天回溯必须逐行归窗。行时间戳缺失/解析失败的 usage
// 行无法归窗，跳过（容错语义与全包一致）。会话 id 含路径分隔符/扩展符拒绝
// （与 LocateSession 同款防目录穿越）；文件不可读返回 err，窗内无数据返回
// ok=false（「无数据」≠「零消耗」）
func UsageWindow(root, dirName, sessionID string, start, end time.Time) (Usage, bool, error) {
	if root == "" || sessionID == "" || strings.ContainsAny(sessionID, "\\/.") {
		return Usage{}, false, nil
	}
	data, err := os.ReadFile(filepath.Join(root, dirName, sessionID+".jsonl"))
	if err != nil {
		return Usage{}, false, err
	}
	var total Usage
	ok := false
	for offset := 0; offset < len(data); {
		var line []byte
		if nl := bytes.IndexByte(data[offset:], '\n'); nl >= 0 {
			line = data[offset : offset+nl]
			offset += nl + 1
		} else {
			line = data[offset:]
			offset = len(data)
		}
		if !bytes.Contains(line, usageKey) || !isAssistantLine(line) {
			continue
		}
		u, at, valid := parseAssistantUsage(line)
		if !valid {
			continue
		}
		ts, err := time.Parse(time.RFC3339, at)
		if err != nil || ts.Before(start) || !ts.Before(end) {
			continue
		}
		ok = true
		total.InputTokens += int64(u.InputTokens)
		total.OutputTokens += int64(u.OutputTokens)
		total.CacheReadTokens += int64(u.CacheReadTokens)
		total.TotalTokens += int64(u.InputTokens + u.OutputTokens + u.CacheReadTokens)
	}
	return total, ok, nil
}
