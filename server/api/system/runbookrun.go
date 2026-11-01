package system

// 运行书服务端执行（P-20261004-108）：POST /api/runbooks/:id/run。
//
// 动机：运行书执行链此前是纯前端（useRunbookRunner 经宿主终端逐条写 PTY），
// agentcron 定时跑、会话接续链、联邦派发都组合不了它——「把固化流程跑起来」
// 必须人开面板。本端点把同一套语义服务端化：步骤插值（textTemplate 同语义，
// 见 runbooktemplate.go）→ 逐步 WriteInput → OSC 133 D 帧等退出码（P-20261004-63
// 服务端运行态追踪的等待原语 WaitCommandExit）→ task.progress 逐步上报
// （运行书执行即任务，悬浮球/值班大屏/任务落库自然可见）。
//
// 同步语义与 60s 响应墙：返回即终态（逐步结果/退出码随响应），面向「步骤级
// 命令」的常规运行书（前端执行器同款 30s 单步档）。服务端 WriteTimeout 60s
// （app.go）是硬墙——总时长超 60s 的长运行响应写不回（连接断，执行本身不受
// 影响：进度/终态照常广播落库、审计照记）；调用方断连后勿盲目重试（同书
// 互斥会 409 runbook.busy 挡住并发二跑），终态以 task.progress 广播与
// GET /api/agent-tasks?sessionId=<执行会话> 落库流为准。
//
// 与前端执行器的语义对齐（useRunbookRunner.ts）：
//   - onFailure = continue（默认）：失败步如实记录但不拦截；stop：非 0 退出码
//     即停在失败项（后续步骤 skipped）
//   - 单步等待超时（默认 30s = 前端 CMD_TIMEOUT_MS）视为完成继续（迟到 D 帧
//     不再消费，防卡死）；首轮等待超时且全程未见任何 C/D 帧 = shell 集成缺失，
//     降级为连续发送（degraded 如实回告，宁降级不虚报）
//   - 会话不可写（被关闭）：如实停在当前步，步骤记 failed
//
// 安全面注记（为什么不入 AgentGuard 高危表）：写入 PTY 的命令来自用户经管理
// UI 策展的运行书存稿，agent 只供参数值——与 agent-crons/:id/run（存稿 prompt
// 发起会话）同级，而非 broadcast-write（请求体原文进 PTY，高危审批）的任意
// 输入面。每次执行入审计（runbook.run，不带参数值与命令原文），留痕可追溯。
//
// 并发：同 book 串行（进程内互斥表，第二个并发 run 409 runbook.busy）——
// 步骤命令往往有先后依赖（部署三连），并发跑同一本没有合理语义；跨重启无
// 状态（内存表，重启即清）。不同 book 可并行。

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	terminalapi "codecombo/server/api/terminal"
	"codecombo/server/mask"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 执行参数边界。超时档位与间隔沿前端执行器常量的服务端化（CMD_TIMEOUT_MS /
// CONT_SEND_GAP_MS 同值）：
//   - 缺省 30s：单步 D 帧等待上限，超时视为完成继续（防卡死，长任务不阻序列）
//   - 可经请求 stepTimeoutMs 覆盖（长构建/长部署场景），钳 3s~10min：
//     下限防 0/负值把等待变空转，上限防同步请求无限期挂起
const (
	runbookRunStepTimeoutDefault = 30 * time.Second
	runbookRunStepTimeoutMin     = 3 * time.Second
	runbookRunStepTimeoutMax     = 10 * time.Minute
	// runbookRunGapMs 降级连续发送间隔（毫秒）：给 shell 吞行留缝（同粘贴多行语义）
	runbookRunGapMs = 350
	// runbookNameMax 新会话名的书名截断（runes）：会话名是辨识面不是全文面
	runbookNameMax = 40
)

