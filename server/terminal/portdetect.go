package terminal

import (
	"regexp"
	"strconv"
	"sync"
	"time"
)

// 终端输出 dev 端口被动探测（P-20261002-83）：
// P-70 的 preview.port 依赖 agent 主动上报（手册约定）；普通终端里用户手敲
// npm run dev、或老版本 agent 不上报时端口无人知晓。本文件在终端输出流经
// readLoop 的路径上做被动旁路探测：最近输出滑窗内正则匹配常见启动完成文案
//（Vite/Next/webpack/go 等），命中经 OnDevPortDetected 上报，API 层装配为与
// P-70 同款 preview.port 广播（payload 带 source:"detected"，前端弱化展示）。
//
// 性能护栏（输出流是热路径，探测必须廉价）：
//   - 滑窗字节上限 devPortWindowCap，超限只保尾部；
//   - 纯 ASCII 关键词预筛：窗口不含 listening/ready/local 等词直接跳过全部正则；
//   - 模式表包级编译一次；命中解析只在关键词预筛放行后发生。

const (
	// devPortWindowCap 最近输出滑窗字节上限：覆盖启动横幅（几行~几十行）即可，
	// 不追长输出历史。4KB 与 readLoop 单次读取块同量级
	devPortWindowCap = 4096
	// devPortMin/devPortMax 端口合法性（与 ai.decodePreviewPortPayload 同口径：
	// 回环高位段）。通用正则在任意终端文本上兜，范围过滤挡 ":80"/时间戳类误报
	devPortMin = 1024
	// devPortDebounce 防抖窗口：同会话同端口 5 分钟内不重复上报
	//（启动横幅常驻滑窗，后续任意输出都会触发重扫）。构造时经 debounce 字段
	// 落到探测器——单测注入短窗口验证过期再报，不动包级常量
	devPortMax      = 65535
	devPortDebounce = 5 * time.Minute
)

// loopbackHost 回环 host 常见写法。host 不限死会放大误报面（任意域名的 :443
// 链接都会被咬中），回环系才是预览面板的适用面
const loopbackHost = `(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)`

// localURLTail "Local: [scheme://]host:port" 文案尾段（捕获组 1 = 端口）。
// Vite/Next/CRA/vue-cli 的启动横幅都是这个形态
const localURLTail = `\blocal:\s*(?:https?://)?` + loopbackHost + `:(\d{1,5})\b`

// devPortPattern 模式表条目：label 为可断言的工具简称（进通知/悬浮球文案，
// 如 "vite"）；通用兜底模式不断言工具，label 留空（前端退化为无 label 文案）
type devPortPattern struct {
	re    *regexp.Regexp
	label string
}

// devPortPatterns 常见启动完成模式表，专用在前、通用兜底殿后；同窗口内逐模式
// 扫全部匹配，首个「端口合法且未防抖」的命中上报。扩展：追加一行即可
// （预筛关键词需保证被新模式文案覆盖）
var devPortPatterns = []devPortPattern{
	// Vite："VITE v5.4.8  ready in 312 ms" 与 "➜  Local:  http://localhost:5173/"
	// 两行同现（行距 ≤200 字符）才断言 vite，避免仅 config 文件名闪过而误标
	{regexp.MustCompile(`(?is)\bvite\b.{0,200}?` + localURLTail), "vite"},
	// Next.js（≤14）："✓ Ready on http://localhost:3000"
	{regexp.MustCompile(`(?i)\bready\s+on\s+(?:https?://)?` + loopbackHost + `:(\d{1,5})\b`), "next"},
	// webpack-dev-server："Project is running at http://localhost:8080/"
	//（无 "on" 字样，通用模式覆盖不到，需专列）
	{regexp.MustCompile(`(?i)running\s+at\s+(?:https?://)?` + loopbackHost + `:(\d{1,5})\b`), "webpack"},
	// 通用 Local:（CRA / vue-cli / Next ≥15 等同款文案，不断言工具）
	{regexp.MustCompile(`(?i)` + localURLTail), ""},
	// 通用 listening/running/serving/started ... on [scheme://]host:port
	//（go run/gin "Listening and serving HTTP on :8080"/uvicorn 等；host 不限回环）。
	// 关键词与 "on" 之间限 48 字符非冒号非换行：跨行/跨字段不连报；
	// 惰性消费到行内最末 host:port，时间戳形态（12:30）由端口范围过滤挡
	{regexp.MustCompile(`(?i)\b(?:listening|running|serving|started)\b[^:\n]{0,48}?\bon\s+[^\s]*?:(\d{1,5})\b`), ""},
}

// devPortKeywords 预筛关键词（ASCII 不区分大小写）：模式表任一模式命中时窗口
// 必然包含其一。终端二进制/下载进度等大流量输出不含任何关键词，正则整体跳过
var devPortKeywords = []string{"listening", "running", "serving", "ready", "local", "vite", "started"}

// OnDevPortDetected 探测命中回调（API 层 init 装配，注入 opschannel preview.port
// 广播；nil = 探测照跑、命中不上报）。单消费者直接赋值：装配发生在模块 init
// （先于任何会话创建），无并发写
var OnDevPortDetected func(sessionID string, port int, label string)

