package terminal

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codecombo/server/api/files"
	shared "codecombo/server/api/shared"
	mw "codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 终端会话 CRUD HTTP 面（P-20261007-22 纯搬运重组，零逻辑改动）：创建/列表/
// 关闭/改名/resize/redraw 端点与 tmux 安装查询面；agent 创建链、命名系统、
// 产出视图、WS attach、运行时清单、快照广播、通知装配各入子域专用文件
// （session_snapshot/notify_hooks/runtime_inventory/agent_launch/agent_naming/
// activity/ws_attach），本文件只留会话 CRUD 主链与其就近助手

// errDirTraversal 目录级终端的越界哨兵：与 files 域守卫（SafeJoinProject 的
// errTraversal）同文——"path traversal not allowed" 是 P-29 errmarkers 登记
// 的稳定原文（前端 KNOWN_ERROR_I18N 按原文映射 errors.known.invalidPath），
// 改文案须两侧同步
var errDirTraversal = errors.New("path traversal not allowed")

// resolveSessionWorkDir 目录级终端（P-20261005-192）工作目录解析：
//   - dir 空 = 项目根（既有行为零变化）
//   - 相对路径 = 项目根相对（文件树/面包屑入口的标准形态）
//   - 绝对路径折算为项目根相对后再过守卫（跨盘符等不可折算形态按越界拒绝）
//
// 守卫复用 files.SafeJoinProject 单一事实源（".." 显式拒绝 + Abs 规范化 + 真实
// 路径与规范化路径的双重「根+分隔符」前缀校验——兄弟目录前缀伪装与符号链接
// 外逃均被拦截，与下载/预览端点同标准）；通过后还须存在且为目录。
// 错误即 400 稳定原文：越界 "path traversal not allowed" / 缺失或非目录
// "path does not exist or is not a directory"（项目注册同文，前端同映射）
func resolveSessionWorkDir(root, dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return root, nil
	}
	if filepath.IsAbs(dir) {
		rel, err := filepath.Rel(root, dir)
		if err != nil {
			return "", errDirTraversal
		}
		dir = filepath.ToSlash(rel)
	}
	absDir, err := files.SafeJoinProject(root, dir)
	if err != nil {
		return "", errDirTraversal
	}
	info, err := os.Stat(absDir)
	if err != nil || !info.IsDir() {
		return "", errors.New("path does not exist or is not a directory")
	}
	return absDir, nil
}

