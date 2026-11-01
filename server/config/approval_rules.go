package config

import (
	"path"
	"regexp"
	"strings"
	"time"
)

// 审批分类规则（per-op 自动裁决，P-20261003-35）：约定式审批原本只有
// 「每次询问 / 完全允许」两极，规则表提供两极之间的正确粒度——git push 常态化
// 放行、reset --hard 永远拦截、其余走全局默认。规则与 AgentApprovalMode 同住
// settings（同一份 config 文档），随设置 API 整体读写。
//
// 全局档位三档化（P-20261003-316）：完全允许从「永久或每次」二选一扩为三档
// 时限——会话级（仅映射内会话放行）/ 24h（全局带过期）/ 永久（现状）。
// 失效模式安全：deny 误配 = 该类操作被硬拒（Agent 可见报错、用户可调规则），
// 不会静默放权；allow 误配的影响面被「全局 ask 才评估规则」的短路语义收窄，
// 且 24h/会话级档位自带时限边界（忘改回 = 到期自动回 ask，非长期裸奔）。
const (
	// ApprovalEffectAllow 命中即放行：同 allow 模式直落库语义（不弹卡）
	ApprovalEffectAllow = "allow"
	// ApprovalEffectDeny 命中即拒绝：直接以 denied 落库 + 广播终态，不弹卡
	ApprovalEffectDeny = "deny"
	// ApprovalEffectAsk 命中走审批卡流（与未命中默认行为相同，用于显式覆盖
	// 更早的宽/严规则或留档）
	ApprovalEffectAsk = "ask"
)

// 全局审批档位（AgentApprovalMode 取值，P-20261003-316）：ask 为默认；allow
// 即历史「完全允许」= 永久档（既有值语义不变，向后兼容）；allow-24h 全局放行
// 带过期（到期惰性回落 ask）；allow-session 仅放行映射内会话（无会话标识退 ask）
const (
	ApprovalModeAsk          = "ask"
	ApprovalModeAllowSession = "allow-session"
	ApprovalModeAllow24h     = "allow-24h"
	ApprovalModeAllow        = "allow"
)

// ApprovalAllow24hTTL 24h 档位时限：授予（审批卡三选一 / 设置页保存）时从
// 授予时刻起算，到期由判定侧惰性回落 ask（物化回写由周期巡检兜底）
const ApprovalAllow24hTTL = 24 * time.Hour

// ApprovalMaxSessionAllows 会话级放行映射条目上限：会话是少量级实体，上限
// 防御性封顶（授予路径超限裁最旧），与规则表上限同思路
const ApprovalMaxSessionAllows = 64

// ApprovalMaxRules 规则数上限：op 长尾场景几十条足够，上限防设置文档无限
// 膨胀（与 sentinel 上限护栏同思路，数值宽于 sentinel 因规则表是全局长尾清单）
const ApprovalMaxRules = 50

// ApprovalOpMax op/opPattern 长度上限：与 ops-confirm 入口对 op 的 128 字节
// 钳制同宽——规则匹配面被限制在同等长度内，超长输入在入口即被 400 拒绝
const ApprovalOpMax = 128

// ApprovalPathMax pathPattern 长度上限：与 op/opPattern 同宽（128 字节）——
// 路径 glob 是规则匹配面的一半，同等上限足够表达项目相对路径且防设置文档膨胀
const ApprovalPathMax = 128

// AgentApprovalRule 单条审批分类规则。OpPattern 为 op 前缀匹配（大小写不敏感），
// Effect 取 allow|deny|ask。PathPattern 为可选路径条件（P-20261004-67）：glob
// 形态（`**` 跨目录段），与 op 前缀 AND 组合——两者都命中规则才生效；缺省
// （空串，旧配置缺字段即此形态）= 不限路径，存量规则行为零变化。TempUntil 为
// 可选临时窗口（P-20261003-243）：nil = 永久规则（存量行为，旧配置缺字段即此
// 形态）；非 nil = 临时启用至该时刻，到点规则动作惰性回落 ask（判定侧），物化
// 回写 + 通知入账由 ai 模块巡检兜底。指针区分「未配置」与「显式时刻」，与
// AgentApprovalExpiresAt（全局档位 24h 时限）同语义不同形——rules 是整体替换
// 读写的前端本地编辑面，指针让「无窗口」在 JSON 里自然缺省，GET/PUT 往返
// 不为存量规则注入零值时刻
type AgentApprovalRule struct {
	OpPattern   string     `json:"opPattern"`
	PathPattern string     `json:"pathPattern,omitempty"` // 可选路径条件：项目相对路径 glob（`**` 跨目录段），空 = 不限路径
	Effect      string     `json:"effect"`
	TempUntil   *time.Time `json:"tempUntil,omitempty"`
}

