package terminal

import (
	"bytes"
	"encoding/base64"
	"strconv"
	"sync"
	"time"
)

// OSC 133 运行态追踪（P-20261004-63）：服务端权威的「会话里有没有命令在跑」。
//
// 动机：Agent Token 轮换/撤销警示此前读前端 runningMap（纯浏览器快照，只由
// 持有连接的宿主写入）——手机上轮换 token 时，桌面正在跑命令的 agent 会话
// 不在警示计数里，安全决策建立在单设备视角上。本文件在 readLoop 字节源头
// 做 C/D 帧旁挂识别（devPort/sentinel 同挂点第三旁挂），会话运行态首次成为
// 服务端事实，跨设备可查（GET /api/terminals/running-count，消费位见 API 层
// running_count.go）。前端 runningMap 语义不动：双轨并存，服务端为权威补充。
//
// 帧形态（shellint/bash.sh 注入）：
//   \x1b]133;C\x07                     命令开始（运行点亮）
//   \x1b]133;D;<exit>;<durationMs>\x07 命令结束（熄灭）
//   \x1b]133;E;<base64>\x07 等          命令文本/重放边界/提示符——不影响运行态
//   tmux DCS 包装（$TMUX 内）：\x1bPtmux;\x1b\x1b]133;C\x07\x1b\\——内层 ESC
//   双倍化后 \x1b]133; 子序列依然成立且 BEL 终止符不变，字节扫描天然命中
//   （与前端重组器对包装形态的隐式处理同款；tmux attach 路径经 allow-passthrough
//   解包后到达的已是裸帧，包装形态属防御性兼容）
//
// 性能护栏（输出流是热路径，与 portdetect/sentinel 同路数）：
//   - 无 ESC 尾迹的普通块只付一次 bytes.Index（子串 miss），零分配；
//   - 跨块未终结帧只暂存帧头到块尾的短尾段（C/D payload 定长小帧，见
//     oscPendingCap——E 帧 8KB base64 超限即放弃暂存，E 本就不改运行态）；
//   - C/D 是命令边界级低频事件，状态更新量级可忽略。
//
// 注记（不实现，留扩展点）：
//   - MVP 不广播运行态变化——C/D 对单会话是低频事件但对全体会话是高频流，
//     拉取式（警示确认框打开时 + agent 自查时）已覆盖两个消费位；
//   - 前端停滞检测（utils/session-idle.ts，P-20261003-53）未来可服务端化，
//     本状态即其数据面（不动其本体）。
//
// 诚实边界：运行态只覆盖本进程见过的帧——shell 集成未注入（powershell 场景
// 由 powershell.ps1 注入同款帧）/ 重启恢复的 tmux 会话重启前已开始的命令
// （C 帧在重启前）不在计数（宁漏报不误报）；重启前已在跑的长任务由前台
// 进程探测（running.go，unix）互补，两信号口径独立。

const (
	// osc133Header OSC 133 帧头：ESC ] 1 3 3 ;
	osc133Header = "\x1b]133;"
	// oscBEL 帧终止符 BEL（shellint printf \007）
	oscBEL byte = 0x07
	// oscPendingCap 跨块暂存尾段的 payload 字节上限：C/D payload 实际
	// 「D;<exit>;<durationMs>」≤ 30 字节，富余量覆盖慢速分片；E 帧 payload
	// 以 8KB base64 为主，超限即放弃暂存（不改运行态，丢弃无损）
	oscPendingCap = 64
	// cmdWindowCap 每会话保留的最近命令窗条数（P-20261005-170 fsattribution
	// 消费）：归因查询只看「刚刚」，环形小窗足够；会话量级 ≤ MaxSessions，
	// 全局内存有界（16 × MaxSessions 条）
	cmdWindowCap = 16
	// cmdTextKeep E 帧命令文本在窗内的保留字节数：归因账只需「命令摘要」，
	// 完整文本（≤8KB）归命令历史（前端上报链），此处截断防环形窗膨胀
	cmdTextKeep = 512
)

// CmdWindow 单条命令的运行时间窗（P-20261005-170）：C 帧点亮到 D 帧熄灭，
// fsattribution 用「watcher 事件时刻落在哪个会话的窗内」回答「文件被哪条
// 命令改的」。窗口随环形裁剪消亡——归因账（落盘侧）记的是事件发生当时
// 的判定结果，此处只是判定数据面，不做长期留存
type CmdWindow struct {
	Start    time.Time // C 帧到达时刻
	End      time.Time // D 帧到达时刻；Open=true 时零值（命令仍在跑）
	ExitCode int       // D 帧退出码；Open=true 时无意义
	Command  string    // E 帧命令文本摘要（≤cmdTextKeep 字节；无 E 帧为空）
	Open     bool      // true = C 已见 D 未至（命令仍在运行）
}