// CreateTerminal 创建终端会话
// kind: "" / "shell" 普通终端（需 projectId）；"agent" 智能体终端——
// 免项目绑定（工作目录默认用户主目录），按设置自动拉起底层智能体运行时
// （claude/codex/dsh，InteractiveCommand 常量命令经 PTY 注入），并依赖
// 会话创建时的统一环境注入（CC_BASE_URL/CC_LOCK_TOKEN）直接调用本系统 API
func CreateTerminal(c *gin.Context) {
	var req struct {
		Name      string `json:"name"`
		ProjectID string `json:"projectId"`
		Kind      string `json:"kind"`
		// Runtime 全局终端会话的底层运行时（auto/claude/codex/dsh/自定义注册名），
		// 空 = auto（按可用性选型）；建会话时显式选择，设置中的全局选择已下线
		Runtime string `json:"runtime"`
		// Dir 会话工作目录（两 kind 共用此键，语义分流）：
		//   - kind=agent（缺省）：免项目绑定的工作目录（空 = 用户主目录）。Claude
		//     会话恢复场景传会话记录的 cwd；必须已存在（服务端校验），否则创建失败
		//   - kind=shell 项目会话（P-20261005-192 目录级终端直达）：项目根内子
		//     目录，相对（推荐，正斜杠）或绝对路径均可，缺省 = 项目根（既有行为
		//     零变化）。须已存在且在项目根内（符号链接解析后的双重前缀校验，沿
		//     file 域 SafeJoinProject 同一守卫）——越界 400 稳定原文 "path
		//     traversal not allowed"、缺失/非目录 400 "path does not exist or
		//     is not a directory"（均入 P-29 稳定原文族，前端 KNOWN_ERROR_I18N
		//     既有映射）
		Dir string `json:"dir"`
		// LaunchArgs 追加在运行时启动命令后的参数（如 --resume <sessionId>），
		// 上限 500 字符；仅 kind=agent 生效
		LaunchArgs string `json:"launchArgs"`
		// Shell 会话级 shell 覆盖（P-20261004-57）：裸名或完整路径，须通过
		// LookPath 存在性校验（否则 400）。仅纯终端形态生效——kind=shell 项目
		// 会话、kind=agent 的 shell 运行时（含选型失败降级）；claude/codex/dsh
		// 等运行时会话忽略（运行时自管启动 shell）。空 = 跟随设置
		// terminal.defaultShell / 平台缺省
		Shell string `json:"shell"`
		// AttachTmux 外部 tmux 会话接管（P-20261005-189，创建变体 attach 模式）：
		// 非空 = attach 到服务器上已存在的该 tmux 会话（用户默认 socket），
		// 跳过 new-session/环境注入/引导占位，产物 origin=external（close 语义
		// 分流：关闭=解除接管）。与其余字段互斥
		AttachTmux string `json:"attachTmux"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}

	// 会话级 shell 覆盖（P-20261004-57）：显式选择的 shell 不存在时 400 明确
	// 报错（校验原文即稳定标记，前端 KNOWN_ERROR_I18N 可映射），优于静默换 shell
	if v := strings.TrimSpace(req.Shell); v != "" {
		if err := terminal.ValidateShellPath(v); err != nil {
			shared.Error(c, http.StatusBadRequest, err.Error(), nil)
			return
		}
		req.Shell = v
	}

	// 接管模式（P-20261005-189）：attachTmux 优先于 kind 分流
	if tmuxName := strings.TrimSpace(req.AttachTmux); tmuxName != "" {
		createAttachedTerminal(c, tmuxName, req.Name)
		return
	}

	if req.Kind == "agent" {
		// 项目硬锁（P-20261004-3）：agent 会话目录落在 locked 项目内 → 403。
		// 锁的意图是归档不可变——放一个 agent 进锁内目录等于绕过写族守卫
		if lp := lockedProjectForDir(req.Dir); lp != nil {
			if mw.DenyLockedProject(c, lp) {
				return
			}
		}
		createAgentTerminal(c, req.Name, req.Runtime, req.Dir, req.LaunchArgs, req.Shell)
		return
	}

	// 通过 projectId 查找项目路径
	var repoPath string
	if req.ProjectID != "" {
		p, err := store.Get().Project.GetByID(req.ProjectID)
		if err != nil || p == nil {
			shared.Error(c, http.StatusNotFound, "project not found", nil)
			return
		}
		// 项目硬锁（P-20261004-3）：locked 项目禁止新开终端（读面不受影响）
		if mw.DenyLockedProject(c, p) {
			return
		}
		repoPath = p.Path
	} else {
		// 兼容旧逻辑：从 URL 参数获取
		p := shared.GetProjectFromContext(c)
		if p == nil {
			shared.Error(c, http.StatusBadRequest, "projectId is required", nil)
			return
		}
		// 项目硬锁（P-20261004-3）：同上
		if mw.DenyLockedProject(c, p) {
			return
		}
		repoPath = p.Path
	}

	name := req.Name
	if name == "" {
		// 请求未显式命名：先试槽位名继承（native 重启后重建会话的名称还原），
		// 无记录用同项目现存数 + 1 的序号默认名（语言随请求）
		name = inheritDisplayName(req.ProjectID, "", "")
		if name == "" {
			name = defaultSessionNumberedName(c.GetHeader("Accept-Language"), req.ProjectID)
		}
	}

	// 目录级终端（P-20261005-192）：可选 dir 解析为项目根内绝对路径，缺省 = 项目
	// 根。越界/缺失 400 稳定原文（守卫函数内注释），不静默回落——「想在子目录开
	// 终端」落了根目录属静默错误行为
	workDir, err := resolveSessionWorkDir(repoPath, req.Dir)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}

	id := fmt.Sprintf("term-%d", time.Now().UnixNano())

	// shellIntegration=true：注入 OSC 133 钩子，捕获每条命令的退出码和时长
	//（shell 覆盖经 CreateSessionWithShell 透传，P-20261004-57：空 = 跟随设置）
	session, err := terminal.DefaultManager.CreateSessionInDir(id, name, repoPath, req.ProjectID, true, req.Shell, workDir)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}

	// 产出视图元数据（B3）：项目终端同样落库（用户常在项目终端里跑 claude code
	// 等智能体 CLI——此前只有 agent 会话有基线，点「会话产出」必 404）。异步不阻断。
	// 项目终端无运行时预检链（纯 shell），版本无记录传空；无 prompt 通道传空；
	// 项目会话不参与编队（fleetBatch 恒 nil）。
	// dir 传项目根而非 session.Path（P-20261005-192）：元数据 Dir 承载产出基线
	// 与重启恢复，git 视图（diff/status 相对路径）以根为准才与文件树/变更页同
	// 口径（子目录起 git 的路径带 ../ 前缀且 ls-files 被子目录截断）；目录级会话
	// 的工作目录由 session.Path / OSC 7 currentDir 承载，不依赖元数据
	go saveAgentSessionMeta(session.ID, repoPath, "", session.Name, req.ProjectID, "", "", launchMetaExtra{})

	// 注册 shell 进程退出回调：异常退出（exitCode != 0）写入通知——正文携
	// 验尸摘要 + Action=postmortem 打开验尸弹层（P-20261004-60，与 agent 会话
	// 退出链共用 notifyAbnormalExit；原 terminal 跳转对已退出会话无落点）
	// 正常退出不打扰（任务级完成由前端 OSC 133 解析处理）
	unregister := session.OnExit(func(exitCode int) {
		if exitCode == 0 {
			return
		}
		notifyAbnormalExit(session, exitCode)
	})
	_ = unregister // 回调在 session 关闭时随 map 一起回收

	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"id":        session.ID,
			"name":      session.Name,
			"projectId": req.ProjectID,
			"path":      session.Path,
			"createdAt": session.CreatedAt,
			"kind":      session.Kind,
			// 实际启动的 shell（P-20261004-57）：会话覆盖/设置/平台缺省解析后的
			// 落点。增量观测字段，旧前端忽略无影响
			"shell": session.ShellPath(),
			// 创建后权威总数（P-20261003-183）：前端据此在越过软阈值时轻提示
			//「会话较多」——本地列表可能未加载/陈旧，响应计数不受影响。增量
			// 字段，旧前端忽略无影响
			"totalSessions": len(terminal.DefaultManager.ListSessions()),
		},
	})
	broadcastTerminalsChanged()
}

// ListTerminals 列出终端会话
// ?fleet=<batchId>（P-20261005-145）：按编队批过滤——元数据 fleetBatch.batchId
// 精确匹配，agent 编程追踪编队的查询原语（手册配方：轮询本参数直至无 running
// 成员，即编队收敛）。非编队会话与未知 batchId 过滤后为空列表（非错误）。
// 过滤发生在快照构造之后：meta 反查每会话一次小文件读是既有成本，过滤不新增
// 读放大（快照量级个位数~几十，且列表非热路径）
func ListTerminals(c *gin.Context) {
	// 空闲分离对账（P-20261003-192）：列表消费即巡检——确定性触发通道，打开
	// 会话列表即刻看到超时会话的真实状态；「彻底无人看列表」的场景由 terminal
	// 模块 60s ticker 兜底。e2e 也经此注入时间（列表轮询即触发判定，不等表）。
	// 分离引发的集合变化经 notifyChange → terminals.changed 广播自然触达
	terminal.DefaultManager.CheckIdleSessions()
	snap := sessionSnapshot()
	if fleet := strings.TrimSpace(c.Query("fleet")); fleet != "" {
		snap = filterSnapshotByFleet(snap, fleet)
	}
	c.JSON(http.StatusOK, gin.H{"data": snap})
}

// filterSnapshotByFleet 快照按编队批过滤（纯函数便于单测；sessionSnapshot 的
// fleetBatch 键由本包 applySessionMetaSnapshot 写入，形态 gin.H 契约内聚）
func filterSnapshotByFleet(snap []gin.H, batchID string) []gin.H {
	out := make([]gin.H, 0, len(snap))
	for _, item := range snap {
		fb, ok := item["fleetBatch"].(gin.H)
		if !ok || fb["batchId"] != batchID {
			continue
		}
		out = append(out, item)
	}
	return out
}

// CloseTerminal 关闭终端会话（同时清理产出视图元数据）
// close 语义分流（P-20261005-189）：外部接管会话（origin=external）缺省只
// 解除接管（底层 tmux 会话与其中进程原样存活，产出元数据保留供再接管还原
// 命名）；?kill=1 = 显式终结（kill-session，UI 二次确认后携带），元数据随
// 会话终结一并清理。审计分流（P-20261008-16）：外部会话显式终结是不可逆强
// 操作，入账 terminal.external.kill；解除接管（非破坏性）与自建会话关闭
// （kill=1 与普通 close 等价的例行操作）不入账
func CloseTerminal(c *gin.Context) {
	id := c.Param("id")
	forceKill := c.Query("kill") == "1"
	released := false
	// externalKilled 快照在 kill 动手前取：审计事件携会话名元数据，且语义上
	// 只记「对外部会话的终结」——会话不存在/自建会话两形态恒 nil 零入账
	var externalKilled *terminal.Session
	if s := terminal.DefaultManager.GetSession(id); s != nil && s.Origin == terminal.OriginExternal {
		if forceKill {
			externalKilled = s
		} else {
			released = true
		}
	}
	if forceKill {
		terminal.DefaultManager.KillSession(id)
	} else {
		terminal.DefaultManager.CloseSession(id)
	}
	auditExternalKill(c, externalKilled)
	if !released {
		_ = store.Get().AgentSession.Delete(id)
	}
	// 排队指令随会话消亡（P-20261003-248）：会话没了指令无处可写，留着只会
	// 在同 id 重建前污染批量读面。解除接管的会话同清（再接管不复用旧队列）
	deleteSessionQueue(id)
	// 会话级放行即时摘除（P-20261003-316）：「本会话放行」的时限边界就是会话
	// 生命周期——关闭即失效，不等 ai 模块周期巡检兜底。映射空时跳过（默认态
	// 关终端零写盘）
	if cfg := store.Get().Settings.Get(); cfg != nil && len(cfg.Server.AgentSessionAllows) > 0 {
		cfg.Server.RevokeSessionAllow(id)
		_ = store.Get().Settings.Save()
	}
	broadcastTerminalsChanged()
	c.JSON(http.StatusOK, gin.H{"message": "terminal closed"})
}

// RenameTerminal 重命名终端
func RenameTerminal(c *gin.Context) {
	id := c.Param("id")
	var req struct {
		Name string `json:"name" binding:"required"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}

	session := terminal.DefaultManager.GetSession(id)
	if session == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	session.Rename(req.Name)
	// 显示名落库（全后端）：tmux 重启恢复按 meta.Name 还原；native 后端无恢复
	// 能力（Windows 等），落库供重启后新建会话的槽位名继承
	saveSessionDisplayName(id, req.Name, session.Path, session.ProjectID, session.CreatedAt)
	broadcastTerminalsChanged()
	// 同名警示（P-20261023-3）：显示名允许重名的既有语义不变（不阻断不回滚），
	// 响应附同名会话摘要（id/名/创建时间/最近活动）做知情补全——同名错认 =
	// 对错会话发错指令的身份错乱源头，agent 可编程消费（改名前查重 + 改名后
	// 验残留）。范围 kind=agent（侧栏会话树同口径；项目会话独立成树不对照）
	resp := gin.H{"message": "renamed"}
	if dups := duplicateAgentSessions(id, req.Name, terminal.DefaultManager.ListSessions()); len(dups) > 0 {
		resp["duplicate"] = dups
	}
	c.JSON(http.StatusOK, resp)
}

