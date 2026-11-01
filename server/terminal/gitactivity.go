package terminal

import (
	"bytes"
	"regexp"
	"sync"
	"time"
)

// TUI 运行时 git 写活动的服务端感知（P-20261004-81）：claude/codex 等 TUI 在
// 会话内部子进程调 git，不发 OSC 133（shell 集成只包住交互 shell 的命令行），
// 前端 P-74 检测链对它全盲——而 agent 恰是本产品最高频的 git 变更者，此前
// 面板感知只剩变更面板自拉的兜底。本文件在 readLoop 输出路径上做第三个旁路
// tap（与 devPort/sentinel 同挂点同护栏）：输出滑窗内匹配 git 写完成特征模式
//（commit 摘要行 / push 引用区间行 / switch 分支行，保守起步），命中经会话
// ProjectID 归属发布内核总线 git.activity，api 层 busbridge 桥接到项目 WS
//（branch.changed 声明未发布的既有管道兑现），前端并轨 sc:git-panel-autorefresh
// 既有去抖拉取链——agent TUI 干活、人盯面板的感知变秒级定向（面板挂载即可，
// 无需终端 pane 挂载）；同项目 WS 上的 agent（子协议携智能体令牌可订阅，
// ops 手册 git 节登记）也能感知「别的会话动了仓库」。
//
// 性能护栏（与 sentinel/portdetect 同路数，输出流是热路径）：
//   - 滑窗字节上限 gitActivityWindowCap，超限只保尾部；
//   - 单字符必要条件预筛（'[' / '>' / '\''）：窗口不含任何其一即不可能命中，
//     跳过模式表。注意 TUI 重绘帧几乎必含 CSI 转义（'['），预筛对 TUI 输出
//     常年放行——真正的成本上界是「3 条线性时间 RE2（Go regexp 无回溯）×
//     ≤4KB 窗口」（sentinel 同款量级：单块最坏几十微秒），命中后去重把重扫
//     抑制为不重复广播；
//   - 模式表包级编译一次（3 条，常量可扩：追加一行 + 预筛字符核对）。
//
// 误报护栏：模式保守（行首锚定 + 结构化 token），且误报代价只是一次幂等的
// 面板 GET（宁可多刷一次）；漏报（git locale 本地化文案等）回落既有感知链，
// 不劣化现状。

const (
	// gitActivityWindowCap 最近输出滑窗字节上限：commit 摘要/push 结果距命令
	// 回显几行~几十行，4KB 足够覆盖，不追长输出历史
	gitActivityWindowCap = 4096
	// gitActivityDebounce 同会话两次广播的最小间隔。内容键去重（见 matchWindow）
	// 已挡住「同一命中行驻留滑窗期间任意输出重扫重复广播」，本间隔只兜
	// 「键不同但连发」的病态输出形态（如某 TUI 渲染一串不同 hash 的伪摘要
	// 行）——1s 与前端面板去抖同量级，更密的广播也只合并为同一次面板刷新
	gitActivityDebounce = time.Second
)

// git.activity 的 kind 词汇（载荷元数据；消费方按「有变动」语义容错新词汇）
const (
	GitActivityCommit = "commit"
	GitActivityPush   = "push"
	GitActivitySwitch = "switch"
)

// TopicGitActivity 内核总线 topic：terminal 模块发布 → api 层 busbridge 桥接
// → 项目 WS（WSMessage{type,data}，与 file.changed 同线格式）。/api/modules
// 里 terminal 模块 Topics 声明同源
const TopicGitActivity = "git.activity"

// GitActivityHit 命中信息（内核总线 git.activity 载荷，JSON 形态即项目 WS
// 消息的 data 契约，字段只增不改）
type GitActivityHit struct {
	Kind string `json:"kind"` // commit / push / switch
	// Ref 尽力解析的分支/引用名（commit 摘要行方括号内分支、switch 目标分支、
	// push 目的地引用）；解析不出留空——嗅探是元数据不是权威事实
	Ref string `json:"ref,omitempty"`
	// SessionID 来源会话（TUI 归属；agent 消费方据此区分「别的会话动了仓库」）
	SessionID string `json:"sessionId"`
	// ProjectID 定向归属（busbridge 按 Envelope.ProjectID 投递到项目 WS；载荷
	// 冗余携带便于跨面自描述）
	ProjectID string    `json:"projectId"`
	At        time.Time `json:"at"`
}

