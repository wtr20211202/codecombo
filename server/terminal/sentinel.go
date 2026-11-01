package terminal

import (
	"bytes"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codecombo/server/store"
)

// 输出哨兵（P-20261004-8）：用户自定义正则规则的终端输出订阅。与 dev 端口被动
// 探测（portdetect.go）同挂输出 tap——readLoop 滑窗旁路匹配，无 WS 客户端
// attached 也生效（长构建/后台 agent 会话用户不盯屏的场景正是本功能的靶心）。
// 命中经 OnSentinelHit 上报，API 层装配为通知中心条目（Action 直达触发会话）。
//
// 性能护栏（与 portdetect 同路数，输出流是热路径）：
//   - 规则集为空（功能未使用的常态）零正则成本，只做一次窗口追加；
//   - 滑窗字节上限 sentinelWindowCap，超限只保尾部；
//   - 规则编译一次缓存（包级），存储版本号比对漂移才重读重编——热路径零重复编译；
//   - 每规则独立 5min 防抖：命中横幅常驻滑窗、后续任意输出重扫不刷屏。
//
// 与 portdetect 的关键词预筛不同：用户模式无法预知必含哪些 ASCII 关键词，预筛
// 不适用；成本上界由「≤10 条规则 × 线性时间 RE2（Go regexp 无回溯）× ≤4KB 窗口」
// 兜底，单块最坏几十微秒量级。与 portdetect 共 tap 不互相干扰：独立探测器实例、
// 独立回调装配，任一侧规则集为空时对另一侧零影响。

const (
	// sentinelWindowCap 最近输出滑窗字节上限：与 portdetect 同量级（覆盖常见
	// 错误横幅几行~几十行），不追长输出历史
	sentinelWindowCap = 4096
	// sentinelDebounce 防抖窗口：同会话同规则 5 分钟内不重复通知
	//（错误文案常驻滑窗，后续任意输出都会重扫命中）。构造时经 debounce 字段
	// 落到探测器——单测注入短窗口验证过期再报，不动包级常量
	sentinelDebounce = 5 * time.Minute
	// sentinelMaxTracked lastHit 条目上限兜底：规则数有 ≤10 护栏，正常到不了；
	// 规则反复增删 churn 防无界
	sentinelMaxTracked = 32
	// sentinelMatchedMax 命中行摘录上限（进通知正文，语言中立明细）
	sentinelMatchedMax = 200
)

// SentinelHit 命中信息（API 层装配为通知中心条目所需的最小集）
type SentinelHit struct {
	RuleID string // 命中规则 ID
	Name   string // 规则名（通知标题主体）
	Level  string // info / warning / error（已归一化）
	// Matched 命中行摘录（已剥 ANSI、≤200 字符）——通知正文的语言中立明细，
	// 用户不切会话也能看出命中了什么
	Matched string
}

// OnSentinelHit 探测命中回调（API 层 init 装配，注入通知中心入账；nil = 匹配
// 照跑、命中不上报）。单消费者直接赋值：装配发生在模块 init（先于任何会话
// 创建），无并发写
var OnSentinelHit func(sessionID string, hit SentinelHit)

// —— 规则供给（包级变量仅为单测注入；生产恒为 store 读取）——
// 拆成廉价版本比对 + 昂贵全量读取两口：热路径逐块只做版本比对（原子读），
// 漂移才触发 List + 重编译

var sentinelVersionFn = func() int64 {
	if st := store.Get(); st != nil && st.Sentinel != nil {
		return st.Sentinel.Version()
	}
	return 0
}

var sentinelLoadFn = func() []store.SentinelRule {
	if st := store.Get(); st != nil && st.Sentinel != nil {
		rules, _ := st.Sentinel.List()
		return rules
	}
	return nil
}

// compiledSentinelRule 编译后的规则条目（缓存态；Pattern 编译失败的不入缓存）
type compiledSentinelRule struct {
	id    string
	name  string
	level string
	scope string // "global" / projectId（规则存储原值）
	re    *regexp.Regexp
}

// sentinelRulesCache 包级编译缓存：版本号比对一致即复用（跨会话共享——规则集
// 是全局资源，编译一次全体会话受益）。loaded 区分「版本 0 且未加载」与「已加载
// 空规则集」：store 未装配（单测）与规则确空都落在 version 0
var sentinelRulesCache struct {
	mu      sync.Mutex
	loaded  bool
	version int64
	rules   []compiledSentinelRule
}