// saveSessionDisplayName 会话显示名落库（upsert，全后端）：
//   - tmux 重启恢复按 meta.Name 还原用户命名（否则回退默认名）
//   - native 后端无恢复能力，Named 记录作为重启后新建会话槽位继承的源
//
// meta 缺失（老会话/创建异步落库未达）补建而非静默跳过——此前被 IsPersistent
// 门控，native 下改名随进程消亡必然丢失
func saveSessionDisplayName(sessionID, name, dir, projectID string, createdAt time.Time) {
	meta, err := store.Get().AgentSession.Get(sessionID)
	if err != nil || meta == nil {
		meta = &store.AgentSessionMeta{
			ID:        sessionID,
			Dir:       dir,
			ProjectID: projectID,
			CreatedAt: createdAt,
		}
	}
	meta.Name = name
	meta.Named = true
	meta.NamedAt = time.Now()
	if meta.Dir == "" {
		meta.Dir = dir
	}
	if meta.ProjectID == "" {
		meta.ProjectID = projectID
	}
	if err := store.Get().AgentSession.Save(*meta); err != nil {
		slog.Warn("terminal: rename meta save failed", "id", sessionID, "err", err)
	}
}

// ResizeTerminal 调整终端大小
func ResizeTerminal(c *gin.Context) {
	id := c.Param("id")
	var req struct {
		Rows uint16 `json:"rows"`
		Cols uint16 `json:"cols"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}

	session := terminal.DefaultManager.GetSession(id)
	if session == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}

	if err := session.Resize(req.Rows, req.Cols); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "resized"})
}

// RedrawTerminal 强制重绘终端：tmux 后端执行 refresh-client（以 tmux 网格为
// 事实源重发整屏），native 后端 no-op。前端在 pane 重新可见/尺寸稳定后调用——
// 会话总览跳转、最大化/还原、底部面板重开后，治愈 PTY 与 xterm 尺寸竞态、
// 隐藏期丢帧等造成的显示错乱与滚轮失灵
func RedrawTerminal(c *gin.Context) {
	id := c.Param("id")
	session := terminal.DefaultManager.GetSession(id)
	if session == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	session.Redraw()
	c.JSON(http.StatusOK, gin.H{"message": "redrawn"})
}

// GetTmuxInfo GET /api/terminals/tmux-info
// 返回服务端 tmux 状态：是否安装、版本、路径、是否可一键安装、推荐安装命令
func GetTmuxInfo(c *gin.Context) {
	info := terminal.GetTmuxInfo()
	c.JSON(http.StatusOK, gin.H{"data": info})
}

// InstallTmux POST /api/terminals/tmux-install
// 一键安装 tmux（best-effort）：检测包管理器后执行安装命令
// 非 root + 需要 root 的包管理器（apt/yum 等）：返回 NeedsSudo=true，前端提示用户
// macOS brew：可直接成功
func InstallTmux(c *gin.Context) {
	result, err := terminal.InstallTmux() //nolint:staticcheck // SA4023：windows stub InstallTmux 恒返回错误，unix 侧真实判错
	if err != nil {                       //nolint:staticcheck // SA4023：windows stub InstallTmux 恒返回错误，unix 侧真实判错
		shared.Error(c, http.StatusInternalServerError, "Install tmux failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": result})
}
