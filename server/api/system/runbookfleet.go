package system

// 舰队运行书执行（P-20261005-147）：按序对 N 台会话执行一组命令的编排引擎——
// 广播（P-20261003-288 一次发 N 台）× 运行书步骤（P-20261004-108 服务端执行）×
// 完成聚合（逐步逐目标退出码矩阵）的合成兑现。部署序列 pull→build→restart→
// health check 这类「多台有序运维」从此一屏编排，不再逐台人肉盯。
//
// 端点族（fleet-runbook）：
//   POST /api/runbooks/:id/fleet-run    执行（同步语义见下）
//   POST /api/runbooks/:id/fleet-abort  手动中止（\x03 广播到未完成目标）
//   POST /api/runbooks/:id/fleet-retry  失败步单台重试（不重跑全书）
//
// 执行语义（与单会话 run 对齐的部分沿其惯例）：
//   - 每步 = 逐目标写入命令（BroadcastWrite 同量级顺序写）+ 并发等各目标
//     OSC 133 D 帧退出码 → 全成功走下一步 / 任一失败按 onFailure（stop =
//     中止全书并回告哪台哪步——矩阵 failed 格所在行×列；continue 记录继续）
//   - 命令恒写入，降级分类在等待超时后按帧判据给出：全程无任何 C/D 帧 =
//     无 OSC133 确认信号（裸 sh / 远程终端——写入通道无确认信号回传），
//     该格记 done + noSignal（「无确认信号」诚实标注，提案「超时即视为完成」；
//     远程适配器等待原语即时返回不烧等待窗）。不做写前判定——刚建好的集成
//     会话在首提示符渲染前同样一帧未见，写前跳过会吞掉真命令（e2e 实测踩坑）
//   - 有信号但超时（缺省 120s 可调，钳 3s~10min）：视为完成 + timedOut 标注
//     （CMD_TIMEOUT 惯例，长构建不阻序列；矩阵格如实标注供人工判读）
//   - 步间最小间隔 350ms（广播风暴护栏：给 N 台 shell 吞行留缝，间隔内可中止）
//
// 同步语义与 60s 响应墙（runbook run 同款注记，舰队场景更常见）：返回即终态，
// 但总时长超服务端 WriteTimeout 60s 时连接断而执行不受影响——进度/终态以
// task.progress 批事件（payload.fleet 扩展：start 建骨架 + step 逐格增量 +
// final 终态）为准，同书互斥 409 挡断连重试二跑。前端矩阵面板是事件驱动
// 合并态，不依赖响应必达。
//
// 安全面（不入 AgentGuard 高危表）：写入 PTY 的命令来自用户策展的运行书存稿，
// agent 只供参数值与目标清单——与 runbook run（存稿执行）同级，而非
// broadcast-write（请求体原文进 PTY）的任意输入面。目标会话是既有会话的
// 枚举（id 不在册 400 早失败），不产生新执行现场。执行/中止/重试均入审计
// （fleet.runbook.execute，参数值与命令原文不入账）。
//
// 并发：同 book 串行（与单会话 run 共用 admitRunbookRun 互斥表——同一本书
// 舰队跑和单台跑并发没有合理语义）；跨重启无状态（内存注册表，重启即清，
// 重启后 runId 404 与 TTL 过期同语义）。终态条目保留 1h 供中止/重试回看
// （deploy 任务保留窗同档），新 run 准入时惰性清扫，无独立 ticker。

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/remoteterminal"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// fleetRunMaxTargets 目标数上限：本地（terminal.MaxSessions()，可配化
// P-20261006-12 起为函数——rebase 适配）+ 远程（remoteterminal.DefaultSessionLimit）
// 两会话硬上限之和——超过必然有 id 不在册，早失败优于静默跳过
// （broadcastMaxIDs 同口径）；const 改函数以取运行时生效配置值
func fleetRunMaxTargets() int {
	return terminal.MaxSessions() + remoteterminal.DefaultSessionLimit
}

// 执行参数边界。超时缺省 120s（提案值：部署序列类步骤比单台 30s 档更长，
// 保守默认+请求可覆盖+矩阵格标注三重缓解误判）；钳制沿 runbook run 既有档；
// 步间间隔沿降级连发档（同 runbookRunGapMs 值）。
const (
	fleetRunStepTimeoutDefault = 120 * time.Second
	fleetRunStepGap            = 350 * time.Millisecond
	// fleetRunRetainTtl 终态后注册表保留窗（中止/重试与矩阵回看窗口；
	// deploy taskRetainTtl 同档）
	fleetRunRetainTtl = time.Hour
)