// currentSentinelRules 当前生效规则（编译缓存命中路径零分配）
func currentSentinelRules() []compiledSentinelRule {
	version := sentinelVersionFn()
	sentinelRulesCache.mu.Lock()
	defer sentinelRulesCache.mu.Unlock()
	if sentinelRulesCache.loaded && sentinelRulesCache.version == version {
		return sentinelRulesCache.rules
	}
	rules := sentinelLoadFn()
	compiled := make([]compiledSentinelRule, 0, len(rules))
	for _, r := range rules {
		re, err := regexp.Compile(r.Pattern)
		if err != nil {
			continue // 编译失败规则跳过（API 写入口已校验；存量/外部写入兜底）
		}
		compiled = append(compiled, compiledSentinelRule{
			id:    r.ID,
			name:  r.Name,
			level: normalizeSentinelLevel(r.Level),
			scope: r.Scope,
			re:    re,
		})
	}
	sentinelRulesCache.loaded = true
	sentinelRulesCache.version = version
	sentinelRulesCache.rules = compiled
	return compiled
}

// normalizeSentinelLevel 级别归一化：空/非法回落 warning（哨兵命中本质是
// 「值得关注」，warning 样式与通知中心 error 红点/通知偏好门控都兼容）
func normalizeSentinelLevel(level string) string {
	switch level {
	case store.SentinelLevelInfo, store.SentinelLevelWarn, store.SentinelLevelError:
		return level
	}
	return store.SentinelLevelWarn
}

// sentinelDetector 会话级哨兵状态：滑窗 + 每规则独立防抖。仅 readLoop 单
// goroutine 写入，锁为防御性（OnSentinelHit 观察者行为不受本包控制）
type sentinelDetector struct {
	sessionID string
	projectID string // 作用域过滤：scope=projectId 的规则只匹配同项目会话
	debounce  time.Duration

	mu      sync.Mutex
	window  []byte               // 最近输出滑窗（≤ sentinelWindowCap，保尾部）
	scratch []byte               // 剥除 ANSI 后的匹配文本（容量跨 feed 复用）
	lastHit map[string]time.Time // 规则 ID → 上次通知时刻（防抖）
}

// newSentinelDetector 构造会话哨兵（会话创建/重启恢复两路构造点均需初始化，
// 与 devPort 同款；随 Session 生命周期 GC，无独立清理路径）
func newSentinelDetector(sessionID, projectID string) *sentinelDetector {
	return &sentinelDetector{
		sessionID: sessionID,
		projectID: projectID,
		debounce:  sentinelDebounce,
		lastHit:   make(map[string]time.Time),
	}
}

// feed 追加一段终端输出并逐规则匹配。命中回调在锁外执行：回调链（通知落库 +
// 广播）代价不可控，不拖住 readLoop
func (d *sentinelDetector) feed(data []byte) {
	if len(data) == 0 {
		return
	}
	hits := d.ingest(data, currentSentinelRules())
	for i := range hits {
		if OnSentinelHit != nil {
			OnSentinelHit(d.sessionID, hits[i])
		}
	}
}