// runbookRunRequest POST /api/runbooks/:id/run 请求体（全字段可选）
type runbookRunRequest struct {
	// Params 占位符供参：{参数名: 值}，服务端按 textTemplate 同语义插值；
	// 缺失（或空白值）参数 400 带缺失清单（runbook.params_missing）
	Params map[string]string `json:"params"`
	// TargetSessionID 目标会话：缺省新建纯 shell agent 会话（kind=agent 的
	// 独立执行现场，不扰现有会话）；显式指定时须在册（404 runbook.target_not_found）。
	// 显式会话里「他人在同会话并发敲命令」的 D 帧错位属知情边界（D 帧按到达序
	// 归属，与前端执行器同粗糙度；缺省新建会话无此暴露面）
	TargetSessionID string `json:"targetSessionId"`
	// OnFailure 覆盖书的失败语义："" = 沿用书定义（书也未定义 = continue）；
	// 合法值 continue/stop（非法 400）
	OnFailure string `json:"onFailure"`
	// StepTimeoutMs 单步 D 帧等待上限覆盖（毫秒）：0 = 缺省 30s；越界钳制
	StepTimeoutMs int `json:"stepTimeoutMs"`
}

// runbookRunStepResult 单步执行结果（响应 data.steps 元素）
type runbookRunStepResult struct {
	Index       int    `json:"index"`
	Command     string `json:"command"` // 插值后实际执行的命令
	Description string `json:"description,omitempty"`
	Status      string `json:"status"` // done | failed | skipped
	// ExitCode 退出码；nil = 无判据（超时视为完成 / 降级发送未等待）
	ExitCode *int `json:"exitCode,omitempty"`
	// TimedOut 等待超时（命令可能仍在跑，按 CMD_TIMEOUT 惯例视为完成继续）
	TimedOut bool `json:"timedOut,omitempty"`
}

// runbookRunResult 执行结果（HTTP 响应 data；同步执行，返回即终态）
type runbookRunResult struct {
	RunID     string                 `json:"runId"`
	BookID    string                 `json:"bookId"`
	Title     string                 `json:"title"`
	SessionID string                 `json:"sessionId"`
	OnFailure string                 `json:"onFailure"`
	Status    string                 `json:"status"` // completed | failed
	Degraded  bool                   `json:"degraded,omitempty"`
	Steps     []runbookRunStepResult `json:"steps"`
}

// 同 book 并发互斥表（进程内；见文件头并发注记）
var (
	runbookRunMu      sync.Mutex
	runbookActiveRuns = map[string]string{} // bookID → runID
	runbookRunSeq     int
)

// admitRunbookRun 同 book 串行准入：成功返回本次 runId，占用中返回 ("", false)
func admitRunbookRun(bookID string) (string, bool) {
	runbookRunMu.Lock()
	defer runbookRunMu.Unlock()
	if _, busy := runbookActiveRuns[bookID]; busy {
		return "", false
	}
	runbookRunSeq++
	runID := fmt.Sprintf("rb_run_%d_%d", time.Now().UnixMilli(), runbookRunSeq)
	runbookActiveRuns[bookID] = runID
	return runID, true
}

// releaseRunbookRun 释放互斥表（幂等；仅当 runId 匹配才清，防迟到的释放清掉
// 后继 run 的占用）
func releaseRunbookRun(bookID, runID string) {
	runbookRunMu.Lock()
	defer runbookRunMu.Unlock()
	if runbookActiveRuns[bookID] == runID {
		delete(runbookActiveRuns, bookID)
	}
}