// OnGitActivity 命中回调（terminal 模块 Init 装配 → 内核总线发布；nil = 匹配
// 照跑、命中不发布）。单消费者直接赋值：装配发生在模块 Init（先于任何会话
// 创建），无并发写
var OnGitActivity func(hit GitActivityHit)

// gitActivityPattern 模式表条目。refIdx/keyIdx 为子匹配下标（1-based，0 = 整
// 段匹配）：ref 进载荷（尽力而为），key 参与内容去重
type gitActivityPattern struct {
	re     *regexp.Regexp
	kind   string
	refIdx int
	keyIdx int
}

// gitActivityPatterns git 写完成特征模式表，保守起步。扩展：追加一行即可
//（预筛字符需保证被新模式文案覆盖）
var gitActivityPatterns = []gitActivityPattern{
	{
		// git commit 成功摘要行（git 内建输出不经 gettext，格式恒定）：
		//   [main abc1234] Add feature
		//   [main (root-commit) abc1234] Initial commit
		//   [detached HEAD abc1234] ...
		// 行首锚定（\A|\n）只认「整行以方括号开头」的摘要形态，行中
		// [文字 hash] 形的无关文本（markdown 链接/表格）不咬
		kind:   GitActivityCommit,
		re:     regexp.MustCompile(`(?:\A|\n)\[((?:[^\[\]\s]{1,120})|detached HEAD)(?:\s+\([^)\]]{1,60}\))?\s+([0-9a-f]{7,40})\]\s+\S`),
		refIdx: 1, keyIdx: 2,
	},
	{
		// git push/fetch 引用区间行（传输层输出，结构化 token）：
		//   abc1234..def5678  main -> main
		//   abc1234...def5678  main -> main (forced update)
		// 两点为常规快进、三点为 force 区间，\.{2,3} 双形态通吃。fetch 同款
		// 输出（-> origin/x）也命中：远端跟踪引用推进改变 ahead/behind 展示，
		// 刷新无害且有用。区间结构天然排除 "Everything up-to-date" 等无变化
		// 文案——无变化无刷新
		kind:   GitActivityPush,
		re:     regexp.MustCompile(`([0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)`),
		refIdx: 2, keyIdx: 1,
	},
	{
		// git switch/checkout 分支行（英文 locale 文案；git 文案随 gettext
		// 本地化，非英文 locale 下漏报——保守模式宁漏勿误，漏报回落既有
		// 兜底链不劣化现状）：
		//   Switched to branch 'main' / Switched to a new branch 'dev'
		kind:   GitActivitySwitch,
		re:     regexp.MustCompile(`Switched to (?:a new )?branch '([^']+)'`),
		refIdx: 1, keyIdx: 1,
	},
}

// gitActivityTriggerChars 预筛字符集：三族模式各自的必要 ASCII 字符（commit
// 摘要行的 '['、push 区间行的 '>'、switch 文案的引号）。窗口不含任何其一即
// 不可能命中，模式表整体跳过——大流量输出（构建日志/进度条）的快速通道。
// 常量串形态：feed 是热路径，ContainsAny 零分配
const gitActivityTriggerChars = "['>"

// gitActivityDetector 会话级探测状态：滑窗 + 内容键去重 + 最小间隔。仅
// readLoop 单 goroutine 写入，锁为防御性（OnGitActivity 观察者行为不受本包
// 控制）。会话创建/重启恢复两路构造点均需初始化（与 devPort/sentinel 同款）；
// 随 Session 生命周期 GC，无独立清理路径
type gitActivityDetector struct {
	sessionID string
	projectID string // 空 = 无项目归属（纯 shell/agent 免项目会话），feed 直接短路
	debounce  time.Duration

	mu      sync.Mutex
	window  []byte // 最近输出滑窗（≤ gitActivityWindowCap，保尾部）
	scratch []byte // 剥除 ANSI 后的匹配文本（容量跨 feed 复用）
	lastKey string // 上次广播的内容键（同键重扫不重播）
	lastAt  time.Time
}

