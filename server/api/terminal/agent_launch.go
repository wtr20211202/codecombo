package terminal

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"codecombo/server/agentops"
	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// agent 会话创建链（P-20261007-22 纯搬运自 terminal.go，零逻辑改动）：
// LaunchAgentSessionWithShell 是全部创建路（HTTP/定时任务/链式/编队/运行书）
// 的唯一漏斗——运行时选型、创建前预检、会话级 shell 覆盖、元数据落库；
// createAgentTerminal/agentLaunchResponse 是其 HTTP 形态，resolveAgentLaunch
// 为选型纯函数，saveAgentSessionMeta/execGitHead 是产出基线落库助手

// agentRuntimeShell 纯终端运行时（一等选项）：不做 Agent 选型，
// 会话 launch 为空 = PTY 起普通 shell 不注入命令
const agentRuntimeShell = "shell"

// AgentLaunch 无 HTTP 语义的 agent 会话创建结果：HTTP handler 响应体与
// agentcron 调度器触发链共用同一快照结构
type AgentLaunch struct {
	ID        string
	Name      string
	Path      string
	CreatedAt time.Time
	Runtime   string
	// RuntimeVersion 预检顺取的 --version 输出首行（P-20261003-134）；豁免链
	//（shell / 自定义命令 / 未注册名回落）无探测为空串
	RuntimeVersion string
	Launched       bool
	// Shell 会话实际启动的 shell（P-20261004-57）：纯终端形态解析会话覆盖/
	// 设置/平台缺省后的落点；运行时会话同有底层 PTY shell，同为该解析值
	Shell string
	// Derived/Resumed 身份标记（P-20261023-3）：名字为系统派生 / 会话由恢复
	// 旗标创建。创建响应同步携带（meta 落库异步，紧随的快照广播可能反查不到
	// ——initialPrompt 同款响应先行语义），前端「新/接续」徽标免竞态窗口
	Derived bool
	Resumed bool
}

// precheckRuntimeFn 创建前预检执行体（变量化供测试注入；生产绑定
// agentops.PrecheckRuntime）。第二返回值 = 预检同一子进程顺取的版本首行
// （P-20261003-134 会话 runtime 版本快照），失败/豁免时空串
var precheckRuntimeFn = agentops.PrecheckRuntime

// targetPrecheckName 选型前预检目标（P-20261003-79）：请求**显式指定**的运行时
// 才做——点名 claude 却被静默换成 codex / 会话起来即死，都属于「用户不知因」，
// 明确失败（HTTP 400 带运行时名）优于静默换人。空串返回 = 无预检目标：
//   - "" / "auto" / "shell"：auto 链由选型后补检兜底；shell 是一等纯终端选项
//   - 未注册名：选型必回落 auto，同上
//   - 配了 per-runtime 自定义启动命令：「原样启动」承诺（与 resolveAgentLaunch
//     可用性门控同一豁免口径——自定义命令的典型场景恰是探测覆盖不到的位置）
func targetPrecheckName(reqRuntime string, launchCommands map[string]string) string {
	if reqRuntime == "" || reqRuntime == "auto" || reqRuntime == agentRuntimeShell {
		return ""
	}
	if !agentops.IsRegisteredProvider(reqRuntime) {
		return ""
	}
	if strings.TrimSpace(launchCommands[reqRuntime]) != "" {
		return ""
	}
	return reqRuntime
}

