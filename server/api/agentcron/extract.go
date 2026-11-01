package agentcron

// extract.go（P-20261005-237 cron 输出指标抽取管道）：任务完成回执落定时从
// 会话输出尾窗按任务 extract 规则抽取一个数值，追加进 per-任务时序（车道 1
// kind cronmetric，环形 30 点）——「这周构建是不是变慢了」从人盯输出变自动
// 曲线，运维探测（内存/磁盘/队列深度）序列化零成本接入。
//
// 素材与原语（复用既有实现不另起炉灶）：
//   尾窗读取  Session.CaptureScrollback（P-100 同原语，postmortem 尾读同款；
//             tmux capture-pane / native 环形缓冲两后端皆可用）
//   剥 ANSI   terminal.StripANSI（postmortem.captureLiveTail 同链）
// 规则两形态（保存口 validateExtract 压实，运行期只可能「无数据」不可能「坏规则」）：
//   正则      Go RE2 + 首个命名捕获组承载数值（组名即指标名）
//   JSON 路径 `json:` 前缀 + 点分路径（整窗优先、末行 JSON 摘要兜底）
// 抽取失败如实「无数据」：无命中/值不可解析/会话已销毁一律不落点，绝不硬凑 0
// （DiagSnapshot 零值隐藏同纪律）。落盘的只有数值点，输出原文不入库——
// 数值非敏感面，无遮蔽需求（与验尸/检索携原文的链路面不同）。

import (
	"encoding/json"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"

	"codecombo/server/store"
	"codecombo/server/terminal"
)

const (
	// extractTailLines 尾窗行数预算：折行余量（一行逻辑文本在缓冲里可能是
	// 多行），与 postmortem pmCaptureLines 同量级
	extractTailLines = 120
	// extractTailMaxBytes 尾窗字节预算：防无换行超长行把正则扫描面拖爆
	//（裁剪保尾——越靠后越新，postmortem clampTail 同向）
	extractTailMaxBytes = 32 << 10
	// extractRuleMax 规则存储字节上限：正则表达力足够，超长规则通常是把
	// 匹配逻辑写进了规则（应在输出端解决），保存口拒收
	extractRuleMax = 256
	// jsonExtractPrefix JSON 路径形态前缀（带此前缀按路径处理，其余一律按正则）
	jsonExtractPrefix = "json:"
)

// validateExtract 保存口校验并归一（api.go validateCronPayload 调用）：
//   - 空 = 关闭（存量零迁移）
//   - json: 前缀 = 路径非空且每段非空
//   - 其余按正则：可编译 + 至少一个命名捕获组（数值载体，运行期取首个命名组）
//
// 返回首个错误的用户可读信息（英文短句，与同函数族 validateTrigger 词汇一致）
func validateExtract(rule *string) string {
	*rule = strings.TrimSpace(*rule)
	r := *rule
	if r == "" {
		return ""
	}
	if len(r) > extractRuleMax {
		return "extract rule too long"
	}
	if strings.HasPrefix(r, jsonExtractPrefix) {
		path := strings.TrimPrefix(r, jsonExtractPrefix)
		if strings.TrimSpace(path) == "" {
			return "extract json path is empty"
		}
		for _, seg := range strings.Split(path, ".") {
			if strings.TrimSpace(seg) == "" {
				return "extract json path has empty segment"
			}
		}
		return ""
	}
	re, err := regexp.Compile(r)
	if err != nil {
		return "extract rule is not a valid regex"
	}
	for _, n := range re.SubexpNames() {
		if n != "" {
			return ""
		}
	}
	return "extract regex must have a named capture group"
}

// ExtractMetricName 规则 → 指标名（列表载荷 series.name）：正则 = 首个命名组，
// JSON 路径 = 末段。规则已过保存口校验，坏形态理论不可达（空串回落防御）
func ExtractMetricName(rule string) string {
	if strings.HasPrefix(rule, jsonExtractPrefix) {
		path := strings.TrimPrefix(rule, jsonExtractPrefix)
		if i := strings.LastIndexByte(path, '.'); i >= 0 {
			return path[i+1:]
		}
		return path
	}
	if re, err := regexp.Compile(rule); err == nil {
		for _, n := range re.SubexpNames() {
			if n != "" {
				return n
			}
		}
	}
	return ""
}