// fleetRunRequest POST /api/runbooks/:id/fleet-run 请求体
type fleetRunRequest struct {
	// Params 占位符供参（与单会话 run 同语义：缺参 400 带缺失清单）
	Params map[string]string `json:"params"`
	// TargetIDs 目标会话清单（本地+远程混合 id，去重保序）：全须在册——
	// 不在册 400 fleet.targets_not_found 带清单（编排是「每步都打全量」，
	// 缺席目标每步都缺席，开跑前早失败优于逐格 missing 噪声）
	TargetIDs []string `json:"targetIds"`
	// OnFailure 覆盖书的失败语义（同单会话 run："" 沿书定义，再缺省 continue）
	OnFailure string `json:"onFailure"`
	// StepTimeoutMs 单步每目标 D 帧等待上限覆盖（毫秒）：0 = 缺省 120s；越界钳制
	StepTimeoutMs int `json:"stepTimeoutMs"`
}

// fleetTargetCell 矩阵单格：某步在某目标的执行结果
type fleetTargetCell struct {
	ID string `json:"id"`
	// Status done | failed | skipped | aborted（skipped=stop/中止后未发送；
	// aborted=用户中止时未收敛）
	Status string `json:"status"`
	// ExitCode 退出码；nil = 无判据（noSignal / timedOut / skipped / aborted）
	ExitCode *int `json:"exitCode,omitempty"`
	// TimedOut 有信号但等待超时（命令可能仍在跑，按 CMD_TIMEOUT 惯例视为完成）
	TimedOut bool `json:"timedOut,omitempty"`
	// NoSignal 无 OSC133 确认信号（裸 sh / 远程终端）：成败不可判定，诚实降级
	NoSignal bool `json:"noSignal,omitempty"`
	// Error 写入失败短语（会话已关/PTY 断），诊断面不入判据
	Error string `json:"error,omitempty"`
}

// fleetRunStepResult 单步 × 全目标（响应 data.steps 元素）
type fleetRunStepResult struct {
	Index       int               `json:"index"`
	Command     string            `json:"command"` // 插值后实际执行的命令
	Description string            `json:"description,omitempty"`
	Status      string            `json:"status"` // done | failed | skipped | aborted
	Targets     []fleetTargetCell `json:"targets"`
}

// fleetRunResult 执行结果（HTTP 响应 data；同步执行，返回即终态）
type fleetRunResult struct {
	RunID     string               `json:"runId"`
	BookID    string               `json:"bookId"`
	Title     string               `json:"title"`
	TargetIDs []string             `json:"targetIds"`
	OnFailure string               `json:"onFailure"`
	Status    string               `json:"status"` // completed | failed | aborted
	Steps     []fleetRunStepResult `json:"steps"`
}

// fleetTarget 执行目标抽象（单测伪会话注入形态）：本地/远程会话各经薄适配器
// 满足——本地转发既有等待原语；远程等待/帧判据恒「无信号」（写入通道是
// SSH stdin 中继，确认信号不回传），引擎按诚实边界降级，不为远程编造判据
type fleetTarget interface {
	TargetID() string
	WriteInput(data []byte) error
	WaitCommandExit(timeout time.Duration) (int, bool)
	OscFramesSeen() bool
}

// localFleetTarget 本地会话适配器：原语同名直通（*terminal.Session 已有全套
// OSC 133 等待面，包一层统一 TargetID 取法——Session.ID 是导出字段非方法）
type localFleetTarget struct{ s *terminal.Session }

func (t localFleetTarget) TargetID() string                            { return t.s.ID }
func (t localFleetTarget) WriteInput(data []byte) error                { return t.s.WriteInput(data) }
func (t localFleetTarget) WaitCommandExit(d time.Duration) (int, bool) { return t.s.WaitCommandExit(d) }
func (t localFleetTarget) OscFramesSeen() bool                         { return t.s.OscFramesSeen() }

// remoteFleetTarget 远程会话适配器：WriteInput 同名直通；等待/帧判据恒「无」
// （远程输出流不经本进程 OSC 解析——降级语义在接口边界一次性收敛）
type remoteFleetTarget struct{ s *remoteterminal.Session }

func (t remoteFleetTarget) TargetID() string                          { return t.s.ID }
func (t remoteFleetTarget) WriteInput(data []byte) error              { return t.s.WriteInput(data) }
func (t remoteFleetTarget) WaitCommandExit(time.Duration) (int, bool) { return 0, false }
func (t remoteFleetTarget) OscFramesSeen() bool                       { return false }