// autoPrecheckName 选型后补检目标：auto 链（显式 auto / 设置默认 / 未注册名
// 回落）实际选定的运行时——Available 只答「在不在」，损坏安装（--version
// 都跑不起来）照样放行，表现为会话起来即死/黑屏。设置默认（reqRuntime 空）
// 不做选型前预检：沿用「用户配置先于环境消失的运行时仍可正常使用」的回落
// 语义（resolve_agent_launch_test.go 锚定），健康度改由本补检对实际选定者
// 把关。prechecked = 选型前已预检过的目标（健康 ⇒ Available 必真 ⇒ 选型必
// 返回同名），命中即跳过——一次创建至多起一次 --version 子进程
func autoPrecheckName(runtimeName, prechecked string, launchCommands map[string]string) string {
	if runtimeName == "" || runtimeName == agentRuntimeShell || runtimeName == prechecked {
		return ""
	}
	if strings.TrimSpace(launchCommands[runtimeName]) != "" {
		return "" // 自定义命令覆盖：原样启动承诺，豁免
	}
	return runtimeName
}

// LaunchAgentSession agent 会话创建核心（createAgentTerminal 的 HTTP 无关部分，
// 供定时任务调度器等无请求上下文的调用方复用）：
//   - 运行时选型：显式选择优先，空值回落设置默认（settings.agentProvider），
//     两者皆为空/"auto" 时按可用性选型；"shell" 为一等选项 = 纯终端会话；
//     选型失败 → 降级纯 shell 会话（launched=false），不视为错误
//   - 创建前预检（P-20261003-79）：显式目标运行时选型前体检二进制（缺失/
//     损坏 → PrecheckError，HTTP 侧 400），auto 链对实际选定者补检（豁免
//     口径见 targetPrecheckName / autoPrecheckName / agentops.PrecheckRuntime）
//   - name 为空时走 prompt 摘要名/槽位名继承/序号默认名（见
//     resolveAgentSessionName；lang 为 Accept-Language 头值，
//     无请求上下文传空 = 英文默认）
//
// 目录不存在等创建失败返回 error（调用方负责对 HTTP/调度两条链各自的呈现）。
// launchArgs 上限校验留在 HTTP handler（API 契约）；内部调用方自证长度合规
func LaunchAgentSession(name, reqRuntime, dir, launchArgs, lang string, opts ...LaunchOption) (*AgentLaunch, error) {
	return LaunchAgentSessionWithShell(name, reqRuntime, dir, launchArgs, lang, "", opts...)
}

// launchMetaExtra 会话创建的可选元数据扩展集（LaunchOption 的装配目标）：
// 仅编队链携带 fleetBatch，零值 = 既有行为
type launchMetaExtra struct {
	fleetBatch *store.FleetBatch
	// dedupName 显式名也参与同名消歧（P-20261023-3）：内部创建链（定时任务/
	// 链式接续/编队/运行书）的显式名与派生名同口径步进「·2/·3」；HTTP 用户
	// 显式名不参与——显式命名是用户意图不静默改写，重名感知走 rename 端点的
	// duplicate 警示载荷（同名不阻断的既有语义不变）
	dedupName bool
	// derived/resumed 创建时点判定的身份标记（P-20261023-3）：名字来自系统
	// 派生链（prompt 摘要/槽位继承/序号默认名）/ launchArgs 为旗标形态
	//（--resume 等恢复链）——随 meta 落库，侧栏「新/接续」徽标的数据面
	derived bool
	resumed bool
}

// LaunchOption 会话创建可选扩展（变参保持既有调用方零改动——编队链是唯一
// 消费方，不为它改全量调用点签名）
type LaunchOption func(*launchMetaExtra)

// WithFleetBatch 编队批元数据随会话创建落库（P-20261005-145）：batchId/
// 发起时间/成员花名册进会话元数据（?fleet= 过滤与值班聚合卡的数据面）
func WithFleetBatch(b store.FleetBatch) LaunchOption {
	return func(e *launchMetaExtra) { e.fleetBatch = &b }
}

// WithDisplayNameDedup 显式名参与同名消歧（P-20261023-3）：定时任务等内部
// 创建链的显式名撞上存量会话名时自动步进后缀（同任务重复调度不再产出雷同
// 名）。派生名（调用方未命名）恒参与消歧，无需本选项
func WithDisplayNameDedup() LaunchOption {
	return func(e *launchMetaExtra) { e.dedupName = true }
}