// oscStateDetector 会话级 OSC 133 运行态：跨块未终结帧尾段 + 运行态布尔 +
// 最近命令时刻 + D 帧等待者（P-20261004-108）。仅 readLoop 单 goroutine 写入
// （feed），读侧 Manager.RunningCount 与 WaitDFrame 并发——锁护状态，pending
// 单写者理论可裸奔、并入同锁省一道心智负担
type oscStateDetector struct {
	mu        sync.Mutex
	pending   []byte    // 上一块尾部的未终结帧头段（≤ len(osc133Header)+oscPendingCap）
	running   bool      // 最近一次 C/D 判定：true=C 已见 D 未至
	lastCmdAt time.Time // 最近命令时刻（C=命令开始 / D=命令结束，取到达时点）
	// sawFrame 会话生命周期内是否见过任何 C/D 帧（P-20261004-108）：shell
	// 集成在位判据——服务端运行书执行链首轮等待超时且从未见帧 = 集成缺失，
	// 与前端 useRunbookRunner 的 degraded 判定同源（宁降级不虚报）
	sawFrame bool
	// windows 最近命令窗环形（P-20261005-170，旧→新）：C 开窗 / D 闭窗 /
	// E 记命令文本。fsattribution 归因查询的消费面，见 CmdWindow 注记
	windows []CmdWindow
	// pendingCmd 先到的 E 帧命令文本暂存：powershell.ps1 的 E 在 C 之前
	// 发（Enter 处理器里 E→C），bash.sh 的 C 在 E 之前（DEBUG trap）——
	// 两 shell 集成帧序相反，窗与文本的绑定必须两序都成立。C 到点时若有
	// 暂存即随窗落账；E 到点时窗已开则直写，两序之外（E 晚于 D）丢弃
	pendingCmd string
	// cmdActive 当前 D 帧是否在 C 之后（P-20261004-108 等待原语的归属闸）：
	// shellint 在**每次提示符渲染前**都发 D（含 shell 启动后首个 prompt 的
	// D;0——powershell.ps1 prompt 函数/bash precmd 同款），它前面是 A 不是 C。
	// 等待方要的是「命令结束」，只有 C 之后到达的 D 才投递，否则启动期 D 帧
	// 会把整条退出码等待链错位一格（实测：步骤 N 收到步骤 N-1 的退出码）
	cmdActive bool
	// dWaiters D 帧等待者表（P-20261004-108 运行书退出码等待原语）：等待方
	// 注册带缓冲 channel，feed 在 D 帧点非阻塞投递退出码。等待是命令级短周期
	// 事件（写命令前后各一行代码），条目随等待结束删除，无长期驻留
	dWaiters     map[int64]chan int
	nextWaiterID int64
}

// newOscStateDetector 构造会话运行态探测器（会话创建/重启恢复三路构造点均需
// 初始化，与 devPort/sentinel 同款；随 Session 生命周期 GC，无独立清理路径）
func newOscStateDetector() *oscStateDetector {
	return &oscStateDetector{}
}