// devPortDetector 会话级探测状态：滑窗 + 同端口防抖。仅 readLoop 单 goroutine
// 写入，锁为防御性（OnDevPortDetected 观察者行为不受本包控制）
type devPortDetector struct {
	sessionID string
	debounce  time.Duration

	mu      sync.Mutex
	window  []byte            // 最近输出滑窗（≤ devPortWindowCap，保尾部）
	scratch []byte            // 剥除 ANSI 后的匹配文本（容量跨 feed 复用）
	lastHit map[int]time.Time // 端口 → 上次上报时刻（防抖）
}

// newDevPortDetector 构造会话探测器（会话创建/重启恢复两路构造点均需初始化，
// 与 onOutput/onExit 同款；随 Session 生命周期 GC，无独立清理路径）
func newDevPortDetector(sessionID string) *devPortDetector {
	return &devPortDetector{
		sessionID: sessionID,
		debounce:  devPortDebounce,
		lastHit:   make(map[int]time.Time),
	}
}

// feed 追加一段终端输出并尝试探测。命中回调在锁外执行：
// 回调链（opschannel 广播）代价不可控，不拖住 readLoop
func (d *devPortDetector) feed(data []byte) {
	if len(data) == 0 {
		return
	}
	d.mu.Lock()
	d.appendWindow(data)
	// 预筛：窗口不含任何关键词直接跳过模式表（热路径大流量输出的快速通道）
	var port int
	var label string
	hit := false
	if d.windowHasKeyword() {
		port, label, hit = d.matchWindow()
	}
	d.mu.Unlock()

	if hit && OnDevPortDetected != nil {
		OnDevPortDetected(d.sessionID, port, label)
	}
}

// appendWindow 追加数据并裁到滑窗上限（保尾部；越界起点回退 UTF-8 字符边界，
// 复用 scrollback 同款 rewindToRuneStart）。拷贝出新数组：重切片会让 backing
// array 前缀长期滞留
func (d *devPortDetector) appendWindow(data []byte) {
	d.window = append(d.window, data...)
	if excess := len(d.window) - devPortWindowCap; excess > 0 {
		d.window = append([]byte{}, d.window[rewindToRuneStart(d.window, excess):]...)
	}
}

// windowHasKeyword 预筛：ASCII 不区分大小写扫描（"Listening"/"LOCAL" 同样命中；
// UTF-8 安全——ASCII 字节不会出现在多字节序列内部）
func (d *devPortDetector) windowHasKeyword() bool {
	for _, kw := range devPortKeywords {
		if asciiContainsFold(d.window, kw) {
			return true
		}
	}
	return false
}

// matchWindow 剥除 ANSI 后逐模式匹配，首个「端口合法且未防抖」的命中上报
// （同模式扫全部匹配：滑窗里靠前的已防抖/非法命中不遮蔽更后段的新端口）。
// ANSI 剥离走 ansi.go appendStripped 单实现（CSI+OSC 一次扫描；OSC 标题/标记
// 内容自 P-20261005-8 起不参与匹配，标题里伪装的 Local: 文案不再误报）
func (d *devPortDetector) matchWindow() (port int, label string, hit bool) {
	d.scratch = appendStripped(d.scratch, d.window)

	for _, p := range devPortPatterns {
		for _, m := range p.re.FindAllSubmatch(d.scratch, -1) {
			pv, err := strconv.Atoi(string(m[1]))
			if err != nil || pv < devPortMin || pv > devPortMax {
				continue // 误报形态（特权段端口/时间戳片段），本模式内继续找
			}
			if t, ok := d.lastHit[pv]; ok && time.Since(t) < d.debounce {
				continue // 防抖窗内该端口跳过：后续端口仍可上报
			}
			// lastHit 只增端口键：上限兜底（正常会话个位数端口；滚动 churn 防无界）
			if len(d.lastHit) >= 32 {
				d.lastHit = make(map[int]time.Time)
			}
			d.lastHit[pv] = time.Now()
			return pv, p.label, true
		}
	}
	return 0, "", false
}

// asciiContainsFold ASCII 不区分大小写的子串存在性（朴素 O(n·m)，
// 窗口 ≤4KB × 关键词长度个位数字节，量级为微秒，无须串式算法）
func asciiContainsFold(data []byte, kw string) bool {
	if len(kw) == 0 || len(data) < len(kw) {
		return false
	}
	first := asciiFoldByte(kw[0])
	for i := 0; i+len(kw) <= len(data); i++ {
		if asciiFoldByte(data[i]) != first {
			continue
		}
		j := 1
		for ; j < len(kw); j++ {
			if asciiFoldByte(data[i+j]) != asciiFoldByte(kw[j]) {
				break
			}
		}
		if j == len(kw) {
			return true
		}
	}
	return false
}

// asciiFoldByte ASCII 大写折叠为小写（非 ASCII 字节原样返回）
func asciiFoldByte(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + 32
	}
	return b
}
