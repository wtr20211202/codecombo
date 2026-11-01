package terminal

import (
	"log/slog"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// Claude 会话 Active 判定的终端注册表校正（P-20261031-1）。
//
// 包内 claudesessions 的 Active 是 mtime 启发式：transcript 文件 5 分钟内有
// 追加即判「进行中」。僵尸形态：终端已关闭 → claude 进程随 PTY 关闭即死、
// 文件停止写入，此后最长 5 分钟列表仍显示「进行中」——且 active=true 时前端
// 「恢复」被禁（防 fork 双写），用户关闭终端后想立刻恢复会话反被挡住。
//
// 校正三档（列表端点实时执行，claudesessions 包保持纯扫描语义不感知终端）：
//  1. 精确关联（活终端注册表）：活终端 meta.Runtime=claude 且 InitialPrompt
//     带 `--resume <id>` → 该 transcript 会话活跃（与 mtime 无关——长思考无
//     追加也不再误判非活跃，双端零误判）
//  2. 持久关联（claudeassoc kind）：Codecombo 曾以 --resume 拉起过该会话（拉
//     起时刻落库）且关联终端 id 已不在活终端清单 → claude 进程已死（终端关闭
//     即杀），立即翻非活跃（零延迟）。活终端 id 对账（而非仅 meta 挂载对账）
//     是防误翻的底线：关联落库（launch 漏斗同步）早于 meta 落库（异步毫秒窗），
//     活终端 + meta 缺席的窗口里仅凭「无精确挂载」翻非活跃，会把正在写入的
//     会话判成可恢复（比它替代的 mtime 启发式更糟）。外部写入者盲区（另一
//     实例/外部 claude 正续写同一 transcript）如实存在：注册表只感知本实例，
//     启发式保护本就不覆盖它
//  3. mtime 窄档：既无精确关联、目录又无任何活 claude 终端（原生启动的世界）
//     → 窗口从 5min 收敛到 90s——僵尸窗口压到 1.5 分钟。误判率权衡：原生
//     claude 纯 thinking 超 90s 无追加会短暂显「可恢复」，双 fork 风险窗口
//     由「用户恰好此刻手动恢复」的小概率承接（提案定调：按误判率权衡收敛）；
//     目录内有活 claude 终端时保持 5min 宽档（无法归属 transcript 时宁可
//     保守——新起的 Codecombo claude 会话写哪个文件服务端不可预知）
//
// claudeassoc kind（server/store/claudeassoc.go，车道 1）：不在活注册表时
// 区分「Codecombo 拉起过、终端已关」与「从未经 Codecombo」的唯一凭据——
// agentsessionmeta 键=终端 ID 且关闭即删（DeleteTerminal/pruneStaleSessionMeta），
// 恰在需要的时刻消失；本 kind 键=transcript UUID，随恢复链 upsert、列表时
// 对死关联超 TTL 尽力 GC。

// claudeActiveWindowNarrow 原生会话（无任何注册表关联）的活跃窗口窄档：
// 90s 覆盖「关终端后的残留写入 + 常规轮询间隔」，僵尸「进行中」从最长 5min
// 压到 1.5min；按提案口径的误判率权衡取值
const claudeActiveWindowNarrow = 90 * time.Second

// claudeAssocTTL 关联条目 GC 时效：终端已死且拉起时刻超此窗的关联不再参与
// 判定（此时 transcript 要么已删、要么早凉透——再恢复会经恢复链重新 upsert），
// 列表校正顺带尽力删除。稳态存量 = 近 30 天被恢复过的会话数
const claudeAssocTTL = 30 * 24 * time.Hour

// resumeIDPattern 从 launchArgs / meta.InitialPrompt 提取 claude 恢复目标：
// `--resume <uuid>` 与 `-r <uuid>`（含 = 连接形态）。id 取 UUID 形态下界
// （8+ 位 hex/连字符），拒绝任意 token 误挂关联
var resumeIDPattern = regexp.MustCompile(`(?:^|\s)--?resume[=\s]+([0-9a-fA-F][0-9a-fA-F-]{7,63})\b|(?:^|\s)-r[=\s]+([0-9a-fA-F][0-9a-fA-F-]{7,63})\b`)

// parseResumeSessionID 从 launchArgs 文本提取 --resume/-r 的目标会话 id。
// 旗标形态的 launchArgs 由 Codecombo 恢复链注入（`--resume <id>` 原文随
// meta.InitialPrompt 落库），匹配不到返回空串（无关联语义）
func parseResumeSessionID(launchArgs string) string {
	m := resumeIDPattern.FindStringSubmatch(launchArgs)
	if m == nil {
		return ""
	}
	if m[1] != "" {
		return strings.ToLower(m[1])
	}
	return strings.ToLower(m[2])
}

// claudeActiveRegistry 一次列表请求的终端注册表快照：活终端维度的精确关联
type claudeActiveRegistry struct {
	// liveTerminalIDs 本实例全部活终端 id（不限 runtime）——档 2 的对账底线：
	// 关联终端仍在册（meta 缺席窗/落库失败）时不翻非活跃，mtime 启发式兜底
	liveTerminalIDs map[string]bool
	// liveResume claude transcript 会话 UUID → 挂载它的活终端 id
	liveResume map[string]string
	// liveClaudeDirs 有活 claude 终端的工作目录（归一化小写）——目录内会话
	// 的归属不可知时保持宽档判定
	liveClaudeDirs map[string]bool
}

// terminalSessionsLister 活终端清单取数口（变量化供测试注入，precheckRuntimeFn
// 先例）：生产绑定终端管理器，测试 stub 免起真实 PTY
var terminalSessionsLister = func() []*terminal.Session { return terminal.DefaultManager.ListSessions() }

// buildClaudeActiveRegistry 从活终端会话 + 其元数据装配注册表。meta 读失败/
// 缺席（创建链异步落库的毫秒窗）只降级该会话的精确关联，目录宽档仍按
// Runtime 判出的部分生效；终端管理器不可用返回空注册表（全量走 mtime 启发式）
func buildClaudeActiveRegistry() *claudeActiveRegistry {
	reg := &claudeActiveRegistry{
		liveTerminalIDs: map[string]bool{},
		liveResume:      map[string]string{},
		liveClaudeDirs:  map[string]bool{},
	}
	sessions := terminalSessionsLister()
	if len(sessions) == 0 {
		return reg
	}
	metas := map[string]*store.AgentSessionMeta{}
	if list, err := store.Get().AgentSession.List(); err == nil {
		for i := range list {
			metas[list[i].ID] = &list[i]
		}
	}
	for _, s := range sessions {
		// 活终端 id 全量在册（先于 meta/runtime 过滤）：档 2 对账底线——
		// meta 缺席窗内终端同样「活着」，漏记会误翻正在写入的会话
		reg.liveTerminalIDs[s.ID] = true
		meta := metas[s.ID]
		if meta == nil || meta.Runtime != "claude" {
			continue
		}
		reg.liveClaudeDirs[normalizeClaudeDir(s.Path)] = true
		if id := parseResumeSessionID(meta.InitialPrompt); id != "" {
			// 键统一小写（parseResumeSessionID 归一形态）：transcript 文件名
			// 理论上可带大写，判定键大小写折叠防 legacy id 大小写漂移漏挂
			reg.liveResume[id] = s.ID
		}
	}
	return reg
}

// normalizeClaudeDir 目录归一化（map 键用）：Clean 统一分隔符与尾分隔符形态；
// 大小写折叠仅 Windows——盘符路径大小写不敏感语义下 D:\x 与 d:\x 是同一目录
// （与 lockedProjectForDir 的锁定判定同款取向：关联判定宁可保守），Linux/mac
// 大小写敏感，折叠会错误合并两个真实存在的不同目录。比较双方（终端会话 Path
// 与 transcript Cwd）同源于本机文件系统，平台语义恒一致
func normalizeClaudeDir(p string) string {
	if p == "" {
		return ""
	}
	cleaned := filepath.Clean(p)
	if runtime.GOOS == "windows" {
		cleaned = strings.ToLower(cleaned)
	}
	return cleaned
}

// loadClaudeAssocs 取持久关联表（root 全量，条目量级 = 近期恢复过的会话数），
// **按会话 id 重键**（repo 层 GetBatch 以文档键为键，直接透传会让按 id 的
// 查找全部落空——FetchCuration 同款纪律）；读失败返回 nil（降级为「无持久
// 关联」，mtime 启发式兜底）
func loadClaudeAssocs(root string) map[string]store.ClaudeSessionAssoc {
	if root == "" {
		return nil
	}
	m, err := store.Get().ClaudeAssoc.GetBatch(store.ClaudeAssocPrefix(root))
	if err != nil {
		return nil
	}
	out := make(map[string]store.ClaudeSessionAssoc, len(m))
	for _, a := range m {
		out[strings.ToLower(a.ID)] = a
	}
	return out
}

// applyClaudeActiveCorrection 就地校正会话行的 Active（三档判定见文件头）。
// GC：整表扫死关联（含 transcript 已删、行已不存在的孤儿条目）超 TTL 尽力
// 删除——活终端挂载中的关联豁免（删了会在终端关闭后退化到窄档判定）；
// 失败留待下轮，不阻断列表
func applyClaudeActiveCorrection(rows []claudesessions.Session, reg *claudeActiveRegistry, assocs map[string]store.ClaudeSessionAssoc, now time.Time) {
	if len(assocs) > 0 {
		for _, a := range assocs {
			if now.Sub(a.LaunchedAt) > claudeAssocTTL {
				// 键统一小写（liveResume 同款折叠）：防 legacy 大写 id 漏豁免
				if _, live := reg.liveResume[strings.ToLower(a.ID)]; !live {
					_ = store.Get().ClaudeAssoc.Delete(a.Key)
					delete(assocs, a.ID)
				}
			}
		}
	}
	for i := range rows {
		s := &rows[i]
		rowID := strings.ToLower(s.ID)
		if _, live := reg.liveResume[rowID]; live {
			s.Active = true // 档 1：活终端精确挂载（覆盖 mtime 的双向误判）
			continue
		}
		if a, managed := assocs[rowID]; managed {
			if _, live := reg.liveTerminalIDs[a.TerminalID]; !live {
				// 档 2：Codecombo 拉起过、关联终端已不在活终端清单 → 进程已死，
				// 立即失活。终端 id 仍活（meta 缺席窗/落库失败的关联未更新态）
				// 不翻——mtime 启发式兜底，宁保守勿误翻活会话
				s.Active = false
				continue
			}
		}
		if s.Active && !reg.liveClaudeDirs[normalizeClaudeDir(s.Cwd)] {
			// 档 3：原生会话 + 目录无活 claude 终端 → 窄档收敛（mtime 已由
			// 扫描层按 5min 宽档判 true，此处按 90s 复核收紧）
			if time.Since(s.LastAt) > claudeActiveWindowNarrow {
				s.Active = false
			}
		}
	}
}

// recordClaudeResumeAssoc 恢复链拉起成功后落持久关联（launch 唯一漏斗
// LaunchAgentSessionWithShell 调用）。写失败只降级为启发式判定（日志留痕，
// 不阻断建会话主链路）
func recordClaudeResumeAssoc(claudeSessionID, terminalID string) {
	if claudeSessionID == "" || terminalID == "" {
		return
	}
	root := claudesessions.Root()
	if root == "" {
		return
	}
	err := store.Get().ClaudeAssoc.Put(store.ClaudeSessionAssoc{
		Key:        store.ClaudeAssocKey(root, claudeSessionID),
		ID:         claudeSessionID,
		TerminalID: terminalID,
		LaunchedAt: time.Now(),
	})
	if err != nil {
		slog.Warn("claude assoc record failed", "sessionId", claudeSessionID, "err", err)
	}
}