// TempWindowExpired 临时窗口是否已过（P-20261003-243）：无窗口恒 false（永久
// 规则）。判定用「!now.Before(end)」——到点即过期，与 EffectiveApprovalMode
// 对全局 24h 档的口径一致
func (r *AgentApprovalRule) TempWindowExpired(now time.Time) bool {
	return r.TempUntil != nil && !now.Before(*r.TempUntil)
}

// ApprovalDecision per-op 审批裁决结果：Effect 为最终裁决，RuleHit 记录命中
// 的规则原文（留审计；未命中为空串；规则带路径条件时追记 `(path: <glob>)`
// 后缀，见 ruleHitLabel）
type ApprovalDecision struct {
	Effect  string
	RuleHit string
}

// ResolveApprovalDecision 按 op+target+会话裁决审批走向（CreateAgentApproval 与
// agentguard 中间件共用的唯一判定出口，保证两条审批创建路径语义一致；
// P-20261003-316 起收敛三档时限判定于此单函数）：
//   - 全局放行档位短路优先——永久 allow 与未过期 allow-24h 不评估规则
//     （设置文案同语义注记）；allow-session 仅当 sessionID 在放行映射内短路，
//     无会话标识或未授予继续走规则表（映射外会话/匿名请求不受会话级档位影响）
//   - 其余按规则表顺序取首个命中（op 前缀 AND 路径 glob 双条件，P-20261004-67；
//     大小写不敏感；空 pattern 跳过）——规则带 PathPattern 时 target 还须是
//     路径形态且命中 glob（命令型/URL 型 target 不参与路径判定 = 该规则按未
//     命中跳过，诚实边界）；PathPattern 缺省 = 不限路径（存量行为零变化）；
//     临时窗口（TempUntil，P-20261003-243）已过的规则命中即回 ask——与到期
//     物化后的形态一致，恢复动作不依赖巡检节奏（判定惰性正确先例同 allow-24h）
//   - 无命中回落 ask = 现行审批卡流（无规则时行为与历史版本零差异）
//
// target 为审批目标原文（ops-confirm 的 target 字段 / agentguard 的请求路径），
// 仅规则带路径条件时才参与解析；now 由调用方注入（单测时间旅行）；会话映射
// 的活性由写路径维护（授予时裁剪死会话 + 终端关闭即时摘除 + 周期巡检兜底），
// 本判定保持纯函数只查映射
func (c *ServerConfig) ResolveApprovalDecision(op, target, sessionID string, now time.Time) ApprovalDecision {
	switch c.EffectiveApprovalMode(now) {
	case ApprovalModeAllow, ApprovalModeAllow24h:
		return ApprovalDecision{Effect: ApprovalEffectAllow}
	case ApprovalModeAllowSession:
		if sid := strings.TrimSpace(sessionID); sid != "" {
			if _, ok := c.AgentSessionAllows[sid]; ok {
				return ApprovalDecision{Effect: ApprovalEffectAllow}
			}
		}
		// 无会话标识退 ask（提案语义：会话级放行只覆盖可归属的会话）
	}
	opNorm := strings.ToLower(strings.TrimSpace(op))
	if opNorm != "" {
		for i := range c.AgentApprovalRules {
			r := &c.AgentApprovalRules[i]
			pattern := strings.ToLower(strings.TrimSpace(r.OpPattern))
			if pattern == "" {
				continue // 空前缀会命中一切，防御性跳过（写入口已拒绝）
			}
			if !strings.HasPrefix(opNorm, pattern) {
				continue
			}
			// 路径条件（P-20261004-67）：与 op 前缀 AND——op 命中后路径 glob
			// 不中（含命令型 target 不参与路径判定）即按未命中继续试后续规则，
			// 不是整表短路
			if pp := strings.TrimSpace(r.PathPattern); pp != "" {
				rel := approvalTargetRelPath(target)
				if rel == "" || !matchPathGlob(pp, rel) {
					continue
				}
			}
			if r.TempWindowExpired(now) {
				// 临时窗口已过（P-20261003-243）：惰性按 ask 裁决——与到期
				// 物化后的规则形态（effect=ask）完全一致，巡检前后行为无跳变；
				// 命中即回（不透传后续规则），RuleHit 照记留审计
				return ApprovalDecision{Effect: ApprovalEffectAsk, RuleHit: ruleHitLabel(r)}
			}
			switch r.Effect {
			case ApprovalEffectAllow, ApprovalEffectDeny, ApprovalEffectAsk:
				return ApprovalDecision{Effect: r.Effect, RuleHit: ruleHitLabel(r)}
			}
			// 未知 effect 按未命中继续（存量脏数据容错，写入口已白名单）
		}
	}
	return ApprovalDecision{Effect: ApprovalEffectAsk}
}