// RunRunbook POST /api/runbooks/:id/run —— 运行书服务端执行（同步：返回即终态，
// 逐步进度经 task.progress 广播与任务落库面实时可见）
func RunRunbook(c *gin.Context) {
	id := c.Param("id")
	if !runbookIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "runbook not found", nil)
		return
	}
	var req runbookRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeRunbookPayloadInvalid, "runbook run failed", err)
		return
	}
	book, err := store.Get().Runbook.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "runbook not found", nil)
		return
	}

	// 失败语义：请求覆盖 > 书定义 > continue（与前端面板开关同层级）
	onFailure := book.OnFailure
	if req.OnFailure != "" {
		if !validateRunbookOnFailure(req.OnFailure) {
			shared.ErrorWithCode(c, shared.CodeRunbookPayloadInvalid, "invalid onFailure (continue|stop)", nil)
			return
		}
		onFailure = req.OnFailure
	}
	if onFailure == "" {
		onFailure = "continue"
	}

	stepTimeout := runbookRunStepTimeoutDefault
	if req.StepTimeoutMs > 0 {
		stepTimeout = time.Duration(req.StepTimeoutMs) * time.Millisecond
		if stepTimeout < runbookRunStepTimeoutMin {
			stepTimeout = runbookRunStepTimeoutMin
		}
		if stepTimeout > runbookRunStepTimeoutMax {
			stepTimeout = runbookRunStepTimeoutMax
		}
	}

	// 参数校验先行（插值前）：缺失清单按步骤出现序给出，400 可行动——
	// agent 据此补参重发，不静默把占位符残片写进终端
	required := runbookRequiredParams(book.Steps)
	missing := make([]string, 0, len(required))
	for _, name := range required {
		if v, ok := req.Params[name]; !ok || strings.TrimSpace(v) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		shared.JSONWithCode(c, shared.CodeRunbookParamsMissing, gin.H{
			"error":   "missing params: " + strings.Join(missing, ", "),
			"missing": missing,
		})
		return
	}
	commands := make([]string, len(book.Steps))
	for i, s := range book.Steps {
		commands[i] = interpolateRunbookTemplate(s.Command, req.Params)
	}

	runID, ok := admitRunbookRun(book.ID)
	if !ok {
		shared.ErrorWithCode(c, shared.CodeRunbookBusy, "runbook already running", nil)
		return
	}
	defer releaseRunbookRun(book.ID, runID)

	sess, created, err := resolveRunbookTarget(c, req.TargetSessionID, book.Title)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "runbook target session failed", err)
		return
	}
	if !created {
		// 显式目标会话（404 校验在 resolveRunbookTarget 内）
		if sess == nil {
			shared.ErrorWithCode(c, shared.CodeRunbookTargetNotFound, "target session not found", nil)
			return
		}
		// 前序在跑命令先排干（其 D 帧被本次等待消费，不被第一步误归属）；
		// 排干失败（仍在跑）照常起步——错位窗口与前端执行器同边界，知情指定
		if running, _ := sess.OscRunningState(); running {
			sess.WaitCommandExit(stepTimeout)
		}
	}

	result := executeRunbookSteps(sess, runID, book, commands, onFailure, stepTimeout)
	auditRunbookRun(c, book, sess.ID, result)
	c.JSON(http.StatusOK, gin.H{"data": result})
}

// resolveRunbookTarget 解析执行目标会话：显式 id 在册校验（404 语义由调用方
// 出——返回 nil sess）；缺省经 agent 终端创建核心新建纯 shell 会话（kind=agent，
// 独立执行现场：shell 集成注入 → OSC 133 退出码可用；不扰任何现有会话）。
// 返回 created 标记区分两路（新建路径免「在跑排干」——新 shell 无前序命令）
func resolveRunbookTarget(c *gin.Context, targetID, title string) (*terminal.Session, bool, error) {
	if id := strings.TrimSpace(targetID); id != "" {
		if sess := terminal.DefaultManager.GetSession(id); sess != nil {
			return sess, false, nil
		}
		return nil, false, nil
	}
	res, err := terminalapi.LaunchAgentSession("runbook: "+truncateRunes(title, runbookNameMax), "shell", "", "", c.GetHeader("Accept-Language"),
		// 同名运行书并行执行/重跑不产出雷同名（P-20261023-3 显式名消歧同口径）
		terminalapi.WithDisplayNameDedup())
	if err != nil {
		return nil, false, err
	}
	// 新会话即时进前端列表（会话管理页/底部终端 tab 对账）；broadcastTerminalsChanged
	// 的导出桥——agentcron/agentchain 链不广播属存量，运行书执行是「为一次运行
	// 专门开的现场」，用户需要马上看到它
	terminalapi.BroadcastTerminalsChanged()
	if sess := terminal.DefaultManager.GetSession(res.ID); sess != nil {
		return sess, true, nil
	}
	// LaunchAgentSession 成功但 GetSession 落空：竞态窗口（理论不可达），按失败走
	return nil, false, fmt.Errorf("session %s vanished right after launch", res.ID)
}