// feed 处理一段 PTY 输出：识别其中全部完整 C/D 帧并推进状态。无完整帧时
// 只做一次子串扫描，常态输出（纯文本/着色文本）零分配
func (d *oscStateDetector) feed(data []byte) {
	if len(data) == 0 {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()

	buf := data
	if len(d.pending) > 0 {
		// 拼接上一块尾段（拷贝出新缓冲：d.pending 与 data 都不可变写）
		combined := make([]byte, 0, len(d.pending)+len(data))
		combined = append(combined, d.pending...)
		combined = append(combined, data...)
		buf = combined
		d.pending = nil
	}

	pos := 0
	for {
		idx := bytes.Index(buf[pos:], []byte(osc133Header))
		if idx < 0 {
			break
		}
		start := pos + idx
		rest := buf[start+len(osc133Header):]
		bel := bytes.IndexByte(rest, oscBEL)
		esc := bytes.IndexByte(rest, 0x1b)
		if bel < 0 || (esc >= 0 && esc < bel) {
			// 无 BEL 终止：
			//   - esc 先至 = 帧被 ESC 截断（异常流/包装层碎片），本帧作废，
			//     从该 ESC 续扫（它可能是下一序列的起点，含 DCS 包装的双倍 ESC）
			//   - 纯无终止 = 帧体跨块，短尾段暂存待下一块拼接（超长按 E 帧
			//     形态放弃——见 oscPendingCap 注记）
			if esc >= 0 {
				pos = start + len(osc133Header) + esc + 1
				continue
			}
			if len(rest) <= oscPendingCap {
				d.pending = append(d.pending[:0], buf[start:]...)
			}
			break
		}
		// 完整帧：类型字符 = payload 首字节；非 C/D/E（R/A 等）跳过不改运行态
		if payload := rest[:bel]; len(payload) > 0 {
			switch payload[0] {
			case 'C':
				d.running = true
				d.lastCmdAt = time.Now()
				d.sawFrame = true
				d.cmdActive = true
				d.openCmdWindow()
			case 'D':
				d.running = false
				d.lastCmdAt = time.Now()
				d.sawFrame = true
				if d.cmdActive {
					// 仅 C 之后的 D 是「命令结束」：提示符渲染前的启动期 D
					// （前面是 A）不投递等待方，见 cmdActive 注记
					d.dispatchDFrame(parseOscDExit(payload))
				}
				d.closeCmdWindow(parseOscDExit(payload))
				d.cmdActive = false
			case 'E':
				// E 帧（命令文本 base64）：不改运行态，只为命令窗落账文本
				// （P-20261005-170）。解码失败按无文本处理——归因账少个摘要
				// 无损，窗归属不依赖它
				if cmd, err := base64.StdEncoding.DecodeString(string(payload[2:])); err == nil && len(cmd) > 0 {
					d.noteCmdText(string(cmd))
				}
			}
		}
		pos = start + len(osc133Header) + bel + 1
	}

	// 块尾可能截在帧头中间（\x1b / \x1b] / \x1b]1 …）：按帧头前缀匹配暂存，
	// 与前端 splitPendingTail 同判据。分叉（ESC 后接非帧头字节）不暂存
	d.holdHeaderPrefix(buf[pos:])
}

// holdHeaderPrefix 检查尾段是否以帧头前缀开头（从段内最后一个 ESC 起），
// 是则暂存待下一块拼接。主循环已暂存的未终结帧不会被此处覆盖：那种尾段以
// 完整帧头开头（比帧头长），HasPrefix 判否自然落空
func (d *oscStateDetector) holdHeaderPrefix(tail []byte) {
	if len(tail) == 0 {
		return
	}
	esc := bytes.LastIndexByte(tail, 0x1b)
	if esc < 0 {
		return
	}
	if bytes.HasPrefix([]byte(osc133Header), tail[esc:]) {
		d.pending = append(d.pending[:0], tail[esc:]...)
	}
}

// snapshot 当前运行态（running, lastCmdAt）。零值探测器（裸构造测试会话）
// 返回 (false, 零时刻)——调用方把零时刻当「无命令记录」处理
func (d *oscStateDetector) snapshot() (bool, time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.running, d.lastCmdAt
}

// parseOscDExit 从 D 帧 payload「D;<exit>;<durationMs>」解析退出码。
// 形态异常（无分节/非数字）回 0：D 帧本身即「命令已结束」事实，退出码缺失
// 不该让等待方误判超时（与前端 OscEvent.exitCode ?? 0 同口径）
func parseOscDExit(payload []byte) int {
	rest, ok := bytes.CutPrefix(payload[1:], []byte(";")) // 跳过 'D'
	if !ok {
		return 0
	}
	end := bytes.IndexByte(rest, ';')
	if end >= 0 {
		rest = rest[:end]
	}
	code, err := strconv.Atoi(string(rest))
	if err != nil {
		return 0
	}
	return code
}

// dispatchDFrame 向全部等待者投递 D 帧退出码。channel 带缓冲 1 且只投一次，
// 非阻塞发送在锁内安全（永不阻塞 readLoop）；迟到/已超时的等待方已从表中
// 移除，自然收不到
func (d *oscStateDetector) dispatchDFrame(exitCode int) {
	for _, ch := range d.dWaiters {
		select {
		case ch <- exitCode:
		default:
		}
	}
}

// openCmdWindow C 帧开新命令窗（P-20261005-170）。前一窗仍 Open（D 帧丢失的
// 降级形态，如 shell 集成半途注入/异常流）时先按当下时刻兜底闭合——环形窗
// 的不变式是「至多一个 Open 窗」，归因侧把 Open 窗当无上界区间匹配。
// pendingCmd（powershell 先 E 后 C 形态）随窗落账
func (d *oscStateDetector) openCmdWindow() {
	now := time.Now()
	for i := range d.windows {
		if d.windows[i].Open {
			d.windows[i].Open = false
			d.windows[i].End = now
		}
	}
	d.windows = append(d.windows, CmdWindow{
		Start:   now,
		Open:    true,
		Command: d.pendingCmd,
	})
	d.pendingCmd = ""
	if len(d.windows) > cmdWindowCap {
		d.windows = d.windows[len(d.windows)-cmdWindowCap:]
	}
}

// closeCmdWindow D 帧闭合最近的 Open 窗。无 Open 窗（启动期 D / 重复 D）丢弃
// ——启动期 D 前面是 A 不是 C（见 cmdActive 注记），没有可闭合的窗
func (d *oscStateDetector) closeCmdWindow(exitCode int) {
	for i := len(d.windows) - 1; i >= 0; i-- {
		if d.windows[i].Open {
			d.windows[i].Open = false
			d.windows[i].End = time.Now()
			d.windows[i].ExitCode = exitCode
			return
		}
	}
}

// noteCmdText E 帧命令文本入账：窗已开（bash C→E 序）直写最近 Open 窗；
// 窗未开（powershell E→C 序）暂存待下一个 C 随窗落账；两者皆非（E 晚于 D
// 的异常序）丢弃——文本属于已闭窗的过去命令，错挂下一窗比丢摘要更有害。
// 超长截断（完整文本归命令历史，此处只要摘要）
func (d *oscStateDetector) noteCmdText(cmd string) {
	if len(cmd) > cmdTextKeep {
		cmd = cmd[:cmdTextKeep]
	}
	for i := len(d.windows) - 1; i >= 0; i-- {
		if d.windows[i].Open {
			d.windows[i].Command = cmd
			return
		}
	}
	d.pendingCmd = cmd
}

// commandWindows 最近命令窗快照（旧→新副本，调用方改写不回灌）。零值探测器
// 返回 nil——调用方按「无命令记录」处理
func (d *oscStateDetector) commandWindows() []CmdWindow {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.windows) == 0 {
		return nil
	}
	out := make([]CmdWindow, len(d.windows))
	copy(out, d.windows)
	return out
}