// ruleHitLabel 规则命中注记（RuleHit/审计/轮询回显共用）：op 前缀为基，带路径
// 条件时追记 `(path: <glob>)`——审计里能看出「命中靠的是哪半个条件」；纯 op
// 规则维持原文（存量形态零变化）
func ruleHitLabel(r *AgentApprovalRule) string {
	if pp := strings.TrimSpace(r.PathPattern); pp != "" {
		return strings.TrimSpace(r.OpPattern) + " (path: " + pp + ")"
	}
	return r.OpPattern
}

// ---- 路径条件（P-20261004-67）：target 形态解析 + 双星 glob 匹配 ----
//
// 口径与审批卡 target 消费先例（web/src/utils/approvalTarget.ts 的
// isPathLikeTarget/normRelPath）同源：项目相对路径正斜杠，路径形态从严判定
// （宁降级不误判）；大小写不敏感与 op 前缀同口径（策略面宁多勿漏——ask/deny
// 类规则不因大小写漂移漏拦，allow 类误差面被「规则是用户显式配置」收窄）。

// pathLikeExtRe 单段常见文件形态（README.md、main.go）——分支名/Makefile 等
// 无扩展名单段不视为路径（与卡面守卫同 rationale：漏判只少一次命中，误判会
// 把命令行形态拖进路径 glob）
var pathLikeExtRe = regexp.MustCompile(`\.[A-Za-z0-9]{1,16}$`)

// approvalTargetMaxLen target 参与路径判定的长度上限：与 ops-confirm 入口对
// target 的 512 字节钳制同宽
const approvalTargetMaxLen = 512

// approvalTargetRelPath 提取 target 中的项目相对路径（路径形态守卫 + 归一）。
// 返回空串 = 非路径形态：空白（命令行 git push origin main）、以 / 开头
// （agentguard 服务端强制面的 target 是 /api/... URL——路径规则在中间件面按
// 未命中跳过，诚实边界）、盘符绝对路径、:// URL、单段无扩展名（分支名）。
// 归一：反斜杠统一正斜杠 + 去多余 ./ 前缀（agent 在 Windows 常拼反斜杠）
func approvalTargetRelPath(target string) string {
	s := strings.TrimSpace(target)
	if s == "" || len(s) > approvalTargetMaxLen || strings.ContainsAny(s, " \t\n\r") {
		return ""
	}
	if strings.HasPrefix(s, "/") || strings.Contains(s, "://") {
		return ""
	}
	if len(s) >= 2 && s[1] == ':' && ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z')) {
		return "" // 盘符绝对路径（C:\...）——项目相对口径不参与
	}
	p := strings.ReplaceAll(s, "\\", "/")
	for strings.HasPrefix(p, "./") {
		p = p[2:]
	}
	if p == "" {
		return ""
	}
	if !strings.Contains(p, "/") && !pathLikeExtRe.MatchString(p) {
		return "" // 单段无扩展名：分支名/Makefile 形态，不做路径判定
	}
	return p
}

// matchPathGlob 路径是否命中 glob（** 跨目录段）：模式与路径各按 / 切段，
// `**` 段吞零或多段，其余段 path.Match（单段内无分隔符，* ? [ 照常）。
// 双侧切段后统一小写再匹配——实现平台无关的大小写不敏感（不依赖
// filepath.Match 的平台差异），win/mac/linux 三平台判定一致。
// 借用「双星展开」语义：`docs/**` ≡ docs 自身与 docs 下任意深度、
// `**/*.env` ≡ 根/任意深度的 .env、`src/**/x.go` ≡ src 下跨目录的 x.go；
// 未独立成段的 `**`（如 a**b）按普通 * 处理（段内无分隔符，语义等价）
func matchPathGlob(pattern, rel string) bool {
	return globSegs(splitGlobSegs(pattern), splitGlobSegs(rel), &globBudget{})
}

// globBudget 匹配步数预算：多个 ** 的回溯最坏 O(段数^**数)，预算封顶防病态
// 模式×深路径组合拖住判定热路径（超限按未命中——安全侧回落 ask）
type globBudget struct{ n int }

const globBudgetMax = 10000

