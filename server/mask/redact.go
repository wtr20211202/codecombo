package mask

// 审批面密钥脱敏（P-20261003-197）：
// 审批 Target/Detail/impact 是 agent 拼的自由文本，常携带命令原文（curl -H
// "Authorization: Bearer sk-…"）——明文入库会随审批记录（30 天保留档）、卡面
// 广播（多标签）与 webhook/通知外发扩散。MaskApprovalText 在入库前对这类文本
// 做一轮「已知密钥前缀 + 高熵长串」遮蔽，打底先过 MaskText（P-108 全量模式集
// 同源复用勿分叉，勿在此之外另起第三套正则族）。
//
// 与录制面（mask.go 流式 tap / 回放兜底）的关系：本文件只服务审批面的全量
// 文本（完整短串，非流式），④⑤两模式不进 tap 状态机与回放模式集——录制
// 证据内容不因审批面扩模式而改变；改 ④⑤ 任一侧（Go↔TS
// utils/sensitiveMask.ts maskApprovalSecrets）必须同步另一侧与双侧单测
// （redact_test.go ↔ sensitiveMask.test.ts 同一语料互锁）。消费方：api/ai 与
// middleware 两条审批创建路径入库前调用——middleware 可直依赖本包（模式族
// 独立成包的原因之一，见 mask.go 头注）。
//
// 首尾保留（风险注记「高熵误判容忍」的缓解）：④保留前缀+尾 4（知道是哪家的
// key，对账惯例同 share.TokenSummary 的「可对账不可重放」），⑤保留首 4 尾 4
// ——误判时（普通长标识符被当成密钥）原文仍可辨认。

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// secretTailKeep 遮蔽替换保留的尾部可读字符数（④⑤同值；与 share.TokenSummary
// 「前 8 位可对账」同族的短尾对账惯例）
const secretTailKeep = 4

// secretPrefixes 已知密钥前缀字面量（④；maskSecretToken 拆前缀用，长前缀在前
// ——HasPrefix 取最长命中）：github_pat_（GitHub fine-grained）/ sk_live_/
// sk_test_（Stripe）/ gh?_（GitHub ghp_/gho_/ghu_/ghs_/ghr_）/ glpat-（GitLab）/
// xox?-（Slack xoxa-/xoxb-/xoxp-/xoxr-/xoxs-）/ npm_ / sk-（OpenAI 系，含
// sk-proj-/sk-ant- 等）
var secretPrefixes = [...]string{
	"github_pat_", "sk_live_", "sk_test_",
	"ghp_", "gho_", "ghu_", "ghs_", "ghr_", "glpat-",
	"xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-",
	"npm_", "sk-",
}

// secretTokenRe 已知密钥前缀（④）：起始三态边界同模式②③（文本起点/非词字符/
// 无 SGR 需求——审批文本无着色回显），「task-2024…」这类连字 ID 的 "sk-" 嵌段
// （前接词字符）不误遮；值段 [A-Za-z0-9_-]{12,}（真 token 值体远长于此）
var secretTokenRe = regexp.MustCompile(
	`(^|[^A-Za-z0-9_])(?:github_pat_|sk_live_|sk_test_|gh[a-z]_|glpat-|xox[a-z]-|npm_|sk-)[A-Za-z0-9_-]{12,}`)

// highEntropyRe 高熵长串候选（⑤）：≥20 连续密钥字符集。刻意不含 / \（路径段
// 不粘成超长候选——审批 target 常是路径）与 =（键名保持完整可读）；是否真密钥
// 由 maskHighEntropyRun 的字符类别校验判定
var highEntropyRe = regexp.MustCompile(`[A-Za-z0-9+_-]{20,}`)

// MaskApprovalText 审批面密钥脱敏：P-108 全量模式集（sc 令牌/赋值形态/AKIA）
// 打底，再过 ④已知前缀 ⑤高熵长串。审批 Target/Detail/impact 入库前与前端展示
// 兜底（utils/sensitiveMask.ts maskApprovalSecrets）共用本语义
func MaskApprovalText(s string) string {
	s = MaskText(s)
	s = maskByFunc(s, secretTokenRe, maskSecretToken)
	s = maskByFunc(s, highEntropyRe, maskHighEntropyRun)
	return s
}

// maskByFunc 带回调的全量替换（RE2 无环视，④的起始边界由捕获组消费、回调收
// 到完整匹配含边界字符）。等价于 ReplaceAllStringFunc 但不影响边界判定
func maskByFunc(s string, re *regexp.Regexp, f func(match string) string) string {
	locs := re.FindAllStringIndex(s, -1)
	if len(locs) == 0 {
		return s
	}
	var b strings.Builder
	prev := 0
	for _, l := range locs {
		b.WriteString(s[prev:l[0]])
		b.WriteString(f(s[l[0]:l[1]]))
		prev = l[1]
	}
	b.WriteString(s[prev:])
	return b.String()
}

// maskSecretToken ④已知前缀令牌：前缀（含）保留作「首」，值段替换为 *** + 尾
// secretTailKeep——「sk-***I789」形态。匹配含边界字符时（非文本起点）边界原样
// 还原；边界类排除词字符，s/g/x/n 作首 rune 必为 ^ 空边界下的令牌本体。边界
// 字符按 rune 解码剥离（中文语境的「：ghp_…」边界是多字节——按字节切会把
// rune 劈半，前缀判定与首部可读性一起坏）
func maskSecretToken(m string) string {
	head, body := "", m
	if r, size := utf8.DecodeRuneInString(m); r != 's' && r != 'g' && r != 'x' && r != 'n' {
		head, body = m[:size], m[size:]
	}
	n := 0
	for _, p := range secretPrefixes {
		if len(p) > n && strings.HasPrefix(body, p) {
			n = len(p)
		}
	}
	tail := body[n:]
	if len(tail) > secretTailKeep {
		tail = tail[len(tail)-secretTailKeep:]
	}
	return head + body[:n] + tokenMask + tail
}

// maskHighEntropyRun ⑤高熵长串：大小写+数字三类齐备才判密钥——git SHA（纯
// hex）/纯数字/普通单词（缺类别）零误伤；命中替换保首 secretTailKeep 尾
// secretTailKeep（误判容忍：原文骨架仍可辨认）
func maskHighEntropyRun(m string) string {
	var up, lo, di bool
	for i := 0; i < len(m); i++ {
		switch c := m[i]; {
		case c >= 'A' && c <= 'Z':
			up = true
		case c >= 'a' && c <= 'z':
			lo = true
		case c >= '0' && c <= '9':
			di = true
		}
	}
	if !up || !lo || !di {
		return m
	}
	return m[:secretTailKeep] + tokenMask + m[len(m)-secretTailKeep:]
}