// WaitDFrame 阻塞等待下一个 OSC 133 D 帧到达（P-20261004-108 运行书服务端
// 执行的退出码等待原语）：返回 (退出码, true)；超时返回 (0, false)。
//
// 归属语义：只交付「C 之后到达的 D」（cmdActive 闸，见字段注记）——命令级
// 归属 = 最近一次 C 的结束帧；不做命令文本对账（E 帧命令文本归前方需引 E
// 帧解析，MVP 不做），错位窗口只剩「他人在同一会话并发敲命令」（显式指定
// 目标会话时的知情边界，API 层注记）。等待是短周期事件，注册即随 defer
// 清表，超时路径不泄漏条目
func (d *oscStateDetector) WaitDFrame(timeout time.Duration) (int, bool) {
	ch := make(chan int, 1)
	d.mu.Lock()
	if d.dWaiters == nil {
		d.dWaiters = make(map[int64]chan int)
	}
	d.nextWaiterID++
	id := d.nextWaiterID
	d.dWaiters[id] = ch
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.dWaiters, id)
		d.mu.Unlock()
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case code := <-ch:
		return code, true
	case <-timer.C:
		return 0, false
	}
}

// FramesSeen 会话生命周期内是否见过任何 C/D 帧（shell 集成在位判据，
// P-20261004-108 运行书执行链的降级判定数据面）
func (d *oscStateDetector) FramesSeen() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.sawFrame
}

// RunningCount 统计 OSC 133 运行点亮的会话（P-20261004-63 计数口）：
//   - kind 过滤："" = 全体会话 / KindShell / KindAgent（其余值调用方先校验）
//   - count=运行点亮数；total=过滤后会话总数；runningIDs=点亮会话 id 清单
//     （会话量级 ≤ MaxSessions，清单有界）——agent 自查「我的会话在跑吗」
//     即「CC_TERMINAL_ID 是否在清单内」，与计数同一往返免二次查询
//
// 锁面：ListSessions 取 m.mu.RLock 后锁外逐会话读探测器自有锁，不叠 s.mu，
// 无锁序耦合
func (m *Manager) RunningCount(kind string) (count, total int, runningIDs []string) {
	runningIDs = []string{}
	for _, s := range m.ListSessions() {
		if kind != "" && s.Kind != kind {
			continue
		}
		total++
		if running, _ := s.OscRunningState(); running {
			count++
			runningIDs = append(runningIDs, s.ID)
		}
	}
	return count, total, runningIDs
}