// newGitActivityDetector 构造会话探测器
func newGitActivityDetector(sessionID, projectID string) *gitActivityDetector {
	return &gitActivityDetector{
		sessionID: sessionID,
		projectID: projectID,
		debounce:  gitActivityDebounce,
	}
}

// feed 追加一段终端输出并尝试探测。命中回调在锁外执行：回调链（总线发布 +
// WS 广播）代价不可控，不拖住 readLoop
func (d *gitActivityDetector) feed(data []byte) {
	// 无项目归属的会话无法定向到项目 WS——构造期短路，匹配照跑无意义
	//（纯 shell / 免项目 agent 会话；其 git 活动本就不该归属任何项目面板）
	if len(data) == 0 || d.projectID == "" {
		return
	}
	d.mu.Lock()
	d.appendWindow(data)
	hit, ok := d.matchWindow()
	d.mu.Unlock()

	if ok && OnGitActivity != nil {
		hit.SessionID = d.sessionID
		hit.ProjectID = d.projectID
		hit.At = time.Now()
		OnGitActivity(hit)
	}
}

// appendWindow 追加数据并裁到滑窗上限（保尾部；越界起点回退 UTF-8 字符边界，
// 复用 sentinel/portdetect 同款 rewindToRuneStart）。拷贝出新数组：重切片会让
// backing array 前缀长期滞留
func (d *gitActivityDetector) appendWindow(data []byte) {
	d.window = append(d.window, data...)
	if excess := len(d.window) - gitActivityWindowCap; excess > 0 {
		d.window = append([]byte{}, d.window[rewindToRuneStart(d.window, excess):]...)
	}
}

// matchWindow 剥除 ANSI 后取「窗口内最新」命中（滑窗追加序 = 时间序，最大偏移
// 即最新；同块多事件如 `git add && git commit` 时旧事件的效果被新事件的刷新
// 子集覆盖，只报最新一次）。防抖双闸：内容键与上次相同（同一命中行驻留滑窗
// 期间任意输出都会重扫命中）或距上次广播不足 debounce，均不广播。
// ANSI 剥离走 ansi.go appendStripped 单实现（CSI+OSC 一次扫描；OSC 标题/133
// 标记内容自 P-20261005-8 起不参与匹配）
func (d *gitActivityDetector) matchWindow() (GitActivityHit, bool) {
	if !bytes.ContainsAny(d.window, gitActivityTriggerChars) {
		return GitActivityHit{}, false
	}

	d.scratch = appendStripped(d.scratch, d.window)

	var best *gitActivityPattern
	var bestSub []int
	for i := range gitActivityPatterns {
		for _, sub := range gitActivityPatterns[i].re.FindAllSubmatchIndex(d.scratch, -1) {
			if best == nil || sub[0] > bestSub[0] {
				best = &gitActivityPatterns[i]
				bestSub = sub
			}
		}
	}
	if best == nil {
		return GitActivityHit{}, false
	}
	key := submatchString(d.scratch, bestSub, best.keyIdx)
	now := time.Now()
	if key == d.lastKey || now.Sub(d.lastAt) < d.debounce {
		return GitActivityHit{}, false
	}
	d.lastKey = key
	d.lastAt = now
	return GitActivityHit{
		Kind: best.kind,
		Ref:  submatchString(d.scratch, bestSub, best.refIdx),
	}, true
}

// submatchString 取 FindAllSubmatchIndex 结果的指定子匹配文本（idx 0 = 整段；
// 越界防御返回空串）
func submatchString(buf []byte, sub []int, idx int) string {
	lo, hi := idx*2, idx*2+1
	if lo >= len(sub) || hi >= len(sub) || sub[lo] < 0 {
		return ""
	}
	return string(buf[sub[lo]:sub[hi]])
}