// extractValue 按规则从尾窗文本取数值（纯函数，单测锚点）：
//   - 正则：命中自后向前找首个捕获值可解析为浮点的（输出时序上越靠后越新，
//     构建汇总行通常在尾部；最后一条若偶发不可解析不放弃更早的命中）
//   - JSON：整窗优先解析、逐行自尾向头兜底（构建工具「末行打印 JSON 摘要」
//     形态），路径逐段导航，命中 JSON 数字或数字字符串才成立
//
// 无命中/值不可解析 = false，调用方如实不落点
func extractValue(rule, tail string) (float64, bool) {
	if strings.HasPrefix(rule, jsonExtractPrefix) {
		return extractJSONValue(strings.TrimPrefix(rule, jsonExtractPrefix), tail)
	}
	re, err := regexp.Compile(rule)
	if err != nil {
		return 0, false // 保存口已压实，防御性兜底
	}
	group := -1
	for i, n := range re.SubexpNames() {
		if n != "" {
			group = i
			break
		}
	}
	if group < 0 {
		return 0, false
	}
	ms := re.FindAllStringSubmatch(tail, -1)
	for i := len(ms) - 1; i >= 0; i-- {
		if v, err := strconv.ParseFloat(strings.TrimSpace(ms[i][group]), 64); err == nil {
			return v, true
		}
	}
	return 0, false
}

// extractJSONValue JSON 路径取值：整窗先试，失败再逐行自尾向头试（行序见
// jsonCandidates）。路径逐段导航 map，命中 JSON 数字（float64）或数字字符串
// 才成立——非数值叶（布尔/嵌套对象/数组）视同未命中
func extractJSONValue(path, tail string) (float64, bool) {
	for _, candidate := range jsonCandidates(tail) {
		var doc any
		if json.Unmarshal([]byte(candidate), &doc) != nil {
			continue
		}
		cur := doc
		missed := false
		for _, seg := range strings.Split(path, ".") {
			m, ok := cur.(map[string]any)
			if !ok {
				missed = true
				break
			}
			if cur, ok = m[strings.TrimSpace(seg)]; !ok {
				missed = true
				break
			}
		}
		if missed {
			continue
		}
		switch v := cur.(type) {
		case float64:
			return v, true
		case string:
			if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
				return f, true
			}
		}
	}
	return 0, false
}

// jsonCandidates JSON 解析候选：整窗一枚 + 非空行自尾向头逐枚。
// 终端输出整窗是 JSON 的形态少见、构建工具末行打 JSON 摘要更常见——整窗
// 优先保证多行 JSON 文档不缺候选，末行兜底保证单行摘要不被整窗噪声拖累
func jsonCandidates(tail string) []string {
	lines := strings.Split(tail, "\n")
	out := make([]string, 0, len(lines)+1)
	out = append(out, strings.TrimSpace(tail))
	for i := len(lines) - 1; i >= 0; i-- {
		if ln := strings.TrimSpace(lines[i]); ln != "" {
			out = append(out, ln)
		}
	}
	return out
}

// readSessionTail 在册会话的输出尾窗（行+字节双预算，剥 ANSI 纯文本）。
// 会话不在册（已销毁/服务重启后 native 缓冲随会话消失）返回空串——现场
// 不可得如实「无数据」，不另走 transcript 兜底（postmortem 的人读报告可以
// 翻转写；时序点位要的是确定性数值，transcript 尾读的错挂风险大于收益）
func readSessionTail(sessionID string) string {
	sess := terminal.DefaultManager.GetSession(sessionID)
	if sess == nil {
		return ""
	}
	raw, err := sess.CaptureScrollback(extractTailLines)
	if err != nil || len(raw) == 0 {
		return ""
	}
	return clampExtractTail(string(terminal.StripANSI(raw)))
}

// clampExtractTail 尾窗裁剪：行数超限裁最旧、字节超限自更早的行丢弃（保尾
// 语义，postmortem clampTail 同式）。返回文本不以换行结尾
func clampExtractTail(text string) string {
	lines := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	if len(lines) > extractTailLines {
		lines = lines[len(lines)-extractTailLines:]
	}
	total := 0
	start := len(lines)
	for i := len(lines) - 1; i >= 0; i-- {
		total += len(lines[i]) + 1
		if total > extractTailMaxBytes {
			break
		}
		start = i
	}
	if start < len(lines) {
		lines = lines[start:]
	}
	return strings.TrimRight(strings.Join(lines, "\n"), "\n")
}

// extractMetricPoint 完成回执落定后的指标抽取：按规则从尾窗取数值追加进
// 任务时序（环形有界）。尽力而为——无规则由调用方短路；尾窗读不到/无命中/
// 落库失败只记日志，绝不阻断完成回执主链，也绝不硬凑点位
func extractMetricPoint(cronID, rule, sessionID string, tailFn func(string) string) {
	tail := tailFn(sessionID)
	if tail == "" {
		return
	}
	v, ok := extractValue(rule, tail)
	if !ok {
		return
	}
	store.Get().CronMetric.Append(cronID, store.CronMetricPoint{At: time.Now(), Value: v})
	slog.Info("agentcron metric extracted", "cron", cronID, "value", v)
}