// executeRunbookSteps 执行主链：逐步写终端 + D 帧等退出码 + 逐步进度上报。
// 失败语义与降级判定见文件头（与前端 useRunbookRunner 对齐）
func executeRunbookSteps(sess *terminal.Session, runID string, book *store.Runbook, commands []string, onFailure string, stepTimeout time.Duration) *runbookRunResult {
	n := len(commands)
	result := &runbookRunResult{
		RunID:     runID,
		BookID:    book.ID,
		Title:     book.Title,
		SessionID: sess.ID,
		OnFailure: onFailure,
		Status:    "completed",
		Steps:     make([]runbookRunStepResult, n),
	}
	names := runbookStepDisplayNames(book.Steps, commands)

	publishRunbookProgress(runID, book, sess.ID, "running", fmt.Sprintf("runbook start (%d steps)", n), 0, names)
	degraded := false
	for i := 0; i < n; i++ {
		step := &result.Steps[i]
		step.Index = i
		step.Command = commands[i]
		step.Description = book.Steps[i].Description
		if degraded {
			// 无 shell 集成降级：连续发送不等待（无退出码判据），状态如实记 done
			//（与前端 degraded 分支同语义：不再虚报逐条判定）
			time.Sleep(runbookRunGapMs * time.Millisecond)
			if err := sess.WriteInput([]byte(commands[i] + "\r")); err != nil {
				step.Status = "failed"
				result.Status = "failed"
				publishRunbookProgress(runID, book, sess.ID, "failed", fmt.Sprintf("step %d/%d write failed", i+1, n), i, names)
				break
			}
			step.Status = "done"
			publishRunbookProgress(runID, book, sess.ID, "running", fmt.Sprintf("step %d/%d sent (degraded)", i+1, n), i+1, names)
			continue
		}

		publishRunbookProgress(runID, book, sess.ID, "running", fmt.Sprintf("step %d/%d: %s", i+1, n, names[i]), i, names)
		if err := sess.WriteInput([]byte(commands[i] + "\r")); err != nil {
			// 会话不可写（被关闭/PTY 断）：如实停在当前步（前端同语义），
			// 余下步骤两种失败档都未发送，一律记 skipped
			step.Status = "failed"
			result.Status = "failed"
			skipRunbookTail(result, i, book.Steps)
			publishRunbookProgress(runID, book, sess.ID, "failed", fmt.Sprintf("step %d/%d session not writable", i+1, n), i, names)
			break
		}
		step.Status = "done"
		code, ok := sess.WaitCommandExit(stepTimeout)
		if ok {
			step.ExitCode = &code
			if code != 0 {
				step.Status = "failed"
			}
		} else {
			// 等待超时：首轮且全程无帧 = shell 集成缺失，降级连续发送（余下步骤
			// 不再等待）；否则命令仍在跑，按 CMD_TIMEOUT 惯例视为完成继续
			step.TimedOut = true
			if i == 0 && !sess.OscFramesSeen() {
				degraded = true
				result.Degraded = true
			}
		}

		failed := step.Status == "failed"
		publishRunbookProgress(runID, book, sess.ID, "running",
			fmt.Sprintf("step %d/%d %s", i+1, n, stepStatusLabel(step)), i+1, names)
		if failed && onFailure == "stop" {
			// 停在失败项：余下步骤 skipped（前端 stop 分支同语义）
			result.Status = "failed"
			skipRunbookTail(result, i, book.Steps)
			publishRunbookProgress(runID, book, sess.ID, "failed", fmt.Sprintf("stopped at failed step %d/%d", i+1, n), i, names)
			break
		}
		if failed {
			result.Status = "failed"
		}
	}
	if result.Status == "completed" {
		publishRunbookProgress(runID, book, sess.ID, "done", fmt.Sprintf("runbook completed (%d steps)", n), n, names)
	}
	return result
}

