// 会话上下文压力（P-20261002-58）：读 transcript 尾部窗口，取最近一条携带
// usage 元数据的 assistant 条目，把其 token 计数近似为当前上下文占用，对照
// 200k 窗口给出百分比——全部为估算值，供「何时 /compact、何时开新会话」的
// 余量感知，不是精确账目。
//
// 为什么取「最近一条」而非窗口内求和：claude 每轮请求上报的 usage.input /
// cache_* 已包含全部历史 prompt（每轮全量重算），窗口内求和会把同一段历史
// 重复累计数十倍；最新一条天然是「此刻窗口里有什么」的快照。/compact 或
// 新会话后计数回落，最新一条同样如实反映。
//
// 子代理（isSidechain）条目属于独立上下文，计入会低估主线压力——跳过。
package claudesessions

import (
	"math"
	"os"
)

// 压力约束常量（与时间线同族的防超大文件口径，共享 P-3 尾部回读基建）：
// 最近 ~50 条且最多 1MB——assistant 行可能带整段回复正文，仍有余量
const (
	pressureWindowLines = 50
	pressureWindowBytes = 1 << 20

	// ContextWindowTokens claude 上下文窗口基准（估算百分比的分母）。
	// 窗口随模型代际演进，此处取 200k 为当前主流值；估算语义下无需精确到具体模型
	ContextWindowTokens = 200_000
)

// Pressure 上下文压力估算值（JSON 形态即 API 契约，前端按 estimated 字段
// 识别估算语义）
type Pressure struct {
	EstimatedTokens int     `json:"estimatedTokens"`
	WindowTokens    int     `json:"windowTokens"`
	Percent         float64 `json:"percent"`
	// SampledAt 所用 assistant 条目的 timestamp（RFC3339；该行缺失时为空）
	SampledAt string `json:"sampledAt,omitempty"`
	// Estimated 恒 true：百分比是尾部 usage 近似，显式标注防误读为精确值
	Estimated bool `json:"estimated"`
}

// assistantUsage assistant 行 message.usage 的 token 计数（字段缺失视为 0）
type assistantUsage struct {
	InputTokens         int `json:"input_tokens"`
	OutputTokens        int `json:"output_tokens"`
	CacheCreationTokens int `json:"cache_creation_input_tokens"`
	CacheReadTokens     int `json:"cache_read_input_tokens"`
}

func (u assistantUsage) total() int {
	return u.InputTokens + u.OutputTokens + u.CacheCreationTokens + u.CacheReadTokens
}

// ContextPressure 单会话上下文压力：尾部窗口内自新向旧找第一条可用 usage 的
// 主线 assistant 条目。窗口内无可用 usage（纯 shell 记录/极老格式/全零计数）
// 返回 ok=false（「无数据」≠「零压力」，调用方不得当 0% 展示）；
// 会话不存在返回 ErrSessionNotFound
func ContextPressure(root, sessionID string) (Pressure, bool, error) {
	path, ok := LocateSession(root, sessionID)
	if !ok {
		return Pressure{}, false, ErrSessionNotFound
	}
	f, err := os.Open(path)
	if err != nil {
		return Pressure{}, false, err
	}
	defer f.Close() //nolint:errcheck // 只读句柄，关闭失败无可补救动作
	st, err := f.Stat()
	if err != nil {
		return Pressure{}, false, err
	}

	lines, _ := collectTailLines(f, st.Size(), pressureWindowLines, pressureWindowBytes)
	// lines 为时间正序：自尾向前找最近一条可用 usage
	for i := len(lines) - 1; i >= 0; i-- {
		if !isAssistantLine(lines[i]) {
			continue
		}
		u, at, ok := parseAssistantUsage(lines[i])
		if !ok {
			continue
		}
		return newPressure(u, at), true, nil
	}
	return Pressure{}, false, nil
}

// newPressure usage 快照 → 估算值（百分比一位小数，窗口溢出允许 >100——
// 如实上报超窗事实，红档提示交给前端）
func newPressure(u assistantUsage, at string) Pressure {
	total := u.total()
	p := Pressure{
		EstimatedTokens: total,
		WindowTokens:    ContextWindowTokens,
		Percent:         float64(total) / float64(ContextWindowTokens) * 100,
		SampledAt:       at,
		Estimated:       true,
	}
	p.Percent = math.Round(p.Percent*10) / 10
	return p
}

// parseAssistantUsage 解析 assistant 行的 message.usage 与 timestamp。
// 子代理行（isSidechain，独立上下文）与无有效计数的行（usage 键缺失/全零，
// 如老格式或合成条目）→ ok=false，调用方向更早条目继续找
func parseAssistantUsage(line []byte) (assistantUsage, string, bool) {
	var m struct {
		Message struct {
			Usage assistantUsage `json:"usage"`
		} `json:"message"`
		IsSidechain bool   `json:"isSidechain"`
		Timestamp   string `json:"timestamp"`
	}
	if !looseUnmarshal(line, &m) || m.IsSidechain {
		return assistantUsage{}, "", false
	}
	u := m.Message.Usage
	if u.total() == 0 {
		return assistantUsage{}, "", false
	}
	return u, m.Timestamp, true
}
