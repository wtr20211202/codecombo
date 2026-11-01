package terminal

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 舰队并行 agent 任务（P-20261003-291）：一次给多个项目批量发起智能体会话，
// 「给全部项目跑依赖审计/修 lint」类批量作业的编队入口。逐项目复用
// LaunchAgentSession 既有链——运行时选型/创建前预检/降级语义与单开会话完全
// 一致，不在批量链上另起炉灶；会话 dir=项目根，会话按目录归属自然聚合进
// 各项目的 agent 侧栏分组与值班大屏。

// fleetBulkAgentCap 单次编队上限（防风暴：20 个 PTY + 20 个 agent 进程已是一
// 次编队的合理水位；顺序创建不并发轰击——创建本身含 --version 预检等子进程，
// 并发扇出会叠加负载）。更多的项目分批发起
const fleetBulkAgentCap = 20

// fleetBulkSkip 批量发起的单条跳过回告：projectId + 服务端稳定标记原文
// （project not found / PrecheckError.Error 等，前端弹层做已知标记本地化映射）
type fleetBulkSkip struct {
	ProjectID string `json:"projectId"`
	Reason    string `json:"reason"`
}

// BulkCreateAgentTerminals POST /api/terminals/bulk-agent
// {"projectIds":[...](≤20),"runtime"?,"prompt"} —— 逐项目创建 agent 会话：
//   - dir=项目根；launchArgs=同一 prompt，超 500 字节服务端保尾截断（口径对齐
//     前端 web/src/utils/promptFit.ts 的 fitByBytes/LAUNCH_ARGS_MAX_BYTES——那是
//     前端 util，Go 侧无对应，此处做等效实现，见 fleetFitLaunchBytes）
//   - 会话名统一「fleet: <prompt 头部截断>」（fleetSessionName），编队在会话
//     列表/悬浮窗/值班大屏按名可辨
//   - 编队批身份（P-20261005-145）：每批生成 batchId=fleet-<unixnano>，批元数据
//     （发起时间+成员花名册）经 WithFleetBatch 随各成员创建落会话元数据；响应
//     附 fleetBatch 同值快照（发起方即时可编程追踪，无需反查）
//   - 顺序执行逐项目创建；单项目失败（项目缺失/runtime 预检失败/目录创建失败）
//     逐条回告跳过、不中断编队，返回 {created:[{projectId,terminalId}...],
//     skipped:[{projectId,reason}...], fleetBatch:{batchId,launchedAt,members}}
//
// 量级考量：顺序创建 cap 20，单项目开销 ≈ runtime 预检（--version 快检 ≤2s，
// userbin 解析有 TTL 缓存）+ PTY 派生，实测 <1s/项目（热缓存毫秒级）；最坏
// 有界在数十秒量级——编队发起是显式低频动作，前端按钮 loading 承载等待。
//
// 权限口径：token 门即可（LockMiddleware/TokenAuthMiddleware 常规保护组）——
// 与单开会话同级、非高危操作，不挂审批链
func BulkCreateAgentTerminals(c *gin.Context) {
	var req struct {
		ProjectIDs []string `json:"projectIds"`
		Runtime    string   `json:"runtime"`
		Prompt     string   `json:"prompt"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	if len(req.ProjectIDs) == 0 {
		shared.ErrorWithCode(c, shared.CodeTerminalProjectIDsEmpty, "projectIds is required", nil)
		return
	}
	if len(req.ProjectIDs) > fleetBulkAgentCap {
		shared.ErrorWithCode(c, shared.CodeTerminalProjectIDsTooMany,
			fmt.Sprintf("too many projects: max %d per fleet launch", fleetBulkAgentCap), nil)
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		shared.ErrorWithCode(c, shared.CodeTerminalPromptRequired, "prompt is required", nil)
		return
	}

	launchArgs := fleetFitLaunchBytes(strings.TrimSpace(req.Prompt), 500)
	name := fleetSessionName(req.Prompt)
	lang := c.GetHeader("Accept-Language")

	// 编队批身份（P-20261005-145）：batchId 请求期生成一次，成员创建即挂靠
	//（unixnano 与会话 id 同款生成惯例；同批全体成员元数据同值拷贝）
	batch := store.FleetBatch{
		BatchID:    fmt.Sprintf("fleet-%d", time.Now().UnixNano()),
		LaunchedAt: time.Now(),
		Members:    make([]string, 0, len(req.ProjectIDs)),
	}

	created := make([]gin.H, 0, len(req.ProjectIDs))
	skipped := make([]fleetBulkSkip, 0)
	for _, pid := range req.ProjectIDs {
		p, err := store.Get().Project.GetByID(pid)
		if err != nil || p == nil {
			skipped = append(skipped, fleetBulkSkip{ProjectID: pid, Reason: "project not found"})
			continue
		}
		// 批身份直传（不含花名册——成员 id 由创建链生成，此刻不可预知，
		// 值拷贝只携带 batchId+发起时间）；完整花名册循环后统一回填
		res, err := LaunchAgentSession(name, req.Runtime, p.Path, launchArgs, lang,
			WithFleetBatch(store.FleetBatch{BatchID: batch.BatchID, LaunchedAt: batch.LaunchedAt}),
			// 编队成员统一 "fleet: <prompt 头部>" 名（P-20261023-3）：同批成员
			// 天然同名，消歧步进让侧栏一眼分清第 N 个成员
			WithDisplayNameDedup())
		if err != nil {
			// 明确错误原样回告（PrecheckError.Error 是前端 KNOWN_ERROR_I18N
			// 已映射的稳定标记）；单项目失败不中断编队，其余项目继续
			skipped = append(skipped, fleetBulkSkip{ProjectID: pid, Reason: err.Error()})
			continue
		}
		batch.Members = append(batch.Members, res.ID)
		created = append(created, gin.H{
			"projectId":  pid,
			"terminalId": res.ID,
			"name":       res.Name,
			"path":       res.Path,
			"runtime":    res.Runtime,
			"launched":   res.Launched,
		})
	}
	// 完整花名册回填（P-20261005-145）：逐成员各存全批拷贝（任一成员即可反查
	// 全批，部分成员关闭后花名册仍完整）。读-改-写保守更新（与改名/敏感标记
	// 策展面同款，互不覆盖）；仍在建会话广播之前，首屏快照即见完整批元数据
	for _, id := range batch.Members {
		attachFleetBatch(id, batch)
	}

	// 一次广播对账全部新建（广播载荷是全量快照，逐会话广播无增量收益）。
	// 成员元数据已在 LaunchAgentSession 内同步落库（WithFleetBatch 链），此处
	// 广播的快照 meta 反查必见 fleetBatch——值班聚合卡「发起后即看」
	if len(created) > 0 {
		broadcastTerminalsChanged()
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"created":    created,
		"skipped":    skipped,
		"fleetBatch": fleetBatchResponse(batch),
	}})
}

// attachFleetBatch 完整花名册回填（P-20261005-145）：读-改-写更新会话元数据的
// fleetBatch（meta 缺失——同步落库失败的罕见面——补建最小文档保批身份不丢）
func attachFleetBatch(sessionID string, batch store.FleetBatch) {
	meta, err := store.Get().AgentSession.Get(sessionID)
	if err != nil || meta == nil {
		meta = &store.AgentSessionMeta{ID: sessionID, CreatedAt: batch.LaunchedAt}
	}
	meta.FleetBatch = &store.FleetBatch{
		BatchID:    batch.BatchID,
		LaunchedAt: batch.LaunchedAt,
		Members:    append([]string(nil), batch.Members...),
	}
	if err := store.Get().AgentSession.Save(*meta); err != nil {
		slog.Warn("fleet batch roster attach failed", "id", sessionID, "err", err)
	}
}

// fleetBatchResponse 编队批元数据的响应视图（members 恒非 null——全跳过的批
// 前端直读不炸，与 created 空数组惯例一致）
func fleetBatchResponse(batch store.FleetBatch) gin.H {
	members := batch.Members
	if members == nil {
		members = make([]string, 0)
	}
	return gin.H{
		"batchId":    batch.BatchID,
		"launchedAt": batch.LaunchedAt,
		"members":    members,
	}
}

// fleetFitLaunchBytes 服务端保尾截断（口径对齐 web/src/utils/promptFit.ts 的
// fitByBytes——该 util 是前端实现，Go 侧无对应，此处等效实现；改截断策略须
// 两侧同步）：超 max 字节裁头部保尾部并加 … 前缀标注——编队 prompt 的尾部
// 通常是具体指令/约束，头部多是铺垫。两段式估裁同款：先按超量 floor(over/4)
// 估裁字符数（UTF-8 每字符 ≤ 4 字节，保证不裁过头），再逐字符微调到恰好
// 收进 max；切片按 rune 不按字节，多字节字符不腰斩
func fleetFitLaunchBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	const ellipsis = "…"
	runes := []rune(s)
	cut := (len(s) - max) / 4
	if cut > len(runes) {
		cut = len(runes)
	}
	runes = runes[cut:]
	for len(runes) > 0 && len(ellipsis)+len(string(runes)) > max {
		runes = runes[1:]
	}
	if len(runes) == 0 {
		return ""
	}
	return ellipsis + string(runes)
}

// fleetSessionName 编队会话名「fleet: <prompt 头部截断>」：取 prompt 首个非空行
// （控制字符折叠为空格，与单会话 promptSessionName 同一展示口径），超
// promptSessionNameMax rune 截断加省略号。与单会话摘要名不同：fleet: 是编队
// 的统一显式标识，不做旗标形态短路（批量链的 prompt 必是任务指令，请求校验
// 已拦空串；头行为空取兜底名）
func fleetSessionName(prompt string) string {
	head := ""
	for _, line := range strings.Split(prompt, "\n") {
		line = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, line))
		if line == "" {
			continue
		}
		head = line
		break
	}
	if head == "" {
		return "fleet"
	}
	if utf8.RuneCountInString(head) > promptSessionNameMax {
		head = string([]rune(head)[:promptSessionNameMax]) + "…"
	}
	return "fleet: " + head
}