// skipRunbookTail 把 stop 位之后的余下步骤标记 skipped（未发送即未执行，
// 响应面不留给零值空态）
func skipRunbookTail(result *runbookRunResult, from int, steps []store.RunbookStep) {
	for j := from + 1; j < len(result.Steps); j++ {
		result.Steps[j] = runbookRunStepResult{Index: j, Status: "skipped"}
		if j < len(steps) {
			result.Steps[j].Description = steps[j].Description
		}
	}
}

// stepStatusLabel 步骤进度的短状态词（running/done/failed/timeout）
func stepStatusLabel(s *runbookRunStepResult) string {
	switch {
	case s.Status == "failed":
		return "failed"
	case s.TimedOut:
		return "timeout (treated as done)"
	default:
		return "done"
	}
}

// runbookStepDisplayNames 步骤展示名（task.progress.steps 与 step 文案共用）：
// 说明优先，缺省用命令首行——广播面/悬浮球是扫读面，命令可能携密钥，过 P-197
// 同源遮蔽 + 截断（与审计不入命令原文同一取态）
func runbookStepDisplayNames(steps []store.RunbookStep, commands []string) []string {
	names := make([]string, len(steps))
	for i, s := range steps {
		src := s.Description
		if strings.TrimSpace(src) == "" {
			src = commands[i]
			if idx := strings.IndexAny(src, "\r\n"); idx >= 0 {
				src = src[:idx]
			}
		}
		names[i] = truncateRunes(mask.MaskApprovalText(src), 80)
	}
	return names
}

// publishRunbookProgress 逐步进度上报（task.progress）：terminalId 归属目标
// 会话（悬浮球/值班大屏/未读点按会话聚合），steps 结构化清单给「共几步完成几步」。
// 载荷走运行书扩展字段 runId/bookId（发布契约的增量扩展，前端 normSteps 与
// 消费分支不识别即忽略）。steps 清单按发布口同款 ≤20 收敛（悬浮件是扫读面，
// 超长书只列前 20，步骤计数不受影响）
func publishRunbookProgress(runID string, book *store.Runbook, sessionID, status, step string, doneCount int, names []string) {
	steps := make([]map[string]interface{}, 0, len(names))
	for i, name := range names {
		if i >= 20 {
			break
		}
		steps = append(steps, map[string]interface{}{"name": name, "done": i < doneCount})
	}
	opschannel.BroadcastEvent(opschannel.EventTaskProgress, gin.H{
		"task":       "runbook: " + book.Title,
		"status":     status,
		"step":       step,
		"steps":      steps,
		"terminalId": sessionID,
		"runId":      runID,
		"bookId":     book.ID,
	})
}

// auditRunbookRun 执行审计：书/会话/步数元数据——参数值与命令原文不入账
// （可能携密钥；运行现场在目标会话 scrollback，审计只答「谁跑了哪本书」）。
// 携 gin context 走 AuditAppend 中央口，rid 随请求注入（P-20261006-53）
func auditRunbookRun(c *gin.Context, book *store.Runbook, sessionID string, result *runbookRunResult) {
	ran, failed := 0, 0
	for _, s := range result.Steps {
		if s.Status == "done" || s.Status == "failed" {
			ran++
		}
		if s.Status == "failed" {
			failed++
		}
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditRunbookRun,
		Result: map[bool]string{true: store.AuditResultSuccess, false: store.AuditResultFailure}[result.Status == "completed"],
		Detail: fmt.Sprintf("book=%s title=%q session=%s steps=%d ran=%d failed=%d degraded=%t",
			book.ID, book.Title, sessionID, len(result.Steps), ran, failed, result.Degraded),
	})
}

// runbookRequiredParams 汇总全书步骤的必填参数（出现序去重）
func runbookRequiredParams(steps []store.RunbookStep) []string {
	seen := map[string]bool{}
	out := make([]string, 0, 4)
	for _, s := range steps {
		for _, name := range extractRunbookParams(s.Command) {
			if !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
	}
	return out
}

// truncateRunes 按 rune 截断（超长附 …）；广播/会话名等展示面的统一收敛
func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max]) + "…"
}