// resolveFleetTargets 目标解析：本地优先（term-* 前缀）查无再查远程
// （32 hex 随机 id，不同源无碰撞——broadcastMixed 同款二段查序）。
// 返回 (targets, missing)：missing 非空由调用方 400 早失败
func resolveFleetTargets(ids []string) ([]fleetTarget, []string) {
	targets := make([]fleetTarget, 0, len(ids))
	missing := []string{}
	for _, id := range ids {
		if s := terminal.DefaultManager.GetSession(id); s != nil {
			targets = append(targets, localFleetTarget{s})
			continue
		}
		if rm := remoteterminal.GetManager(); rm != nil {
			if s := rm.GetSession(id); s != nil {
				targets = append(targets, remoteFleetTarget{s})
				continue
			}
		}
		missing = append(missing, id)
	}
	return targets, missing
}

// fleetRunState 一次舰队运行的注册表条目。引擎在 HTTP handler 内同步推进，
// 中止/重试来自另一个请求——共享态收敛在这里；steps/Status 等可变字段全部
// 经 mu 读写（引擎写格在持 mu 外进行，但 abort/retry 观察侧都以 abortAck
// /finished 为先后屏障——见各方法注记的内存序论证）
type fleetRunState struct {
	mu          sync.Mutex
	runID       string
	bookID      string
	title       string
	commands    []string // 插值后（重试按格重发，不依赖书存档——书可中途被删）
	steps       []store.RunbookStep
	onFailure   string
	stepTimeout time.Duration
	targetIDs   []string
	matrix      []fleetRunStepResult
	status      string // running | completed | failed | aborted
	stepNames   []string
	abortCh     chan struct{}
	abortOnce   sync.Once
	// abortAck 引擎终态收口时关闭——abort handler 据此同步回终态矩阵
	//（响应即结果，前端免二次轮询）；close 用 ackOnce 防终态/中止双路竞态
	abortAck chan struct{}
	ackOnce  sync.Once
	finished bool
	retrying bool // 单飞重试闸：一次一个格在重（矩阵一致性）
	lastUse  time.Time
}

// fleetRunRegistry 进程内注册表：runId → 状态（中止/重试寻址面）。重启即清
var (
	fleetRunRegMu sync.Mutex
	fleetRunReg   = map[string]*fleetRunState{}
)

// registerFleetRun 登记新 run 并顺带惰性清扫过期终态（无 ticker：登记频率
// 即清扫频率，运行书执行是低频人工/编排动作，量级恒小）
func registerFleetRun(st *fleetRunState) {
	fleetRunRegMu.Lock()
	defer fleetRunRegMu.Unlock()
	now := time.Now()
	for id, old := range fleetRunReg {
		old.mu.Lock()
		expired := old.finished && now.Sub(old.lastUse) > fleetRunRetainTtl
		old.mu.Unlock()
		if expired {
			delete(fleetRunReg, id)
		}
	}
	fleetRunReg[st.runID] = st
}

// lookupFleetRun 按 runId 取注册表条目（TTL 过期/重启后 = 不在册，404 同语义）
func lookupFleetRun(runID string) *fleetRunState {
	fleetRunRegMu.Lock()
	defer fleetRunRegMu.Unlock()
	return fleetRunReg[runID]
}

// requestAbort 请求中止：幂等（close(abortCh) 经 once）。返回是否已终态
// （已终态则引擎早已退出，handler 无需等 ack）
func (st *fleetRunState) requestAbort() (alreadyFinished bool) {
	st.mu.Lock()
	finished := st.finished
	st.mu.Unlock()
	if finished {
		return true
	}
	st.abortOnce.Do(func() { close(st.abortCh) })
	return false
}

// snapshotFleetResult 结果矩阵快照（响应体；拷贝出注册表防与后续 retry 共享
// 可变切片）。运行中调用返回当前进度态（abort 响应在 ack 后调用即终态）
func (st *fleetRunState) snapshotFleetResult() fleetRunResult {
	st.mu.Lock()
	defer st.mu.Unlock()
	steps := make([]fleetRunStepResult, len(st.matrix))
	for i, s := range st.matrix {
		cells := make([]fleetTargetCell, len(s.Targets))
		copy(cells, s.Targets)
		s.Targets = cells
		steps[i] = s
	}
	ids := make([]string, len(st.targetIDs))
	copy(ids, st.targetIDs)
	return fleetRunResult{
		RunID:     st.runID,
		BookID:    st.bookID,
		Title:     st.title,
		TargetIDs: ids,
		OnFailure: st.onFailure,
		Status:    st.status,
		Steps:     steps,
	}
}

