package terminal

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// agent 会话命名系统（P-20261007-22 纯搬运自 terminal.go，零逻辑改动）：
// prompt 摘要名/槽位继承/序号默认名的决策链（resolveAgentSessionName）、
// 同名消歧步进（dedupeAgentSessionName）、命名注记注入（withAgentNamingNote）
// 与 rename 重名警示载荷（duplicateAgentSessions）

// promptSessionNameMax 会话摘要名的截断宽度（rune）：侧栏/会话中心/值班大屏/
// 审批卡等单行识别位上可读性与不吞内容的平衡点（P-20261003-12）
const promptSessionNameMax = 24

// dedupeSuffixSeparator 同名消歧步进后缀的「基名 + 后缀」分隔符（P-20261023-3）：
// 「·2/·3」序号优先于日期——同任务同日重建仍会撞日期形态，序号单调递增无歧义
const dedupeSuffixSeparator = "·"

// flagFormLaunchArgs launchArgs 是否旗标形态（--resume <id> 等 Claude 恢复链
// 注入的 CLI 参数）而非 prompt：首非空行以 "-" 开头。promptSessionName 的
// 旗标判别提取复用——命名注记注入与 resumed 标记同口径跳过旗标
func flagFormLaunchArgs(launchArgs string) bool {
	for _, line := range strings.Split(launchArgs, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		return strings.HasPrefix(line, "-")
	}
	return false
}

// agentNamingNoteLine 会话命名系统注记（P-20261023-3）：随初始 prompt 尾部
// 注入的 agent 第一人称行为面——会话寻址（CC_TERMINAL_ID 环境变量随会话注入）
// + 任务演化改名指令（≤16 字简称保单行识别位可读，先查重防再造同名歧义）。
// 语言按调用方 Accept-Language 双语（zh 系中文，其余英文）——agent 运行时
// 语言不受 UI locale 约束，与默认会话名（defaultSessionNumberedName）同约定。
// 恒单行：prompt 首行派生名的语义边界在「首行」，注记多行会稀释装配约定
func agentNamingNoteLine(lang string) string {
	if strings.HasPrefix(strings.ToLower(lang), "zh") {
		return "[系统注记] 会话 id=$CC_TERMINAL_ID。若任务与会话当前名不符，第一时间用 ≤16 字任务简称重命名（重命名前先 GET /api/terminals 对照会话列表查重，勿与存量会话同名）"
	}
	return "[System note] Session id=$CC_TERMINAL_ID. If the task no longer matches this session's name, rename it immediately to a short task label of at most 16 chars (check GET /api/terminals for duplicates first; do not reuse an existing session's name)"
}

// withAgentNamingNote 命名注记拼装（P-20261023-3，纯函数便于单测）：注记开关
// 开、launchArgs 承载 prompt（非空、非旗标形态）、运行时非纯 shell 时在尾部
// 附系统注记并返回注入态；否则原样返回。跳过口径：
//   - 旗标形态（--resume <id>）：无 prompt 可注记，且 resumed 标记已另行判定
//   - 纯 shell（runtime=shell）：launchArgs 是待执行命令不是任务语境，注记
//     进 shell 命令行即成待执行文本，污染语义
func withAgentNamingNote(launchArgs string, noteEnabled, shellRuntime bool, lang string) (string, bool) {
	if !noteEnabled || shellRuntime || launchArgs == "" || flagFormLaunchArgs(launchArgs) {
		return launchArgs, false
	}
	return launchArgs + "\n" + agentNamingNoteLine(lang), true
}

// dedupeAgentSessionName 同名消歧步进（P-20261023-3，纯函数便于单测）：base
// 与存量 agent 会话名冲突时步进「·2/·3」直到无冲突（步进产物自身撞名继续
// 步进——同任务三连建得 ·2/·3 两个名字而非复用同后缀）；无冲突原样返回。
// 上限兜底理论不可达分支（千级同基名），保底原名不阻断创建
func dedupeAgentSessionName(base string, taken map[string]bool) string {
	if base == "" || !taken[base] {
		return base
	}
	for i := 2; i < 1000; i++ {
		candidate := base + dedupeSuffixSeparator + strconv.Itoa(i)
		if !taken[candidate] {
			return candidate
		}
	}
	return base
}

// liveAgentSessionNames 现存 agent 会话名集合（同名消歧的对照面）：取管理器
// 在册 kind=agent 会话——侧栏树呈现的就是这份名单，与用户感知同名歧义同一
// 口径；项目会话（kind=shell）独立成树且默认名（Terminal N）高度重复，不参
// 与对照防误步进。创建链调用一次 O(n) 遍历，非热路径
func liveAgentSessionNames() map[string]bool {
	taken := make(map[string]bool)
	for _, s := range terminal.DefaultManager.ListSessions() {
		if s.Kind == terminal.KindAgent {
			taken[s.Name] = true
		}
	}
	return taken
}