// ingest 追加一段输出并按给定规则集匹配（appendWindow + 剥 ANSI + matchWindow
// 的单一串接），返回命中但不触 OnSentinelHit——规则集由调用方给出口：生产 feed
// 传存储编译缓存，服务端试跑（TestSentinelSample）传请求内联规则。试跑侧复用
// 本方法即「与生产同代码路径」，不另写一套匹配实现
func (d *sentinelDetector) ingest(data []byte, rules []compiledSentinelRule) []SentinelHit {
	if len(data) == 0 {
		return nil
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.appendWindow(data)
	if len(rules) == 0 {
		return nil
	}
	return d.matchWindow(rules)
}

// —— 服务端试跑原语（P-20261004-107）：POST /api/sentinels/test 的引擎侧 ——
// 动机：前端测试框的本地 JS 试跑是近似层（JS 是 RE2 的超集、逐行 vs 滑窗口径
// 有别），RE2 专属语法本地只能提示不可验。本原语把样例喂进与生产完全相同的
// 探测器路径，回答「这个规则在生产语义下到底命中吗」。
//
// 无副作用隔离（提案风险注记的落地）：一次性构造 sentinelDetector（独立窗口与
// 防抖账本），不经 OnSentinelHit 上报、不读不写存储——生产实例与通知链零触及。
// 计算量级：样例钳制 ≤500 行/128KB，分块 ≤64 块 ×（4KB 剥 ANSI + ≤10 规则线性
// RE2）≈ 最坏几 MB 正则扫描，按需端点非热路径，毫秒量级封顶。

// SentinelProbeRule 试跑输入规则：ID 由调用方自定（响应原样回带，UI 传临时
// id 即可）；Pattern 为待验证 RE2 正则。不携带 scope/level——试跑只回答命中
// 与否：作用域过滤是「会话归属」语义（试跑无会话，输入规则视为全部适用），
// 级别只影响通知样式不影响匹配
type SentinelProbeRule struct {
	ID      string `json:"id"`
	Pattern string `json:"pattern"`
}

// SentinelProbeResult 逐规则试跑结果。hit=false 且 error!="" 为模式编译失败
// （RE2 语义的权威反馈——本地 JS 试跑的盲区恰在此处）；Matched 为命中行摘录
// （生产通知正文同款 matchedLineOf 装配，所见即所产）
type SentinelProbeResult struct {
	RuleID  string `json:"ruleId"`
	Hit     bool   `json:"hit"`
	Matched string `json:"matched,omitempty"`
	Error   string `json:"error,omitempty"`
}

const (
	// sentinelProbeMaxLines 样例行数钳制：沿前端测试框 MAX_LINES=500 惯例，
	// 双档（本地近似/服务端精确）同口径
	sentinelProbeMaxLines = 500
	// sentinelProbeMaxBytes 样例字节硬顶：行钳制之外的传输护栏（500 行超长
	// 单行不失控）；128KB 对 500 行 × 典型百字节终端行有 10 倍余量
	sentinelProbeMaxBytes = 128 * 1024
	// sentinelProbeChunk 分块喂入步长 = 窗口上限一半：任一匹配（长度 ≤ 窗口
	// 上限；更长的匹配在生产同样永不可能整体落窗命中）在其尾部所属块喂入时
	// 完整落在窗口内——整段一次喂入只会测到尾部 4KB，与流式生产语义相悖
	sentinelProbeChunk = sentinelWindowCap / 2
)

// TestSentinelSample 服务端试跑：内联规则逐条编译（失败记入该条 Error 不拖累
// 其他规则），样例行/字节双钳制后分块喂入一次性探测器，返回逐规则首命中
// （防抖语义天然成立：单次试跑远短于防抖窗，每规则只取首条命中，与生产
// 「同规则 5 分钟只报一次」的取首语义一致）。truncated = 样例被钳制（调用方
// 应如实告知「仅试跑前缀」）
func TestSentinelSample(rules []SentinelProbeRule, sample []byte) (results []SentinelProbeResult, truncated bool) {
	results = make([]SentinelProbeResult, len(rules))
	compiled := make([]compiledSentinelRule, 0, len(rules))
	for i, r := range rules {
		results[i] = SentinelProbeResult{RuleID: r.ID}
		re, err := regexp.Compile(r.Pattern)
		if err != nil {
			results[i].Error = err.Error()
			continue
		}
		compiled = append(compiled, compiledSentinelRule{id: r.ID, re: re})
	}

	sample, cut := clampProbeSample(sample)
	truncated = cut
	if len(compiled) == 0 || len(sample) == 0 {
		return results, truncated
	}

	// 一次性探测器实例：零值窗口 + 独立防抖账本，不与任何生产会话共享状态
	//（sessionID/projectID 留空无意义——试跑规则全适用，无回调上报路径）
	d := &sentinelDetector{debounce: sentinelDebounce, lastHit: make(map[string]time.Time)}
	idxOf := make(map[string]int, len(results))
	for i := range results {
		idxOf[results[i].RuleID] = i
	}
	for off := 0; off < len(sample); off += sentinelProbeChunk {
		end := min(off+sentinelProbeChunk, len(sample))
		for _, hit := range d.ingest(sample[off:end], compiled) {
			if i, ok := idxOf[hit.RuleID]; ok && !results[i].Hit {
				results[i].Hit = true
				results[i].Matched = hit.Matched
			}
		}
	}
	return results, truncated
}

// clampProbeSample 样例钳制：先按行（前 500 行，与前端 split('\n')+slice 同
// 口径）再按字节（硬顶处回退 UTF-8 字符边界）。两次钳制任一触发即报 truncated
func clampProbeSample(sample []byte) ([]byte, bool) {
	truncated := false
	if count := bytes.Count(sample, []byte{'\n'}); count >= sentinelProbeMaxLines {
		// 第 500 个 '\n' 处截断（保留该换行符，行集合与前端切片同构）
		cut := 0
		for n := 0; n < sentinelProbeMaxLines; n++ {
			cut = bytes.IndexByte(sample[cut:], '\n') + cut + 1
		}
		sample = sample[:cut]
		truncated = true
	}
	if len(sample) > sentinelProbeMaxBytes {
		sample = sample[:rewindToRuneStart(sample, sentinelProbeMaxBytes)]
		truncated = true
	}
	return sample, truncated
}

// appendWindow 追加数据并裁到滑窗上限（保尾部；越界起点回退 UTF-8 字符边界，
// 复用 portdetect 同款 rewindToRuneStart）。拷贝出新数组：重切片会让 backing
// array 前缀长期滞留
func (d *sentinelDetector) appendWindow(data []byte) {
	d.window = append(d.window, data...)
	if excess := len(d.window) - sentinelWindowCap; excess > 0 {
		d.window = append([]byte{}, d.window[rewindToRuneStart(d.window, excess):]...)
	}
}

// matchWindow 剥除 ANSI 后逐条适用规则匹配：每规则取首个命中，防抖窗内的规则
// 跳过（同窗多规则各自独立上报）。ANSI 剥离走 ansi.go appendStripped 单实现
// （CSI+OSC 一次扫描；OSC 终端标题自 P-20261005-8 起不参与匹配——标题携带的
// cwd/命令段不再命中规则词）
func (d *sentinelDetector) matchWindow(rules []compiledSentinelRule) []SentinelHit {
	applicable := 0
	for _, r := range rules {
		if r.appliesTo(d.projectID) {
			applicable++
		}
	}
	if applicable == 0 {
		return nil
	}

	d.scratch = appendStripped(d.scratch, d.window)

	var hits []SentinelHit
	now := time.Now()
	for _, r := range rules {
		if !r.appliesTo(d.projectID) {
			continue
		}
		loc := r.re.FindIndex(d.scratch)
		if loc == nil {
			continue
		}
		if t, ok := d.lastHit[r.id]; ok && now.Sub(t) < d.debounce {
			continue // 防抖窗内该规则跳过：其他规则仍可上报
		}
		if len(d.lastHit) >= sentinelMaxTracked {
			d.lastHit = make(map[string]time.Time)
		}
		d.lastHit[r.id] = now
		hits = append(hits, SentinelHit{
			RuleID:  r.id,
			Name:    r.name,
			Level:   r.level,
			Matched: matchedLineOf(d.scratch, loc[0], loc[1]),
		})
	}
	return hits
}

// appliesTo 作用域判定：global 全放行；projectId 规则仅同项目会话
// （agent 会话 ProjectID 为空，天然只吃 global 规则）
func (r compiledSentinelRule) appliesTo(projectID string) bool {
	return r.scope == "" || r.scope == store.SentinelScopeGlobal || r.scope == projectID
}

// matchedLineOf 摘录命中所在行（buf[start:end] 为匹配区间）：前后扩到行界、
// 去首尾空白、超长按 rune 边界截断——通知正文的人类可读明细。
// 超长行摘录窗从命中点前方一小段起（rune 对齐），命中词保持可见
func matchedLineOf(buf []byte, start, end int) string {
	lo := start
	for lo > 0 && buf[lo-1] != '\n' {
		lo--
	}
	hi := end
	for hi < len(buf) && buf[hi] != '\n' {
		hi++
	}
	if head := start - lo; head > sentinelMatchedMax/3 {
		lo = start - sentinelMatchedMax/3
		for lo < hi && !utf8.RuneStart(buf[lo]) {
			lo++
		}
	}
	line := strings.TrimSpace(string(buf[lo:hi]))
	if len(line) > sentinelMatchedMax {
		cut := sentinelMatchedMax
		for cut > 0 && !utf8.RuneStart(line[cut]) {
			cut--
		}
		line = line[:cut]
	}
	return line
}