// RunFleetRunbook POST /api/runbooks/:id/fleet-run —— 舰队运行书执行
func RunFleetRunbook(c *gin.Context) {
	id := c.Param("id")
	if !runbookIDRe.MatchString(id) {
		shared.Error(c, http.StatusNotFound, "runbook not found", nil)
		return
	}
	var req fleetRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeRunbookPayloadInvalid, "runbook run failed", err)
		return
	}
	book, err := store.Get().Runbook.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "runbook not found", nil)
		return
	}

	// 失败语义与单会话 run 同层级：请求覆盖 > 书定义 > continue
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

	stepTimeout := fleetRunStepTimeoutDefault
	if req.StepTimeoutMs > 0 {
		stepTimeout = time.Duration(req.StepTimeoutMs) * time.Millisecond
		if stepTimeout < runbookRunStepTimeoutMin {
			stepTimeout = runbookRunStepTimeoutMin
		}
		if stepTimeout > runbookRunStepTimeoutMax {
			stepTimeout = runbookRunStepTimeoutMax
		}
	}

	// 参数校验先行（与单会话 run 同链）：缺失清单 400 可行动
	required := runbookRequiredParams(book.Steps)
	missingParams := make([]string, 0, len(required))
	for _, name := range required {
		if v, ok := req.Params[name]; !ok || strings.TrimSpace(v) == "" {
			missingParams = append(missingParams, name)
		}
	}
	if len(missingParams) > 0 {
		shared.JSONWithCode(c, shared.CodeRunbookParamsMissing, gin.H{
			"error":   "missing params: " + strings.Join(missingParams, ", "),
			"missing": missingParams,
		})
		return
	}
	commands := make([]string, len(book.Steps))
	for i, s := range book.Steps {
		commands[i] = interpolateRunbookTemplate(s.Command, req.Params)
	}

	// 目标清单：去重保序（BroadcastWrite 同防：重复勾选只算一台）；空/超限早失败
	ids := dedupeFleetIDs(req.TargetIDs)
	if len(ids) == 0 {
		shared.ErrorWithCode(c, shared.CodeFleetTargetsRequired, "targetIds is required", nil)
		return
	}
	if len(ids) > fleetRunMaxTargets() {
		shared.ErrorWithCode(c, shared.CodeFleetTargetsTooMany, "too many targetIds", nil)
		return
	}

	// 同书互斥与单会话 run 共表（舰队跑和单台跑同书并发无合理语义）；
	// 判定先于目标解析（runbook run 同序，409 语义测试对齐）
	runID, ok := admitRunbookRun(book.ID)
	if !ok {
		shared.ErrorWithCode(c, shared.CodeRunbookBusy, "runbook already running", nil)
		return
	}
	defer releaseRunbookRun(book.ID, runID)

	targets, missing := resolveFleetTargets(ids)
	if len(missing) > 0 {
		shared.JSONWithCode(c, shared.CodeFleetTargetsNotFound, gin.H{
			"error":   "target sessions not found: " + strings.Join(missing, ", "),
			"missing": missing,
		})
		return
	}

	st := &fleetRunState{
		runID:       "frb_" + strings.TrimPrefix(runID, "rb_run_"),
		bookID:      book.ID,
		title:       book.Title,
		commands:    commands,
		steps:       book.Steps,
		onFailure:   onFailure,
		stepTimeout: stepTimeout,
		targetIDs:   ids,
		matrix:      make([]fleetRunStepResult, len(commands)),
		status:      "running",
		abortCh:     make(chan struct{}),
		abortAck:    make(chan struct{}),
		lastUse:     time.Now(),
	}
	registerFleetRun(st)

	result := executeFleetRun(st, targets)
	auditFleetRunbookRun("run", st, result.Status == "completed",
		fmt.Sprintf("targets=%d steps=%d", len(ids), len(commands)))
	c.JSON(http.StatusOK, gin.H{"data": result})
}