// LaunchAgentSessionWithShell LaunchAgentSession 的会话级 shell 覆盖形态
// （P-20261004-57）：shellOverride 仅在最终形态为纯终端时生效（runtime 解析为
// "shell"，或选型失败降级纯 shell——降级产物本就是纯终端，覆盖语义一致）；
// claude/codex/dsh 等运行时会话忽略（运行时自管启动 shell）。调度链
// （agentcron/agentchain）走 LaunchAgentSession 传空 = 跟随设置
func LaunchAgentSessionWithShell(name, reqRuntime, dir, launchArgs, lang, shellOverride string, opts ...LaunchOption) (*AgentLaunch, error) {
	var extra launchMetaExtra
	for _, opt := range opts {
		if opt != nil {
			opt(&extra)
		}
	}
	runtime := reqRuntime
	if runtime == "" {
		if cfg := store.Get().Settings.Get(); cfg != nil {
			runtime = cfg.Server.AgentProvider
		}
	}
	launchArgs = strings.TrimSpace(launchArgs)

	// 命名系统注记注入（P-20261023-3）：带初始 prompt 创建时在 prompt 尾部
	// 附一行系统注记（会话寻址 + 任务演化改名指令，设置可关默认开）——名字
	// 创建时一次定死、任务演化后失真的补位（改名的驱动力从「手册被动提示 +
	// 指望自觉」升级为每次会话随行）。注记落尾部不毁 promptSessionName 首行
	// 派生；meta.InitialPrompt 存原文（注释记），「重新发起」预填干净、创建链
	// 重注入不叠加。跳过口径（旗标/纯 shell）见 withAgentNamingNote
	initialPromptRecord := launchArgs
	extra.resumed = flagFormLaunchArgs(launchArgs)
	noteEnabled := false
	if cfg := store.Get().Settings.Get(); cfg != nil {
		noteEnabled = cfg.Server.AgentNamingNoteEnabledOrDefault()
	}
	if next, injected := withAgentNamingNote(launchArgs, noteEnabled, runtime == agentRuntimeShell, lang); injected {
		launchArgs = next
	}

	var launchCommands map[string]string
	if cfg := store.Get().Settings.Get(); cfg != nil {
		launchCommands = cfg.Server.AgentLaunchCommands
	}

	// 创建前预检第一段（P-20261003-79）：显式目标运行时在选型前体检二进制，
	// 缺失/损坏 → PrecheckError（HTTP 侧 400 明确报错），不给静默回落机会。
	// 顺取语义（P-20261003-134）：健康结论随同一次 --version 子进程带回版本
	// 首行，落 meta.RuntimeVersion——回放/审计知道「这条会话是 claude X.Y 跑的」，
	// 不另起独立探测请求
	prechecked := ""
	runtimeVersion := ""
	if n := targetPrecheckName(reqRuntime, launchCommands); n != "" {
		v, err := precheckRuntimeFn(n)
		if err != nil {
			return nil, err
		}
		prechecked = n
		runtimeVersion = v
	}

	runtimeName, launch, launched := resolveAgentLaunch(runtime, launchArgs, launchCommands, agentops.InteractiveLaunchCommand)

	// 创建前预检第二段：auto 链对实际选定的运行时补检（官方命令路径才检，
	// 豁免口径见 autoPrecheckName；launched=false = 选型失败降级纯 shell，无从检起）
	if launched {
		if n := autoPrecheckName(runtimeName, prechecked, launchCommands); n != "" {
			v, err := precheckRuntimeFn(n)
			if err != nil {
				return nil, err
			}
			runtimeVersion = v
		}
	}

	// 同名消歧（P-20261023-3）：派生名（调用方未命名，含 prompt 摘要/槽位
	// 继承/序号默认名）恒查重；内部创建链显式名经 WithDisplayNameDedup 参与；
	// HTTP 用户显式名不步进（意图保留，重名感知走 rename 端点 duplicate 警示）。
	// 步进发生在 promptSessionName 截断（先截断后去重）之后——后缀叠加在
	// 「24 rune+省略号」上，边界不因消歧抖动
	unnamed := strings.TrimSpace(name) == ""
	name = resolveAgentSessionName(name, launchArgs, runtimeName, dir, lang)
	if unnamed || extra.dedupName {
		name = dedupeAgentSessionName(name, liveAgentSessionNames())
	}
	// 身份标记：derived = 调用方未显式命名（名字来自系统派生链）；resumed 已
	// 在注入段判定。随 AgentLaunch 快照回传（创建响应先行）与 meta 落库
	extra.derived = unnamed

	// 会话级 shell 覆盖（P-20261004-57）：仅纯终端形态生效（见函数头注记）。
	// 空值 = 跟随设置 terminal.defaultShell / 平台缺省（manager 侧统一解析）
	effectiveShell := ""
	if !launched || runtimeName == agentRuntimeShell {
		effectiveShell = shellOverride
	}

	id := fmt.Sprintf("agent-%d", time.Now().UnixNano())
	session, err := terminal.DefaultManager.CreateAgentSessionWithShell(id, name, dir, launch, effectiveShell)
	if err != nil {
		return nil, err
	}
	slog.Info("agent terminal created", "id", session.ID, "runtime", runtimeName,
		"requested", runtime, "launched", launched, "backend", session.Backend)

	// 长会话正常完成提醒（P-20261002-140）：仅真实拉起过运行时的会话注册
	//（纯 shell 一等选项 / 选型降级不打扰）；智能体已上报终态的会话在钩子内
	// 与 P-15 完成链去重。HTTP 创建与 agentcron 调度两条链共用本注册点
	if launched && runtimeName != agentRuntimeShell {
		registerLongSessionExitHook(session, runtimeName, launched)
	}

	// Claude 恢复关联落库（P-20261031-1）：claude 运行时 + --resume 旗标形态
	// 时把 transcript 会话 id ↔ 终端会话关联进 claudeassoc kind——列表端点
	// Active 判定从 mtime 启发式升级为终端存活精确事实的数据面（判定语义见
	// claude_sessions_active.go）。同步写：写失败只降级启发式判定，量级一次
	// 小文档 upsert，冷路径无谓异步
	if launched && runtimeName == "claude" {
		if rid := parseResumeSessionID(launchArgs); rid != "" {
			recordClaudeResumeAssoc(rid, session.ID)
		}
	}

	// 产出视图元数据（B3）：记录创建时刻的 HEAD——产出 = git diff startHead..工作区，
	// 确定性归属。非 git 目录 / rev-parse 失败仅留空（产出页签给引导文案），不阻断建会话。
	// initialPrompt（P-20261003-146）：launchArgs 原文随 meta 落库——「重新发起」
	// 的数据面。此处是 agent 会话创建唯一漏斗（HTTP/调度/链式/对比/编队/运行书
	// 全部经本函数），写一次即全路覆盖；空注入落零值不落键。
	// 编队链（P-20261005-145）同步落库批身份（batchId+发起时间，花名册由
	// BulkCreateAgentTerminals 循环后回填——成员 id 此刻不可预知）：Bulk 的
	// 建会话广播紧随本函数返回，异步落库会让首屏快照 meta 反查缺 fleetBatch
	// 键（值班聚合卡「发起后即看」是本提案核心承诺）；编队发起是显式低频动作，
	// 同步一次 git rev-parse（~10ms 级）在批量链秒级总耗时里可忽略。非编队链
	// 保持异步不阻断（既有语义）
	if extra.fleetBatch != nil {
		saveAgentSessionMeta(session.ID, session.Path, runtimeName, session.Name, "", runtimeVersion, initialPromptRecord, extra)
	} else {
		go saveAgentSessionMeta(session.ID, session.Path, runtimeName, session.Name, "", runtimeVersion, initialPromptRecord, extra)
	}

	return &AgentLaunch{
		ID:             session.ID,
		Name:           session.Name,
		Path:           session.Path,
		CreatedAt:      session.CreatedAt,
		Runtime:        runtimeName,
		RuntimeVersion: runtimeVersion,
		Launched:       launched,
		Shell:          session.ShellPath(),
		Derived:        extra.derived,
		Resumed:        extra.resumed,
	}, nil
}