// duplicateAgentSessions 同名会话摘要（P-20261023-3，纯函数便于单测）：name
// 与之同名的其余 agent 会话清单（id/名/创建时间/最近活动）——rename 端点
// duplicate 警示载荷的数据面。显示名允许重名的既有语义不变，本清单只做
// 「重名了、还有谁」的知情补全；kind=agent 同 liveAgentSessionNames 口径
func duplicateAgentSessions(excludeID, name string, sessions []*terminal.Session) []gin.H {
	if strings.TrimSpace(name) == "" {
		return nil
	}
	var out []gin.H
	for _, s := range sessions {
		if s.Kind != terminal.KindAgent || s.ID == excludeID || s.Name != name {
			continue
		}
		item := gin.H{"id": s.ID, "name": s.Name, "createdAt": s.CreatedAt}
		if last := s.LastActivity(); !last.IsZero() {
			item["lastActivity"] = last
		}
		out = append(out, item)
	}
	return out
}

// promptSessionName 以 prompt（launchArgs）首行派生 agent 会话摘要名
// （P-20261003-12）：取首个非空行，控制字符折叠为空格（沿 share 侧
// sanitizeSnippetTitle 的单行展示位既有口径），超 promptSessionNameMax rune
// 截断加省略号。launchArgs 兼承载旗标形态（Claude 恢复链注入的 --resume <id>）
// 而非 prompt——以 "-" 开头判别为旗标，返回空串交回调用方既有命名链
// （恢复场景槽位名继承跟随目录）；无可派生内容（空/全空白）同样返回空串
func promptSessionName(launchArgs string) string {
	for _, line := range strings.Split(launchArgs, "\n") {
		line = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, line))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "-") {
			return "" // 旗标形态（--resume 等）非 prompt，不派生
		}
		if utf8.RuneCountInString(line) > promptSessionNameMax {
			return string([]rune(line)[:promptSessionNameMax]) + "…"
		}
		return line
	}
	return ""
}

// resolveAgentSessionName agent 会话命名决策（纯函数，便于单测；P-20261003-12）：
//   - 显式命名优先（前端显式名/定时任务名 P-43），非空不覆盖
//   - 未命名：prompt（launchArgs）首行摘要名优先——P-28/P-122/P-138/跨智能体
//     审查链等带 prompt 的创建路径免于序号默认名，列表以摘要即可辨识
//   - 非 prompt 形态回落槽位名继承（同运行时，同工作目录优先——native 重启后
//     重建会话的名称还原；Claude 恢复场景命名跟随目录），无记录用现存 agent
//     会话数 + 1 的序号默认名。选型后的 runtimeName 是继承槽位键
func resolveAgentSessionName(name, launchArgs, runtimeName, dir, lang string) string {
	if name != "" {
		return name
	}
	if derived := promptSessionName(launchArgs); derived != "" {
		return derived
	}
	if inherited := inheritDisplayName("", runtimeName, dir); inherited != "" {
		return inherited
	}
	return defaultSessionNumberedName(lang, "")
}

// inheritDisplayName 新建会话未显式命名时的名称继承（native 重启场景的名称
// 还原）：native 后端会话随进程消亡，重启后新建的会话走不到 tmux 恢复链路，
// 此前用户改名全部丢失——按逻辑槽位回查最近一次用户手动命名（Named）作为
// 初始名。槽位规则：
//   - 项目终端（projectID 非空）：同项目（meta.ProjectID 相等）
//   - agent 会话：同运行时（meta.Runtime 相等），同工作目录的记录优先
//     （Claude 恢复等场景命名跟随目录）
//
// 多条命中取 NamedAt 最新；无命中返回空串（调用方回退序号默认名）。
// tmux 恢复链路按会话 ID 直取 meta 还原显示名，不经此逻辑，互不影响
func inheritDisplayName(projectID, runtime, dir string) string {
	metas, err := store.Get().AgentSession.List()
	if err != nil {
		return ""
	}
	bestName := ""
	var bestAt time.Time
	bestDir := false
	for _, m := range metas {
		if !m.Named || m.Name == "" {
			continue
		}
		var slot bool
		if projectID != "" {
			slot = m.ProjectID == projectID
		} else {
			// agent 槽位排除项目会话的 meta（其 Runtime 同为空，靠 ProjectID 区分）
			slot = m.ProjectID == "" && m.Runtime == runtime
		}
		if !slot {
			continue
		}
		dirMatch := dir != "" && m.Dir == dir
		if bestName != "" {
			if bestDir && !dirMatch {
				continue // 现任是同目录命中，不同目录的候选拿不下
			}
			if dirMatch == bestDir && !m.NamedAt.After(bestAt) {
				continue
			}
		}
		bestName, bestAt, bestDir = m.Name, m.NamedAt, dirMatch
	}
	return bestName
}

// defaultSessionNumberedName 序号默认名（未显式命名且无继承记录时）：序号 =
// 同槽位现存会话数 + 1（项目终端按项目计，agent 会话按 kind 计）。语言按调用方
// 传入的 Accept-Language 头值双语（zh 系中文，其余英文），与 share 页的约定
// 一致——默认名统一由服务端生成后，前端不再自行拼装，改名/继承/新建才有
// 一个命名事实源。无请求上下文的调用方（agentcron 调度器）传空 = 英文默认
func defaultSessionNumberedName(lang, projectID string) string {
	n := 0
	for _, s := range terminal.DefaultManager.ListSessions() {
		if projectID != "" {
			if s.ProjectID == projectID {
				n++
			}
		} else if s.Kind == terminal.KindAgent {
			n++
		}
	}
	label := "Terminal"
	if strings.HasPrefix(strings.ToLower(lang), "zh") {
		label = "终端"
	}
	return fmt.Sprintf("%s %d", label, n+1)
}