// dedupeFleetIDs 目标 id 去重保序（同 id 重复出现只算一台，防每步双跑）
func dedupeFleetIDs(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// executeFleetRun 执行主链：逐步「写入全目标 → 并发等各目标终态 → 聚合 →
// onFailure 分流」。矩阵逐步落 st.matrix（abort/retry 响应与进度事件同源）。
// targets 与 st.targetIDs 同序（resolve 保序）。本函数是引擎唯一写 matrix 的
// goroutine；abort 观察侧以 abortAck 关闭为屏障（close happens-after 全部
// 写格，handler 收到 ack 后才快照——mutex 补齐可见性）
func executeFleetRun(st *fleetRunState, targets []fleetTarget) *fleetRunResult {
	n := len(st.commands)
	names := runbookStepDisplayNames(st.steps, st.commands)
	anyFailed := false
	st.mu.Lock()
	st.stepNames = names
	st.mu.Unlock()

	publishFleetProgress(st, "running",
		fmt.Sprintf("fleet run start (%d targets × %d steps)", len(targets), n), "start", -1, 0, nil)

	for i := 0; i < n; i++ {
		// 步间最小间隔（广播风暴护栏）：给 N 台 shell 吞行留缝；间隔内可中止
		//（select 双路，不烧满间隔才响应中止）
		if i > 0 {
			select {
			case <-st.abortCh:
			case <-time.After(fleetRunStepGap):
			}
		}
		if isAborted(st) {
			markFleetTail(st, i, "aborted")
			return finishFleetRun(st, "aborted", i, names)
		}

		step := &st.matrix[i]
		step.Index = i
		step.Command = st.commands[i]
		if i < len(st.steps) {
			step.Description = st.steps[i].Description
		}
		step.Targets = make([]fleetTargetCell, len(targets))

		// 写入段：逐目标顺序写（BroadcastWrite 同量级——一次进 PTY/SSH 缓冲的
		// 内存写）；写失败只判该格 failed 不拖累其余目标（舰队逐会话跳过语义）。
		// 命令恒写入——无 OSC133 与否不做写前判定：刚建好的集成会话在首个提示符
		// 渲染前同样一帧未见（启动期 D 被抑制），写前跳过会把真命令吞掉谎报
		// done（e2e 实测踩坑）；降级分类推迟到等待超时后按帧判据给出
		//（applyFleetOutcome：有帧=timedOut / 全程无帧=noSignal）
		pending := make([]int, 0, len(targets))
		for ti, t := range targets {
			cell := &step.Targets[ti]
			cell.ID = t.TargetID()
			if err := t.WriteInput([]byte(st.commands[i] + "\r")); err != nil {
				cell.Status = "failed"
				cell.Error = "write failed"
				continue
			}
			pending = append(pending, ti)
		}

		// 等待段：并发等各目标 D 帧（buffered chan 收口——中止后遗留 goroutine
		// 把结果丢进缓冲即退出，无泄漏；作废结果不入格）
		type waitOutcome struct {
			ti   int
			code int
			ok   bool
		}
		outcomes := make(chan waitOutcome, len(pending))
		for _, ti := range pending {
			go func(k int, t fleetTarget) {
				code, ok := t.WaitCommandExit(st.stepTimeout)
				outcomes <- waitOutcome{ti: k, code: code, ok: ok}
			}(ti, targets[ti])
		}
		settled := make(map[int]waitOutcome, len(pending))
		aborted := false
		for len(settled) < len(pending) && !aborted {
			select {
			case o := <-outcomes:
				settled[o.ti] = o
			case <-st.abortCh:
				aborted = true
			}
		}
		// 先落已收敛格的真实结果（判据已到手，中止也不作废——作废才是造假）
		for ti, o := range settled {
			applyFleetOutcome(&step.Targets[ti], targets[ti], o.code, o.ok)
		}
		if aborted {
			// 中止：未收敛目标广播 Ctrl+C（\x03）后记 aborted；整步定性 aborted
			//（已收敛格保留 done/failed 真实结果——判据已到手不作废）
			for _, ti := range pending {
				if _, ok := settled[ti]; ok {
					continue
				}
				_ = targets[ti].WriteInput([]byte{0x03})
				step.Targets[ti].Status = "aborted"
			}
			step.Status = "aborted"
			publishFleetProgress(st, "aborted",
				fmt.Sprintf("aborted at step %d/%d", i+1, n), "step", i, i, step.Targets)
			markFleetTail(st, i+1, "aborted")
			return finishFleetRun(st, "aborted", i, names)
		}

		// 聚合段：任一格 failed → 步 failed → onFailure 分流
		stepFailed := false
		for ti := range step.Targets {
			if step.Targets[ti].Status == "failed" {
				stepFailed = true
				break
			}
		}
		if stepFailed {
			step.Status = "failed"
			anyFailed = true
		} else {
			step.Status = "done"
		}
		publishFleetProgress(st, "running",
			fmt.Sprintf("step %d/%d %s (%s)", i+1, n, fleetStepShortStatus(step), names[i]),
			"step", i, i+1, step.Targets)

		if stepFailed && st.onFailure == "stop" {
			// 停 = 中止全书（提案语义）：后续步骤全部 skipped，哪台哪步看矩阵
			markFleetTail(st, i+1, "skipped")
			return finishFleetRun(st, "failed", i, names)
		}
	}
	// continue 档全程跑完：有过失败格 → failed（如实记录不虚报 completed，
	// 单会话 run 同口径），全绿才算 completed
	final := "completed"
	if anyFailed {
		final = "failed"
	}
	return finishFleetRun(st, final, n, names)
}

// applyFleetOutcome 把一次等待结果落格：ok=true 按 D 帧退出码判 done/failed；
// ok=false（超时）按帧判据诚实分类——生命周期内见过帧 = 有集成、命令仍在跑，
// 按 CMD_TIMEOUT 惯例视为完成（timedOut，迟到 D 不再消费，单会话 run 同边界）；
// 全程无任何帧 = 无 OSC133 确认信号（裸 sh/远程终端），成败不可判定，
// 视为完成 + noSignal 诚实降级。判据在落格时刻现取（帧可能迟于写入到达——
// 刚建好的集成会话首命令期间帧才出现，写前判定会误降级）
func applyFleetOutcome(cell *fleetTargetCell, t fleetTarget, code int, ok bool) {
	if ok {
		cell.ExitCode = &code
		if code != 0 {
			cell.Status = "failed"
		} else {
			cell.Status = "done"
		}
		return
	}
	cell.Status = "done"
	if t.OscFramesSeen() {
		cell.TimedOut = true
	} else {
		cell.NoSignal = true
	}
}

// execFleetCell 单格执行（重试路径）：写入 → 等待 → 按帧判据分类。
// 与主链逐目标分支同语义（降级/写失败/退出码），收敛一处防漂移；命令恒写入
// （写前无信号判定会吞掉首提示符未渲染的集成会话命令——executeFleetRun 同坑）
func execFleetCell(t fleetTarget, cmd string, timeout time.Duration) fleetTargetCell {
	var cell fleetTargetCell
	if err := t.WriteInput([]byte(cmd + "\r")); err != nil {
		cell.Status = "failed"
		cell.Error = "write failed"
		return cell
	}
	code, ok := t.WaitCommandExit(timeout)
	applyFleetOutcome(&cell, t, code, ok)
	return cell
}

// finishFleetRun 终态收口：注册表落终态（关 abortAck 唤醒 abort handler——
// close happens-after 全部写格）+ 终态进度广播。doneCount 给进度清单
// 「完成几步」（stop 停在失败项时失败步不算 done，单会话 run 同口径）
func finishFleetRun(st *fleetRunState, status string, doneCount int, names []string) *fleetRunResult {
	st.mu.Lock()
	st.status = status
	st.finished = true
	st.lastUse = time.Now()
	st.mu.Unlock()
	st.ackOnce.Do(func() { close(st.abortAck) })

	msg := fmt.Sprintf("fleet run %s (%d steps)", status, len(st.commands))
	if status != "completed" && doneCount > 0 && doneCount < len(st.commands) {
		msg = fmt.Sprintf("%s at step %d/%d", map[string]string{"failed": "stopped", "aborted": "aborted"}[status], doneCount+1, len(st.commands))
	}
	publishFleetProgress(st,
		map[string]string{"completed": "done", "failed": "failed", "aborted": "aborted"}[status],
		msg, "final", doneCount-1, doneCount, nil)
	return func() *fleetRunResult { r := st.snapshotFleetResult(); return &r }()
}

// markFleetTail 终止步之后的余下步骤整行落给定状态（未发送即未执行，响应面
// 不留给零值空态——skipRunbookTail 的矩阵版）
func markFleetTail(st *fleetRunState, from int, status string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	for j := from; j < len(st.matrix); j++ {
		cells := make([]fleetTargetCell, len(st.targetIDs))
		for ti := range cells {
			cells[ti] = fleetTargetCell{ID: st.targetIDs[ti], Status: status}
		}
		st.matrix[j] = fleetRunStepResult{
			Index:   j,
			Command: st.commands[j],
			Status:  status,
			Targets: cells,
		}
	}
}

// isAborted 步进间中止探测（间隔 select 已消费 abortCh 场景之外的步首兜底）
func isAborted(st *fleetRunState) bool {
	select {
	case <-st.abortCh:
		return true
	default:
		return false
	}
}

// fleetStepShortStatus 步进进度短状态词（有失败格即 failed，否则 done）
func fleetStepShortStatus(s *fleetRunStepResult) string {
	for _, c := range s.Targets {
		if c.Status == "failed" {
			return "failed"
		}
	}
	return "done"
}

// publishFleetProgress 舰队进度广播（task.progress 批形态）：无 terminalId
// 归属（舰队不属于任何单会话——值班大屏落全局兜底卡，悬浮球全局态），
// fleet 扩展对象携带矩阵合并所需的最小增量：
//
//	phase=start  targetIds（列序）+ stepNames（行序）——前端据此建骨架
//	phase=step   stepIndex + results（本步逐目标格）——前端按（行,目标id）合并
//	phase=final  status 终态（done|failed|aborted）
//
// 既有消费方（悬浮球/大屏/agent-tasks 落库）不识别 fleet 字段即忽略（发布
// 契约增量扩展，runbook run 的 runId/bookId 扩展同款）
func publishFleetProgress(st *fleetRunState, status, stepText, phase string, stepIdx, doneCount int, cells []fleetTargetCell) {
	st.mu.Lock()
	names := st.stepNames
	st.mu.Unlock()
	steps := make([]map[string]interface{}, 0, len(names))
	for i, name := range names {
		if i >= 20 {
			break
		}
		steps = append(steps, map[string]interface{}{"name": name, "done": i < doneCount})
	}
	fleet := gin.H{
		"phase":     phase,
		"stepIndex": stepIdx,
		"stepTotal": len(st.commands),
		"targetIds": st.targetIDs,
	}
	if phase == "start" {
		fleet["stepNames"] = names
	}
	if cells != nil {
		// 广播载荷必须深拷贝：hub 单 goroutine 异步 json.Marshal（无锁，
		// opschannel.go broadcast），而 results 传入的 step.Targets 底层数组
		// 会被后续单台重试原位覆写（applyFleetRetryCell）——发布别名共享
		// 数组 = 跨 goroutine 数据竞态（Linux -race 实测：hub Marshal 读 vs
		// retry 写同一格）。拷贝含 ExitCode 指针克隆（快照语义非别名语义）
		copied := make([]fleetTargetCell, len(cells))
		for i, c := range cells {
			if c.ExitCode != nil {
				code := *c.ExitCode
				c.ExitCode = &code
			}
			copied[i] = c
		}
		fleet["results"] = copied
	}
	opschannel.BroadcastEvent(opschannel.EventTaskProgress, gin.H{
		"task":   "fleet runbook: " + st.title,
		"status": status,
		"step":   stepText,
		"steps":  steps,
		"runId":  st.runID,
		"bookId": st.bookID,
		"fleet":  fleet,
	})
}

// FleetAbort POST /api/runbooks/:id/fleet-abort {"runId"} —— 手动中止：
// 未完成目标广播 Ctrl+C（\x03），引擎落账 aborted 格后同步回终态矩阵。
// 已终态 run 幂等回快照（前端重复点中止不报错）
func FleetAbort(c *gin.Context) {
	var req struct {
		RunID string `json:"runId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.RunID) == "" {
		shared.ErrorWithCode(c, shared.CodeRunbookPayloadInvalid, "runId is required", err)
		return
	}
	st := lookupFleetRun(strings.TrimSpace(req.RunID))
	if st == nil {
		shared.ErrorWithCode(c, shared.CodeFleetRunNotFound, "fleet run not found (expired or restarted)", nil)
		return
	}
	if !st.requestAbort() {
		// 引擎落账 ack（abortCh 已闭，等待/步进路径任一先到都会走到终态收口；
		// 已终态则 ack 已闭立返）。有界等待：引擎异常卡死也不挂死响应
		select {
		case <-st.abortAck:
		case <-time.After(10 * time.Second):
		}
	}
	res := st.snapshotFleetResult()
	auditFleetRunbookRun("abort", st, true, fmt.Sprintf("targets=%d abortStatus=%s", len(res.TargetIDs), res.Status))
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// FleetRetry POST /api/runbooks/:id/fleet-retry {"runId","stepIndex","targetId"}
// —— 失败步单台重试：仅终态 run 可重试（运行中矩阵在变化，409 挡并发改写）；
// 只重发该格命令到该目标并重新等待，其余格原样保留。skipped 格不可重试
// （「未发送」的补跑是重跑全书/按步发送的语义，不在单格重试面）
func FleetRetry(c *gin.Context) {
	var req struct {
		RunID     string `json:"runId"`
		StepIndex int    `json:"stepIndex"`
		TargetID  string `json:"targetId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.RunID) == "" {
		shared.ErrorWithCode(c, shared.CodeRunbookPayloadInvalid, "runId is required", err)
		return
	}
	st := lookupFleetRun(strings.TrimSpace(req.RunID))
	if st == nil {
		shared.ErrorWithCode(c, shared.CodeFleetRunNotFound, "fleet run not found (expired or restarted)", nil)
		return
	}
	st.mu.Lock()
	if !st.finished {
		st.mu.Unlock()
		shared.ErrorWithCode(c, shared.CodeFleetRunBusy, "fleet run still in progress", nil)
		return
	}
	if st.retrying {
		st.mu.Unlock()
		shared.ErrorWithCode(c, shared.CodeFleetRunBusy, "another retry in progress", nil)
		return
	}
	if req.StepIndex < 0 || req.StepIndex >= len(st.matrix) {
		st.mu.Unlock()
		shared.ErrorWithCode(c, shared.CodeRunbookPayloadInvalid, "stepIndex out of range", nil)
		return
	}
	cellIdx := -1
	for ti := range st.matrix[req.StepIndex].Targets {
		if st.matrix[req.StepIndex].Targets[ti].ID == req.TargetID {
			cellIdx = ti
			break
		}
	}
	if cellIdx < 0 {
		st.mu.Unlock()
		shared.ErrorWithCode(c, shared.CodeRunbookPayloadInvalid, "targetId not in run", nil)
		return
	}
	cur := st.matrix[req.StepIndex].Targets[cellIdx]
	// 可重试格 = failed / aborted；done 重试防误触双跑（幂等命令也该走重跑全书）
	if cur.Status != "failed" && cur.Status != "aborted" {
		st.mu.Unlock()
		shared.ErrorWithCode(c, shared.CodeFleetCellNotRetryable, "cell is not retryable (failed|aborted only)", nil)
		return
	}
	st.retrying = true
	cmd := st.commands[req.StepIndex]
	timeout := st.stepTimeout
	st.mu.Unlock()

	// 格重执行：重发前重新解析目标（会话可能已被关——缺席/写失败如实回填）
	newCell := fleetTargetCell{ID: req.TargetID}
	targets, missing := resolveFleetTargets([]string{req.TargetID})
	if len(missing) > 0 {
		newCell.Status = "failed"
		newCell.Error = "target session gone"
	} else {
		newCell = execFleetCell(targets[0], cmd, timeout)
		newCell.ID = req.TargetID
	}

	st.applyFleetRetryCell(req.StepIndex, cellIdx, newCell)

	publishFleetProgress(st, "running",
		fmt.Sprintf("retry step %d target %.8s… → %s", req.StepIndex+1, req.TargetID, newCell.Status),
		"step", req.StepIndex, req.StepIndex+1, []fleetTargetCell{newCell})
	auditFleetRunbookRun("retry", st, newCell.Status == "done",
		fmt.Sprintf("step=%d target=%s result=%s", req.StepIndex, req.TargetID, newCell.Status))
	c.JSON(http.StatusOK, gin.H{"data": st.snapshotFleetResult()})
}

// applyFleetRetryCell 落重试格 + 整矩阵状态重算（mu 内一次完成）：无未收敛格
// → completed；残留 aborted 格（曾中止未补齐）→ aborted；残留 failed → failed。
// 步状态随格联动（skipped 行不参与——未发送不属于本次重算面）
func (st *fleetRunState) applyFleetRetryCell(stepIdx, cellIdx int, cell fleetTargetCell) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.matrix[stepIdx].Targets[cellIdx] = cell
	st.retrying = false
	st.lastUse = time.Now()
	unsettledFailed, unsettledAborted := false, false
	for i := range st.matrix {
		s := &st.matrix[i]
		if s.Status == "skipped" || len(s.Targets) == 0 {
			continue
		}
		sFailed := false
		for ti := range s.Targets {
			switch s.Targets[ti].Status {
			case "failed":
				sFailed = true
			case "aborted":
				sFailed = true
				unsettledAborted = true
			}
		}
		if sFailed {
			s.Status = "failed"
			unsettledFailed = true
		} else {
			s.Status = "done"
		}
	}
	switch {
	case unsettledAborted:
		st.status = "aborted"
	case unsettledFailed:
		st.status = "failed"
	default:
		st.status = "completed"
	}
}

// auditFleetRunbookRun 执行/中止/重试审计（fleet.runbook.execute 单一动作族，
// Detail op= 区分）：书/目标数/失败格数元数据——参数值与命令原文不入账
// （单会话 run 同取态），运行现场在目标会话 scrollback
func auditFleetRunbookRun(op string, st *fleetRunState, success bool, extra string) {
	res := st.snapshotFleetResult()
	failedCells, nosignalCells := 0, 0
	for i := range res.Steps {
		for _, c := range res.Steps[i].Targets {
			if c.Status == "failed" {
				failedCells++
			}
			if c.NoSignal {
				nosignalCells++
			}
		}
	}
	store.Get().Audit.Append(store.AuditEvent{
		Action: store.AuditFleetRunbookExecute,
		Result: map[bool]string{true: store.AuditResultSuccess, false: store.AuditResultFailure}[success],
		Detail: fmt.Sprintf("op=%s run=%s book=%s title=%q %s failedCells=%d nosignalCells=%d status=%s",
			op, st.runID, st.bookID, st.title, extra, failedCells, nosignalCells, res.Status),
	})
}