func globSegs(pat, segs []string, b *globBudget) bool {
	b.n++
	if b.n > globBudgetMax {
		return false
	}
	if len(pat) == 0 {
		return len(segs) == 0
	}
	if pat[0] == "**" {
		for i := 0; i <= len(segs); i++ {
			if globSegs(pat[1:], segs[i:], b) {
				return true
			}
		}
		return false
	}
	if len(segs) == 0 {
		return false
	}
	if ok, _ := path.Match(pat[0], segs[0]); !ok {
		return false
	}
	return globSegs(pat[1:], segs[1:], b)
}

// splitGlobSegs 按 / 切段（空段丢弃——`docs//x` 容错为 `docs/x`）+ 小写归一；
// glob 与路径共用同一归一口径
func splitGlobSegs(s string) []string {
	parts := strings.Split(strings.ToLower(s), "/")
	segs := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			segs = append(segs, p)
		}
	}
	return segs
}

// NormalizeApprovalPathPattern pathPattern 写/读侧清洗口径：trim + 反斜杠统一
// 正斜杠（项目相对路径口径，与判定侧归一同源——存什么匹配什么，UI 显示即
// 所存形态）。settings 写入口与 GET /settings 出参两侧共用
func NormalizeApprovalPathPattern(p string) string {
	return strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
}

// MatchProjectPathGlob 项目相对路径是否命中 `**` 跨目录段 glob（pathPattern
// 判定的导出面）。P-20261005-235 起敏感写入路径窄表（middleware/agentguard）
// 亦经此匹配——双星语义单实现，规则路径条件与敏感路径表两判定面不漂移。
// 大小写不敏感（双侧切段归一小写），平台无关
func MatchProjectPathGlob(pattern, rel string) bool {
	return matchPathGlob(pattern, rel)
}

// GrantSessionAllow 会话级放行授予（写路径唯一入口）：登记会话并顺带清理——
// 超上限裁最旧授予（会话少量级，64 条防御性封顶）。活性裁剪（会话已关/已死）
// 由调用方持 store 视角另行处理，本方法保持 config 包无 store 依赖
func (c *ServerConfig) GrantSessionAllow(sessionID string, now time.Time) {
	sid := strings.TrimSpace(sessionID)
	if sid == "" {
		return
	}
	if c.AgentSessionAllows == nil {
		c.AgentSessionAllows = make(map[string]time.Time, 1)
	}
	c.AgentSessionAllows[sid] = now
	for len(c.AgentSessionAllows) > ApprovalMaxSessionAllows {
		oldestID := ""
		var oldestAt time.Time
		for id, at := range c.AgentSessionAllows {
			if oldestID == "" || at.Before(oldestAt) {
				oldestID, oldestAt = id, at
			}
		}
		delete(c.AgentSessionAllows, oldestID)
	}
}

// RevokeSessionAllow 会话级放行摘除（终端会话关闭即时清理）：条目不存在为
// 幂等无害
func (c *ServerConfig) RevokeSessionAllow(sessionID string) {
	delete(c.AgentSessionAllows, strings.TrimSpace(sessionID))
}

// ValidateApprovalRules 规则表写入口校验：返回首个错误的用户可读信息
// （空串 = 通过）。pattern 与 op 同宽（128 字节），pathPattern 同宽且须为
// 合法 glob（逐段 path.Match 语法核验），effect 白名单
func ValidateApprovalRules(rules []AgentApprovalRule) string {
	if len(rules) > ApprovalMaxRules {
		return "too many approval rules"
	}
	for _, r := range rules {
		p := strings.TrimSpace(r.OpPattern)
		if p == "" {
			return "opPattern is required"
		}
		if len(p) > ApprovalOpMax {
			return "opPattern too long"
		}
		if pp := NormalizeApprovalPathPattern(r.PathPattern); pp != "" {
			if len(pp) > ApprovalPathMax {
				return "pathPattern too long"
			}
			if !validPathGlob(pp) {
				return "invalid pathPattern glob"
			}
		}
		switch r.Effect {
		case ApprovalEffectAllow, ApprovalEffectDeny, ApprovalEffectAsk:
		default:
			return "invalid effect"
		}
	}
	return ""
}

// validPathGlob glob 合法性核验：与 matchPathGlob 同一切段口径逐段
// path.Match 语法核验（未闭合 [ 等 ErrBadPattern 在写入端拒绝——运行期
// 判定对非法段按未命中处理，这里挡在前面的目的是让用户保存时即刻可见）
func validPathGlob(p string) bool {
	for _, seg := range splitGlobSegs(p) {
		if _, err := path.Match(seg, "x"); err != nil {
			return false
		}
	}
	return true
}