// lockedProjectForDir agent 会话目录命中的硬锁项目（P-20261004-3）：
// dir 为空 / 不在任何 locked 项目路径内返回 nil。包含判定 filepath.Rel
// 边界 + 大小写折叠——Windows/macOS 不敏感盘语义下不同大小写仍是同一目录
// （与 AddProject 重复检测 normalizeDirPath 同款取向：锁定场景宁可误拒）。
// 项目数 O(n) 遍历仅发生在建会话时，非热路径。
func lockedProjectForDir(dir string) *config.ProjectConfig {
	if strings.TrimSpace(dir) == "" {
		return nil
	}
	projects, err := store.Get().Project.List()
	if err != nil {
		return nil
	}
	target, err := filepath.Abs(filepath.Clean(dir))
	if err != nil {
		return nil
	}
	targetN := strings.ToLower(target)
	for i := range projects {
		p := &projects[i]
		if !p.Locked {
			continue
		}
		base, err := filepath.Abs(filepath.Clean(p.Path))
		if err != nil {
			continue
		}
		if real, e := filepath.EvalSymlinks(base); e == nil {
			base = real
		}
		rel, err := filepath.Rel(strings.ToLower(base), targetN)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		return p
	}
	return nil
}

// createAgentTerminal 全局终端创建分支：
//   - 运行时选型：请求显式选择优先，空值回落设置默认（settings.agentProvider），
//     两者皆为空/"auto" 时按可用性选型；"shell" 为一等选项 = 纯终端会话
//     （launch 为空，PTY 起普通 shell，不注入任何命令）；选型失败（环境内无
//     任何 Agent CLI）→ 降级为纯 shell 会话并如实告知，用户仍可在该终端手动
//     安装/运行其他程序。选型细节见 resolveAgentLaunch
//   - 启动命令：默认取运行时官方命令（Provider.InteractiveCommand，服务端常量）；
//     settings.agentLaunchCommands[运行时名] 非空时覆盖（用户自定义，经 PTY
//     注入 shell 执行，与手敲等价）；显式指定运行时 + 配了自定义命令时跳过
//     可用性门控（与前端「探测不可用不禁用」口径一致，见 resolveAgentLaunch）
//   - tmux 后端下会话随服务重启存活（恢复逻辑按哨兵哈希归类为 agent）
//   - dir 非空 = 会话工作目录（worktree 隔离 / Claude 会话恢复场景）；
//     launchArgs 非空 = 追加在运行时命令后的参数（--resume <id>），上限 500 字符
//   - shell 非空 = 会话级 shell 覆盖（P-20261004-57，仅纯终端形态生效，
//     见 LaunchAgentSessionWithShell；handler 已做 LookPath 400 校验）
func createAgentTerminal(c *gin.Context, name, reqRuntime, dir, launchArgs, shell string) {
	launchArgs = strings.TrimSpace(launchArgs)
	if len(launchArgs) > 500 {
		shared.Error(c, http.StatusBadRequest, "launchArgs too long", fmt.Errorf("max 500 chars"))
		return
	}
	res, err := LaunchAgentSessionWithShell(name, reqRuntime, dir, launchArgs, c.GetHeader("Accept-Language"), shell)
	if err != nil {
		var preErr *agentops.PrecheckError
		if errors.As(err, &preErr) {
			// 预检失败是用户环境问题（400 可行动），非服务端故障（500）。
			// publicMsg 直接用稳定标记原文：生产模式响应 body 取 publicMsg，
			// 前端 KNOWN_ERROR_I18N 按该原文映射双语（对外契约，改文案须两侧同步）
			shared.Error(c, http.StatusBadRequest, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": agentLaunchResponse(res, launchArgs)})
	broadcastTerminalsChanged()
}

// agentLaunchResponse agent 会话创建响应 data 段（createAgentTerminal 专用）：
// initialPrompt（P-20261003-146）仅非空携键——与快照「缺 key = 无记录」契约
// 同形（空注入不虚构空串），前端按缺省处理
func agentLaunchResponse(res *AgentLaunch, launchArgs string) gin.H {
	data := gin.H{
		"id":        res.ID,
		"name":      res.Name,
		"projectId": "",
		"path":      res.Path,
		"createdAt": res.CreatedAt,
		"kind":      terminal.KindAgent,
		"runtime":   res.Runtime,
		// 创建响应同步携带（P-20261003-134）：meta 落库是异步 goroutine，
		// 紧随其后的 terminals.changed 快照可能反查不到——响应先行，快照
		// 兜底持久面（sessionSnapshot 反查 meta）
		"runtimeVersion": res.RuntimeVersion,
		"launched":       res.Launched,
		// 实际启动的 shell（P-20261004-57）：会话覆盖/设置/平台缺省解析后的
		// 落点。增量观测字段，旧前端忽略无影响
		"shell": res.Shell,
		// 创建后权威总数（P-20261003-183）：与项目终端创建响应同款，前端
		// 越软阈值轻提示用。增量字段，旧前端忽略无影响
		"totalSessions": len(terminal.DefaultManager.ListSessions()),
	}
	if launchArgs != "" {
		// 初始指令同款响应先行（P-20261003-146）：创建后立刻「重新发起」
		// 不吃异步落库竞态窗口
		data["initialPrompt"] = launchArgs
	}
	// 身份标记（P-20261023-3）：仅置位携键（缺 key = false），与快照契约同形
	//——「新/接续」徽标在创建后首屏即可判，不等异步 meta 落库
	if res.Derived {
		data["derived"] = true
	}
	if res.Resumed {
		data["resumed"] = true
	}
	return data
}

// launchSelector 运行时选型函数签名（生产传 agentops.InteractiveLaunchCommand，
// 测试注入桩）
type launchSelector = func(providerName string) (runtimeName, command string, ok bool)

// resolveAgentLaunch 智能体终端的启动选型（纯函数，便于单测）。
//
// 优先级：
//  1. "shell" 一等选项：纯终端会话，不注入命令
//  2. 显式指定运行时 + 配了自定义启动命令（agentLaunchCommands[运行时名]）→
//     跳过可用性门控按原样启动。自定义命令的典型场景恰是 CLI 装在探测覆盖
//     不到的位置（包装脚本绝对路径/非标准安装位置/npx 形态），此时 Available
//     说了不算；前端对话框对探测不可用的运行时同样不禁用、只加「(不可用)」
//     提示并承诺「服务端按用户命令原样启动」——两端口径必须一致，否则
//     「配命令自救」的路径被服务端堵死（显式名经 IsRegisteredProvider 校验，
//     不吃任意输入）
//  3. 选型（显式名探测可用，或 auto 按可用性挑）：官方命令起步；auto 选出的
//     实际运行时若配了自定义命令则同样覆盖
//
// 返回 (runtimeName, launch, launched)；launched=false = 选型失败 → 调用方
// 降级纯 shell 会话
func resolveAgentLaunch(runtime, launchArgs string, launchCommands map[string]string, selectFn launchSelector) (string, string, bool) {
	if runtime == agentRuntimeShell {
		return agentRuntimeShell, launchArgs, true
	}
	// 显式名 + 自定义命令：跳过可用性门控（"auto" 无显式名不参与；未注册名
	// 不读映射，防任意键值注入）
	if runtime != "" && runtime != "auto" && agentops.IsRegisteredProvider(runtime) {
		if custom := strings.TrimSpace(launchCommands[runtime]); custom != "" {
			out := custom
			if launchArgs != "" {
				out = out + " " + launchArgs
			}
			return runtime, out, true
		}
	}
	rt, cmd, ok := selectFn(runtime)
	if !ok {
		return "", "", false
	}
	// auto 选出的实际运行时若配了自定义命令则同样覆盖（显式名已在上面覆盖过）
	if custom := strings.TrimSpace(launchCommands[rt]); custom != "" {
		cmd = custom
	}
	if launchArgs != "" {
		cmd = cmd + " " + launchArgs
	}
	return rt, cmd, true
}

// saveAgentSessionMeta 异步落会话元数据（StartHead 失败留空不阻断建会话主链路）。
// Name 一并落库：tmux 会话重启恢复时还原显示名；native 会话的命名作为槽位
// 继承源（重启后新建会话回填，见 inheritDisplayName）。
// projectID：项目会话归属（槽位继承反查键；agent 会话传空）。
// runtimeVersion：创建预检顺取的 --version 输出首行（P-20261003-134），豁免链
// 传空——留空即「无记录」，展示端空显不虚构。
// initialPrompt：创建时注入的 launchArgs 原文（P-20261003-146，「重新发起」
// 预填的数据面）。写入点唯一在 LaunchAgentSessionWithShell——HTTP 建会话、
// 定时任务/链式接续/双开对比/编队/运行书全部经它漏斗，天然全路覆盖；
// 重启恢复回补的老会话（recover.go）与项目会话传空 = 无记录。
//
//	注：P-20261023-3 起传注入注记拼装**前**的原文——注记是创建链随行物，
//	「重新发起」预填不应携带（创建链会重新注入，存注记则逐代叠加）。
//
// extra：创建链身份扩展（fleetBatch / derived / resumed，P-20261023-3）。
// 已落库的用户命名优先：本函数可能同步执行（编队链）也可能异步执行（其余链），
// 用户创建后立即改名时 rename 的 upsert 先到，不得用创建默认名覆盖其 Named 状态。
// 敏感标记（P-20261003-155）同款保留：创建后立即标记（本提案 e2e repeat
// 实测抓到的竞态——异步落库晚于标记会把 sensitive 打回 false，出域闸门
// 失明），人工策展值一旦写入不被创建链覆盖
func saveAgentSessionMeta(sessionID, dir, runtime, name, projectID, runtimeVersion, initialPrompt string, extra launchMetaExtra) {
	meta := store.AgentSessionMeta{
		ID:             sessionID,
		Dir:            dir,
		Runtime:        runtime,
		RuntimeVersion: runtimeVersion,
		InitialPrompt:  initialPrompt,
		Name:           name,
		ProjectID:      projectID,
		FleetBatch:     extra.fleetBatch,
		Derived:        extra.derived,
		Resumed:        extra.resumed,
		CreatedAt:      time.Now(),
	}
	if dir != "" {
		if head, err := execGitHead(dir); err == nil {
			meta.StartHead = head
		}
	}
	if old, err := store.Get().AgentSession.Get(sessionID); err == nil && old != nil {
		if old.Named && old.Name != "" {
			meta.Name = old.Name
			meta.Named = true
			meta.NamedAt = old.NamedAt
		}
		if old.Sensitive {
			meta.Sensitive = true
		}
	}
	if err := store.Get().AgentSession.Save(meta); err != nil {
		slog.Warn("agent session meta save failed", "id", sessionID, "err", err)
	}
}

// execGitHead 取目录的 HEAD（非 git 仓库返回错误）
func execGitHead(dir string) (string, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return "", fmt.Errorf("git not available")
	}
	cmd := exec.Command("git", "-C", dir, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
