package share

// 终端访客页自适应布局 + 未过滤标注（P-20261106-9）的渲染级回归：
//   - 共用布局件 termlayout.go 经 {{.LayoutCSS}}/{{.LayoutJS}} 注入直播/定格/
//     回放三页（任一页漏接注入点即红；旧 1180 定宽不得残留）
//   - 未过滤横幅：服务端按记录直出 .unfiltered 类 + boot 键 unfiltered（页面
//     消费端 SC.unfiltered 同键）；遮蔽记录零变化
//   - 双语字典 unfilteredBanner 键对账（i18n 两语同步）
//   - SSE 端点按分享记录把 Unfiltered 透传给直播源（源头参数化的接线点）

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

func renderAllTermPages(t *testing.T, unfiltered bool) map[string]string {
	t.Helper()
	out := map[string]string{}
	var live, frozen, cast strings.Builder
	if err := renderTermPage(&live, fixedToken("layout1"), "zh", "live", "", false, false, unfiltered, false); err != nil {
		t.Fatalf("render live: %v", err)
	}
	if err := renderTermFrozenPage(&frozen, fixedToken("layout2"), "zh", "frozen", "", false, unfiltered); err != nil {
		t.Fatalf("render frozen: %v", err)
	}
	if err := renderCastPage(&cast, fixedToken("layout3"), "zh", "cast", ""); err != nil {
		t.Fatalf("render cast: %v", err)
	}
	out["live"], out["frozen"], out["cast"] = live.String(), frozen.String(), cast.String()
	return out
}

func TestTermLayoutInjectedAllTermPages(t *testing.T) {
	for name, page := range renderAllTermPages(t, false) {
		for _, want := range []string{
			"--term-need", "max(var(--term-need),var(--col-floor))", "clamp(1180px,82vw,2000px)", "100dvh", // 自适应列容器
			"function scTermNeed", "function scTextCols", // 列宽估算助手
			"@media (max-width:640px)",                // 窄屏断点
			"@font-face{font-family:'JetBrains Mono'", // 产品同款终端字体（P-20261107-4）
			"/assets/JetBrainsMono-Regular.woff2", "/assets/JetBrainsMono-Bold.woff2",
			".wrap>.gb-root .gb-body,.sc-entrybar .gb-root .gb-body{position:absolute", // 页底留言浮层（不挤压终端区；P-20261119-3 起加选合并条形态）
		} {
			if !strings.Contains(page, want) {
				t.Fatalf("%s page missing layout asset %q", name, want)
			}
		}
		if strings.Contains(page, "max-width:1180px") {
			t.Fatalf("%s page still carries the fixed 1180px column", name)
		}
	}
	// 文件分享页不注入本件：留言板在那里仍是列流内展开（页面本就可滚动）
	var f strings.Builder
	if err := renderSharePage(&f, fixedToken("layout9"), "zh", "", false, time.Time{}, time.Time{}, pageMeta{}, false); err != nil {
		t.Fatalf("render file page: %v", err)
	}
	if strings.Contains(f.String(), ".gb-body{position:absolute") {
		t.Fatal("file share page must keep the in-flow guest board (no term layout css)")
	}
}

// 四终端形态访客页标题去品牌前缀（P-20261118-9）：h1/标签页 = 纯分享名；
// document.title 不再指向泛称 appTitle 键；boot 态携 name（frozen/cast/session
// 无 SSE 面，服务端渲染即终值；live 另经 hello/rename 帧跟随，stream_test 钉）
func TestTermPagesTitleNoBrandPrefix(t *testing.T) {
	pages := renderAllTermPages(t, false)
	var session strings.Builder
	if err := renderSessionPage(&session, fixedToken("layout4"), "zh", "sess-share", ""); err != nil {
		t.Fatalf("render session page: %v", err)
	}
	pages["session"] = session.String()
	for name, page := range pages {
		if strings.Contains(page, "<title>Codecombo ") {
			t.Fatalf("%s page title must not carry the brand prefix", name)
		}
		if !strings.Contains(page, `<h1 id="pageTitle">`) {
			t.Fatalf("%s page h1 must expose the page-title hook id", name)
		}
		if strings.Contains(page, `document.title = t('appTitle')`) {
			t.Fatalf("%s page document.title must follow the share name, not the generic app title", name)
		}
		if !strings.Contains(page, `"name":"`) {
			t.Fatalf("%s page boot state must carry the share name", name)
		}
		// foot-note 并入 footer 单行（P-20261118-9）：单行形态在场，
		// 独立版权行（.footer 单独成行）不再存在
		if !strings.Contains(page, `class="footer foot-note"`) {
			t.Fatalf("%s page must merge foot-note into the footer single line", name)
		}
	}
	// 滚动单面化件（P-20261123-2，取代 P-9 双滚动条收敛）：捕获相滚轮接管 +
	// 诊断面随共用布局件在场；live/cast 在 open 后装面（frozen 软折行无超集面，
	// 只随布局 CSS/JS 注入存在定义体，不装）
	for _, name := range []string{"live", "cast"} {
		if !strings.Contains(pages[name], "scWheelCapture($('termBox'), term)") {
			t.Fatalf("%s page must install the overset wheel capture surface", name)
		}
		if !strings.Contains(pages[name], "scTermDiag(term, $('termBox'))") {
			t.Fatalf("%s page must expose the ?term=diag scroll diagnostics", name)
		}
	}
	// 旧的放行式路由与每写钉底全量退役（假放行：事件仍被 xterm 光滑滚动件消费）
	// ——按代码形态钉，注释里的历史引用不误伤
	for name, page := range pages {
		for _, gone := range []string{
			"function scWheelRoute", "scWheelRoute(term, $('termBox'))",
			"function scPinBottom", "scPinBottom($('termBox')",
			"term.attachCustomWheelEventHandler(", "dataset.pinBottom",
		} {
			if strings.Contains(page, gone) {
				t.Fatalf("%s page must not carry retired scroll piece %q", name, gone)
			}
		}
	}
}

func TestTermPagesWireContentAdaptiveWidth(t *testing.T) {
	pages := renderAllTermPages(t, false)
	// 直播：hello/resize 帧主机列数（setHost → scTermNeed，字号半边参数化钳制
	// P-20261119-2）；定格：快照行宽（定格页字号恒产品值，不参数化）；
	// 回放：cast header 宽度
	if !strings.Contains(pages["live"], "setHost(m.cols, m.rows)") {
		t.Fatal("live page must size the column from hello cols")
	}
	if !strings.Contains(pages["live"], "scTermNeed(hostCols, term.options.fontSize, fitEngaged())") {
		t.Fatal("live page must pass the effective font size to scTermNeed")
	}
	if !strings.Contains(pages["frozen"], "scTermNeed(scTextCols(text))") {
		t.Fatal("frozen page must size the column from snapshot line widths")
	}
	if !strings.Contains(pages["cast"], "scTermNeed(cols, term.options.fontSize)") {
		t.Fatal("cast page must size the column from the cast header width")
	}
}

// 渲染参数跨栈对账（P-20261107-4 渲染保真）：三页统一经 scTermOptions 构造、
// 挂 Unicode 11 宽度表、加载 vendored addon；常量与产品内终端缺省值对齐——
// 产品侧定义源：字体栈 web/src/terminal-themes/index.ts XTERM_FONT_STACKS.jetbrains、
// 字号 web/src/stores/font.ts FONT_DEFAULTS.terminal = 14、scrollback
// server/terminal/scrollback.go DefaultScrollbackLines = 20000。访客页零依赖不读
// settings，此处钉死的是「对齐时点的产品缺省值」——产品侧改缺省时本测试红即
// 提示同步审视访客侧常量（总纲：参数对齐，不承诺同一配置源）。SC_TERM_MIN_FONT/
// SC_TERM_SB/SC_TERM_MAX_FONT 三常量无产品侧对应物（guest-only 呈现选择：
// 收缩下限/滚动条让位/放大 3× 上限）不受此对账约束——本测试 Contains 断言只钉
// 形态，MIN_FONT/SB 无对应物在场即先例（P-20261119-2 MAX_FONT 循此豁免）
func TestTermPagesRenderParamsAligned(t *testing.T) {
	pages := renderAllTermPages(t, false)
	js := termLayoutJS
	for _, want := range []string{
		`const SC_TERM_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace";`,
		"const SC_TERM_FONT_SIZE = 14;",
		"const SC_TERM_MAX_FONT = 42;", // 3×产品字号放大上限（guest-only，P-20261119-2）
		"const SC_TERM_SCROLLBACK = 20000;",
		"function scTermOptions", "function scFitGrid", "function scObserve", "function scFontsReady",
	} {
		if !strings.Contains(js, want) {
			t.Fatalf("term layout js missing render constant/helper %q", want)
		}
	}
	for name, page := range pages {
		for _, want := range []string{
			"/assets/addon-unicode11.js",
			"scTermOptions({",      // 页面差异项（convertEol/theme）经 extra 注入
			"scTermUnicode(term);", // 宽度表挂载
		} {
			if !strings.Contains(page, want) {
				t.Fatalf("%s page missing render-parity wire %q", name, want)
			}
		}
	}
	// 定格快照是剥 ANSI 的纯文本（无光标定位语义）：convertEol 必须保持 true
	if !strings.Contains(pages["frozen"], "convertEol: true") {
		t.Fatal("frozen page must keep convertEol for sanitized text")
	}
}

// 直播页主机栅格（P-20261107-4）：按 hello/resize 帧的 cols×rows 精确渲染——
// resize 帧排进 xterm 写入队列（先到的字节按旧栅格解析完再换栅格），不 fit 改写列数
func TestTermLivePageHostGrid(t *testing.T) {
	page := renderAllTermPages(t, false)["live"]
	for _, want := range []string{
		"function setHost(cols, rows)",
		"scFitGrid(term, $('termBox'), hostCols, hostRows)",
		"es.addEventListener('resize'",
		"term.write('', () => setHost(m.cols, m.rows))", // 尺寸先于后续字节生效
		"const relayout = scObserve($('termBox'), layout)",
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("live page missing host-grid wire %q", want)
		}
	}
}

// 宽度优先字号布局 + overset 滚动单面化/follow（P-20261119-2 放大段 +
// P-20261120-8 必改0 宽度优先修订 + P-20261123-2 follow 收口）：scFitGrid 放大段
// 只看宽度（3× SC_TERM_MAX_FONT 封顶、0.25 步进、宽度装得下逐 0.25 校验，不再要求
// hR≥1——高会话/矮终端区此前掉收缩段被压字号网格窄条居中）；收缩段只随宽度收缩到
// 装得下为止（min(1, wR) 取代 min(1, wR, hR) 双拟合，高度溢出交给 overset 外层
// 滚动面而非压缩字号）；两段高度都不设限走共用 overset 面；scTermNeed 半边参数化
// 钳 ≥ 产品字号（只放宽不收窄——防宽主机收缩段 need→aw→fs 正反馈字号跌落，放大段
// 闭环被 cap 兜底收敛无追逐）。滚动面（P-20261123-2）：捕获相 scWheelCapture 接管
// overset 滚轮（deltaMode 归一/ctrl-meta 只拦内层/触控板小数累积/rAF 合并）、
// scEnsureCursorVisible 的 follow 语义（rowY=0 有效顶位、-1 未知哨兵、force 首载
// 定位、follow=false 绝不写）、几何真变才 force（同几何重排不拽回）与两个清态面
// （overset 撤销、scClearGrid 复位滚动位与 follow）
func TestTermPagesEnlargeFontAndScrollFollow(t *testing.T) {
	pages := renderAllTermPages(t, false)
	js := termLayoutJS
	for _, want := range []string{
		"const SC_TERM_MAX_FONT = 42;",                       // 放大上限 = 3×产品字号
		"function scWheelCapture(box, term)",                 // 捕获相滚轮接管（单面化）
		"function scEnsureCursorVisible(box, term, force)",   // follow + 光标可见性最小滚动
		"function scFollowReset(box)",                        // 重连/seek 复位 follow
		"function scCursorRowY(term)",                        // 光标行 px 锚点（-1 = 未知哨兵）
		"Math.min(wR, SC_TERM_MAX_FONT / SC_TERM_FONT_SIZE)", // 放大段：宽度比×cap
		"SC_TERM_FONT_SIZE * Math.min(1, wR)",                // 收缩段：宽度优先（必改0）
		"if (wR >= 1) {",                                     // 放大段门槛只看宽度（hR 门槛已撤）
		"fs = allowSmall ? (fs || 0) : Math.max(SC_TERM_FONT_SIZE, fs || 0)", // 半边参数化钳 ≥ 产品字号（fit 模式放开）
		// 滚轮归一与修饰键语义（P-20261123-2 ①②）
		"if (e.deltaMode === 1) return raw * cellH;",                   // line → 字高归一
		"if (e.deltaMode === 2) return raw * pageH;",                   // page → 视口高归一
		"if (e.ctrlKey || e.metaKey) { e.stopPropagation(); return; }", // 缩放放行缺省、只拦内层
		"if (e.shiftKey) return;",                                      // shift+wheel 无横向面：忽略
		// 写入稳定化（P-20261124-3 S1）：唯一 rAF 写口 + wheel 触底 ≥2px 容差
		"function scQueueWrite(box)", "function scFlushScroll(box)", "function scQueueScroll(box, top)",
		"scQueueWrite(box); // 唯一写口", "scQueueScroll(box, next)",
		"scSetFollow(box, next >= maxTop - SC_TERM_BOTTOM_EPS);",
		"const SC_TERM_BOTTOM_EPS = 2;", "const SC_TERM_USER_MS = 150;",
		"const SC_TERM_OVER_HYST = 2;", "const SC_TERM_FS_EPS = 0.25;",
		"function scFollowConfirm(box)",   // 原生滚动触底连续两帧确认
		"Date.now() - st.userTs < SC_TERM_USER_MS", // 用户手势后抑制程序写
		// follow 语义（P-20261123-2 ③）
		"if (!st.follow) return;",              // follow=false 绝不写 scrollTop
		"if (box.dataset.gridGeom !== geom) {", // 几何真变才 force（同几何不拽回）
		"return h > 0 ? cy * h : -1;",          // rowY=0 有效、未知 = -1
		"if (!anchorBottom && rowY < 0) return;", // 未知锚点不写（底部锚模式无需光标行）
		// 诊断面（P-20261123-2 ④）
		"function scTermDiag(term, box)", "window.__scTermDiag", "ydisp", "hasSb",
		"snapshot: function(){ return scDiagFields(term, box); }", "wheel-inner",
	} {
		if !strings.Contains(js, want) {
			t.Fatalf("term layout js missing scroll/follow piece %q", want)
		}
	}
	// 清态面全量：scFitGrid fits 分支与 scClearGrid 两处齐撤 overset 标记 +
	// 几何指纹（残留会把捕获相钉在吞滚轮态而容器无溢出，scrollback 导航失灵）
	if n := strings.Count(js, "delete box.dataset.overset"); n != 2 {
		t.Fatalf("overset clear points = %d, want 2 (scFitGrid fits + scClearGrid)", n)
	}
	if n := strings.Count(js, "delete box.dataset.gridGeom"); n != 2 {
		t.Fatalf("grid fingerprint clear points = %d, want 2 (scFitGrid fits + scClearGrid)", n)
	}
	// 滚动条归属（P-20261123-2 ②）：外层原生条是唯一可见面，xterm 自绘 slider 隐藏，
	// 宽度稳定（gutter + 关滚动锚定）；旧的隐藏外层条写法退役
	for _, want := range []string{
		"scrollbar-gutter:stable", "overflow-anchor:none",
		".term-box[data-overset]{scrollbar-width:thin",
		".term-box[data-overset] .xterm-scrollable-element > .scrollbar{display:none}",
		"--sc-term-sb-thumb:#30363d",
	} {
		if !strings.Contains(termLayoutCSS, want) {
			t.Fatalf("term layout css missing scrollbar ownership piece %q", want)
		}
	}
	if strings.Contains(termLayoutCSS, "[]{scrollbar-width:none") {
		t.Fatal("term layout css must not hide the outer scrollbar anymore (P-20261123-2)")
	}
	// live：data/tail 写回调跟随 + hello 后的首帧 force 定位 + 重连 follow 复位
	live := pages["live"]
	for _, want := range []string{
		"() => scEnsureCursorVisible($('termBox'), term)",
		"scEnsureCursorVisible($('termBox'), term, true);\n});",
		"term.reset(); scFollowReset($('termBox'));",
	} {
		if !strings.Contains(live, want) {
			t.Fatalf("live page missing scroll-follow wire %q", want)
		}
	}
	// cast：drain 批尾一次跟随（100ms tick 批量写面，勿逐 write 挂回调）+ seek 复位
	// follow 并把新屏光标行作默认位（force——只复位 follow 会留在旧格底阅读位）
	if !strings.Contains(pages["cast"], "scEnsureCursorVisible($('termBox'), term);\n  syncChapter();") {
		t.Fatal("cast page must follow once at the drain batch tail")
	}
	if !strings.Contains(pages["cast"], "scFollowReset($('termBox'));\n  scEnsureCursorVisible($('termBox'), term, true);") {
		t.Fatal("cast page must reset follow and re-anchor the fresh screen on seek/replay")
	}
	// frozen 软折行不进栅格/超集面路径（doFit 不同路径，评审核实）：布局件定义随
	// LayoutJS 注入三页（Contains 会命中函数定义体），断言面钉「页级调用形态零出现」
	if strings.Contains(pages["frozen"], "scFitGrid(term, $('termBox')") ||
		strings.Contains(pages["frozen"], "scWheelCapture($('termBox')") ||
		strings.Contains(pages["frozen"], "scEnsureCursorVisible($('termBox')") {
		t.Fatal("frozen page must stay on the container-fit path (no grid/overset call sites)")
	}
}

// 宽矮视口完整适配 + alt-screen 锚定 + 矮视口 chrome 压缩（P-20261123-4）静态对账：
//   - ①follow 几何抑制窗（geomTs 400ms）+ 非 own scroll 双向 truth table 在共享件
//   - ②单次收敛视口源（documentElement.clientWidth）替代 box.clientWidth 反馈
//   - ③alt-screen 判定 + onBufferChange 重排 + 底部锚（alt/fit 两分支）
//   - ④fit=window 完整适配（SC_TERM_FIT_MIN 可读下限、scTermNeed allowSmall、
//     页头开关 ?fit=/localStorage、--col-floor 放开）
//   - ⑤矮视口 chrome 压缩只注入直播页（frozen/cast 不命中）
//   - ⑥诊断面新增字段齐备
func TestTermPagesFitWindowAndAltScreen(t *testing.T) {
	js := termLayoutJS
	for _, want := range []string{
		"const SC_TERM_FIT_MIN = 12;",                    // fit 可读下限
		"function scFitMode(box)",                        // fit 模式读取
		"return m === 'window' || m === 'auto' ? m : 'width';", // auto 缺省档（P-20261124-3 S2 ①）
		"function scIsAlt(term)",                         // alt-screen 判定
		"function scOnBufferChange(term, box, relayout)", // 缓冲切换重排
		"term.buffer.onBufferChange(function(){",         // 挂接 xterm 事件
		"const anchorBottom = scIsAlt(term) || scFitMode(box) === 'window'", // 锚定基准分叉
		"Date.now() - st.geomTs < 400",                   // 几何抑制窗（follow 误清修复）
		"fsWidth: st.fsWidth || 0", "fsFit: st.fsFit || 0", // 诊断字号基线
		"altScreen: false", "fitMode: scFitMode(box)", "geomTs: st.geomTs || 0",
		"userGesture: st.userTs || 0", "visibleRows: st.visibleRows || 0",
		"out.altScreen = b.type === 'alternate';",
		"st.fsWidth = fsFit > 0 ? fsWidth : fs;", "st.fsFit = fsFit;",
		// 历史模式兜底 + diag 扩展（P-20261124-3 S2）
		"function scHistoryEnter(box, term)", "function scHistoryWheel(box, term, dy)",
		"function scHistoryExit(box, term, reposition)",
		// 无浮层页面（cast/frozen）不得进入历史滚轮路径：enter 返回 false 时
		// 调用方落回普通外层滚动（零变化），wheel 自身再防一层
		"if (dy < 0 && box.scrollTop <= 1 && scHistoryEnter(box, term)) {",
		"if (!scHistButton() || !scCanHistory(term)) return false;",
		"if (!st.hist) return;",
		"return b.type === 'normal' && b.baseY > 0;", // 只对 normal scrollback 生效
		"term.scrollLines(lines)",                    // 交还 xterm scrollback
		"if (b.viewportY >= b.baseY) scHistoryExit(box, term, true);", // 回底退出
		"out.baseY = b.baseY;", "historyMode: !!st.hist",
		"writes: []", "function scDiagWrite(box, from, to, programmatic)",
		// 观测阈值过滤（P-20261124-3 S1）
		"Math.abs(r.width - lw) < SC_TERM_RO_EPS",
	} {
		if !strings.Contains(js, want) {
			t.Fatalf("term layout js missing fit/alt-screen piece %q", want)
		}
	}
	// 稳定视口源（单次收敛）+ fit 模式列容器跟随
	for _, want := range []string{
		"const vw = document.documentElement.clientWidth;",
		"scTermNeed(hostCols, term.options.fontSize, fitEngaged())",
		"return scScrollState(b).fsFit > 0;",
	} {
		if !strings.Contains(js+renderAllTermPages(t, false)["live"], want) {
			t.Fatalf("missing single-convergence/fit width piece %q", want)
		}
	}
	live := renderAllTermPages(t, false)["live"]
	for _, want := range []string{
		"'term-fit-toggle'",                        // 页头完整显示开关
		"term-hist-back",                           // 历史模式「回到实时」浮层（P-20261124-3 S2）
		"function fitModeFromEnv()",                // ?fit= 优先 + localStorage 记忆
		"return m === 'window' || m === 'width' ? m : 'auto';", // 缺省 auto（P-20261124-3 S2 ①）
		"localStorage.getItem(FIT_KEY)",            // 记忆读取
		"applyFitMode(fitEngaged() ? 'width' : 'window', true)",
		"root.setProperty('--col-floor', '0px')",   // fit 容器跟随收窄
		"scOnBufferChange(term, $('termBox'), relayout)",
		"@media (max-height:640px){",               // 矮视口压缩
		"#app .banner{margin-top:5px;padding:4px 10px;font-size:12px}", // 安全警示完整可见（只收边距）
	} {
		if !strings.Contains(live, want) {
			t.Fatalf("live page missing fit/alt-screen wire %q", want)
		}
	}
	// cast 也挂缓冲切换重排（回放进入 alt-screen）；frozen 维持容器 fit 路径不受影响
	for _, name := range []string{"cast"} {
		if !strings.Contains(renderAllTermPages(t, false)[name], "scOnBufferChange(term, $('termBox'), relayout)") {
			t.Fatalf("%s page must wire alt-screen buffer change", name)
		}
	}
	frozen := renderAllTermPages(t, false)["frozen"]
	for _, gone := range []string{"term-fit-toggle", "@media (max-height:640px){", "scOnBufferChange(term, $('termBox'), relayout)"} {
		if strings.Contains(frozen, gone) {
			t.Fatalf("frozen page must not inherit live-only fit/chrome piece %q", gone)
		}
	}
	// 词条 zh/en 成对（按钮两态 + 提示；历史模式浮层 P-20261124-3 S2）
	for i, d := range [2]map[string]string{termDictZh, termDictEn} {
		for _, k := range []string{"fitShow", "fitZoom", "fitShowTip", "fitZoomTip", "histBack", "histBackTip"} {
			if strings.TrimSpace(d[k]) == "" {
				t.Fatalf("term dict #%d missing %s", i, k)
			}
		}
	}
	// 历史浮层只注入直播页（cast/frozen 无 #histBack，历史模式不启用零变化）
	for name, page := range renderAllTermPages(t, false) {
		if name == "live" {
			continue
		}
		if strings.Contains(page, "term-hist-back") {
			t.Fatalf("%s page must not carry the history-mode overlay", name)
		}
	}
}

func TestCastToolbarFloatsOverStage(t *testing.T) {
	page := renderAllTermPages(t, false)["cast"]
	// 回放主机栅格：流式下限收回 1180 且必须排在共用布局件之后（同特异度后者胜）
	if lo, hi := strings.Index(page, "clamp(1180px,82vw,2000px)"), strings.Index(page, ":root{--col-floor:1180px}"); lo < 0 || hi < lo {
		t.Fatalf("cast floor override must follow shared layout css (shared=%d override=%d)", lo, hi)
	}
	for _, want := range []string{
		"castCols = cols; castRows = rows", // 录制栅格
		"function castLayout()",            // 舞台驱动重排
		"scFitGrid(term, $('termBox'), castCols, castRows)",
		`id="stage"`, `data-testid="cast-toolbar"`, // 舞台 + 控件条
		".stage{position:relative", ".toolbar{position:absolute", // 浮层定位
		"body.controls-idle .toolbar", "function wakeControls", // 播放中静止淡出
		".stage .term-box{padding-bottom:64px}", // 终端末行让位
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("cast page missing floating toolbar/grid piece %q", want)
		}
	}
	// 控件条在舞台内（舞台隐藏即一并隐藏，不再与状态卡争高）
	stage := strings.Index(page, `id="stage"`)
	bar := strings.Index(page, `id="toolbar"`)
	chapters := strings.Index(page, `id="chapters"`)
	if !(stage >= 0 && stage < bar && bar < chapters) {
		t.Fatalf("toolbar must live inside the stage (stage=%d toolbar=%d chapters=%d)", stage, bar, chapters)
	}
}

// 协作位折叠条 + 浮层 + 富输入接线（P-20261107-4）：折叠态常驻一行（cl-toggle/
// cl-summary），展开内容浮于终端区之上不进列流；文字素材框与捕获相粘贴在位
func TestCollabCollapsedBarAndRichInput(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("collap1"), "zh", "live", "", true, false, false, false); err != nil {
		t.Fatalf("render: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		"'data-testid', 'cl-toggle'",                               // 折叠开关（缺省收起；脚本 setAttribute 挂载）
		"'data-testid', 'cl-summary'",                              // 折叠态状态摘要（进度/份数/待批）
		".cl-root.open .cl-panel",                                  // 浮层展开态
		"position:absolute;left:0;right:0;bottom:calc(100% + 6px)", // 向上浮层
		"'data-testid', 'cl-text'",                                 // 文字素材框
		"'data-testid', 'cl-text-send'",
		"clTextTooLong",                      // 字数上限文案
		"addEventListener('paste', (e) => {", // 粘贴链路
		"}, true);",                          // 捕获相（终端获焦时冒泡监听收不到——实锚形态①）
		"htmlImage",                          // text/html data:image 兜底（实锚形态②）
		"clPasteRemoteImg",                   // 外链图片诚实提示
		"body.cl-dragging .cl-drag-mask",     // 整页拖入提示
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("term-live page (collab on) missing %q", want)
		}
	}
}

// 可写文案矛盾修复 + 横幅合并 + 合并入口条（P-20261119-3）渲染面对账：
//   - sub 所有权二分：termpage 的 ES hello 在 SC.writable 下不触 sub（只读
//     文案 guard 在场——可写页头部不再被「无任何输入通道」钉住）；writablepage
//     WS hello 写 wrSubLive、teardown 恢复 readonlyTip；wrSubLive 双语同键
//   - roTip 初始不条件化（评审建议3：连接中通道未开时只读表述属实）
//   - 横幅合并：wr-strip 挂载点迁 #maskBanner（appendChild 右段），横幅
//     flex-wrap + ≤640px 右段独占一行（「显著不折叠」红线的窄屏裁定）
//   - 合并入口条：条壳（mountEntryBar）先于两挂载脚本注入、chip 挂载形态
//     二分（cl-root-btn/gb-root-btn 按钮级 testid，浮层 testid 不动）、条壳
//     只注入直播页（frozen/cast 留言板维持独立单条零触碰）
func TestWritableSubOwnershipBannerMergeAndEntryBar(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("merge1"), "zh", "live", "", true, false, false, true); err != nil {
		t.Fatalf("render writable live page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		"if (!SC.writable) $('sub').textContent = t('readonlyTip');",         // ES hello guard（只读页才写）
		"$('sub').textContent = t('wrSubLive');",                             // WS hello 翻可写文案（writablepage 独占）
		"// sub 同步恢复只读文案（P-20261119-3）",                                      // teardown 恢复面（roTip 旁）
		"$('roTip').textContent = t('readonlyTip');",                         // roTip 初始不条件化
		"banner.appendChild(strip)",                                          // wr-strip 挂横幅右段
		".banner{flex-wrap:wrap}",                                            // 两段同槽换行兜底
		".banner .wr-strip{flex-basis:100%",                                  // ≤640px 右段独占行
		"mountEntryBar",                                                      // 合并条条壳脚本
		"'data-testid', 'cl-toggle'",                                         // 协作展开开关（既有断言面保持）
		"'cl-root-btn'",                                                      // 协作 chip 按钮级 testid
		"'gb-root-btn'",                                                      // 留言 chip 按钮级 testid
		"'data-testid', 'sc-entrybar'",                                       // 条壳标记
		".sc-entrybar .cl-root,.sc-entrybar .gb-root{position:static;flex:1", // chip 覆写形态（浮层锚条定位前提）
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("writable term-live page missing %q", want)
		}
	}
	// wrSubLive 双语同键（循 TestUnfilteredBannerDictParity 先例）
	for i, d := range [2]map[string]string{termDictZh, termDictEn} {
		if strings.TrimSpace(d["wrSubLive"]) == "" {
			t.Fatalf("term dict #%d missing wrSubLive", i)
		}
	}
	// 条壳只注入直播页：frozen/cast 无 mountEntryBar（留言板独立单条零触碰；
	// guestBoardJS 里的 sc-entrybar 查询字符串全页同源，不作为注入判据）
	for name, page := range renderAllTermPages(t, false) {
		if name == "live" {
			continue
		}
		if strings.Contains(page, "mountEntryBar") {
			t.Fatalf("%s page must not carry the merged entry bar shell", name)
		}
	}
}

// 可写视口反喂 resize 接线（P-20261120-8 + P-20261122-16 状态机治理）：驱动只在
// 可写页挂载（SC.writable 门控，只读页零驱动零上行——「只读页不新增 resize 上行」
// 红线）；termpage 侧两枚钩子（SSE resize 帧回声对账 wrHostResize + layout 几何
// kick wrLayoutHook）全页在场但只读页保持 null 零开销；hello 开通 / teardown 停用 /
// resize_applied 诚实回执（wrResized 双语）/ 拒绝原因分档（owner_active 退避 /
// external_session 停用）四面齐；P-20261122-16 的三条硬约束各有锚：①目标从视口
// 算（不读 termBox.clientWidth——+2 列回读环根因）②双态确认（无本地乐观 setHost）
// ③状态刷新不重置反喂态（setTyping 只在 0→1 边初始化）
func TestWritableViewportResizeWire(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("vprsz01"), "zh", "live", "", false, false, false, true); err != nil {
		t.Fatalf("render writable live page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		"let wrHostResize = null;",                                           // 回声对账钩子声明（termpage 侧）
		"let wrLayoutHook = null;",                                           // 几何 kick 钩子声明（termpage 侧）
		"if (wrHostResize) wrHostResize(m.cols, m.rows);",                    // SSE resize 帧挂回声对账
		"if (wrLayoutHook) wrLayoutHook();",                                  // layout 重排点挂几何 kick
		"const VP_DEBOUNCE_MS = 250;",                                        // 前端防抖（评审定案 200-300ms 邻域）
		"const VP_MIN_DELTA = 2;",                                            // |目标−已确认栅格|≥2 才发（1 格抖动不发）
		"const VP_OWNER_SUPPRESS_MS = 10000;",                                // 主人侧动作抑制窗
		"const VP_CONFIRM_MS = 2000;",                                        // 双态确认窗（P-20261122-16 ②）
		"const VP_MIN_FEED_COLS = 80;",                                       // 窄屏下限：<80 列不反喂（⑤）
		"function vpTarget(){",                                               // 视口目标栅格计算
		"document.documentElement.clientWidth",                               // 目标从视口算（根因 A：不读 termBox）
		"Math.min(500, Math.floor(aw / cell.w))",                             // cols 上限与服务端同域（<80 前端不喂）
		"Math.max(2, Math.min(300, Math.floor(ah / cell.h)))",                // rows 钳制与服务端同域
		"JSON.stringify({ type: 'resize', cols: tgt.cols, rows: tgt.rows })", // 控制面上行
		"function setTyping(on){",                                            // 键入资格闸（P-20261121-1 双模式）
		"if (on && !was) {",                                                  // 反喂态只在 0→1 边初始化（③）
		"vp.ownerHold = true;",                                               // 主人动作棘轮（④）
		"vp.retryAt = Date.now() + VP_OWNER_RETRY_MS;",                       // owner_active 30s 退避（不永久停）
		"resize_denied",                                                      // 拒绝帧处理在位（原因分档）
		"showStrip('on', t('wrResized'));",                                   // resize_applied 诚实回执
		"vp.appliedCols = m.cols; vp.appliedRows = m.rows;",                  // applied 锚（SSE 回声不误判主人动作）
		"wrHostResize = function(cols, rows){",                               // 回声门注入（自源回声 vs 主人动作分流）
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("writable live page missing viewport-resize wire %q", want)
		}
	}
	// 本地乐观先行已退役（P-20261122-16 ②）：发送前不得 setHost——改格只由
	// 确认帧驱动（applied/SSE 同值回声）；乐观先行后无回滚会让节流/合并窗/
	// TmuxExternal 拒绝的栅格永远停在「以为自己改成了」的值
	sendIdx := strings.Index(out, "function vpSend(){")
	sendEnd := strings.Index(out, "function vpStripText(){")
	if sendIdx < 0 || sendEnd < sendIdx {
		t.Fatal("vpSend must be present before vpStripText")
	}
	if strings.Contains(out[sendIdx:sendEnd], "setHost(") {
		t.Fatal("vpSend must not optimistically setHost before confirmation (P-20261122-16 C)")
	}
	// 状态刷新的幂等性：applyDirectState 的 held 分支走 vpStripText（不改反喂态）
	if !strings.Contains(out, "showStrip('on', vpStripText());") {
		t.Fatal("held state refresh must render vpStripText (state poll must not reset vp)")
	}
	// wrResized / wrOwnerActive 双语同键（循 wrSubLive parity 先例）
	for i, d := range [2]map[string]string{termDictZh, termDictEn} {
		for _, key := range []string{"wrResized", "wrOwnerActive"} {
			if strings.TrimSpace(d[key]) == "" {
				t.Fatalf("term dict #%d missing %s", i, key)
			}
		}
	}
	// 只读页零驱动（SC.writable||SC.guestInput 门控在可写位挂载入口）：
	// writableJS 全页注入、运行态门控是 P-20261106-8 既有形态，P-20261121-1
	// 双模式准入；P-20261122-19 起双关页仍进入生命周期外壳做 5s state 探测
	// （只读 HTTP GET，主人开启后惰性挂载）——WS 上行/键入/反喂驱动代码必须
	// 仍位于挂载门控之后（未挂载不可达 = 零上行零驱动）
	var ro strings.Builder
	if err := renderTermPage(&ro, fixedToken("vprsz02"), "zh", "live", "", false, false, false, false); err != nil {
		t.Fatalf("render readonly live page: %v", err)
	}
	roOut := ro.String()
	gate := strings.Index(roOut, "if (!SC.writable && !SC.guestInput) return;")
	drv := strings.Index(roOut, "function vpTarget(){")
	if gate < 0 {
		t.Fatal("mountWritable gate missing")
	}
	if drv >= 0 && drv < gate {
		t.Fatal("viewport-resize driver must live after the SC.writable gate")
	}
}

func TestUnfilteredBannerRendering(t *testing.T) {
	on := renderAllTermPages(t, true)
	off := renderAllTermPages(t, false)
	for _, name := range []string{"live", "frozen"} {
		if !strings.Contains(on[name], `class="banner unfiltered"`) {
			t.Fatalf("%s unfiltered page must render the danger banner class", name)
		}
		if !strings.Contains(on[name], `"unfiltered":true`) {
			t.Fatalf("%s unfiltered page must carry boot key unfiltered", name)
		}
		if !strings.Contains(on[name], "SC.unfiltered ? 'unfilteredBanner' : 'maskBanner'") {
			t.Fatalf("%s page must pick the banner text from SC.unfiltered", name)
		}
		if strings.Contains(off[name], `class="banner unfiltered"`) || strings.Contains(off[name], `"unfiltered":true`) {
			t.Fatalf("%s masked page must not render unfiltered markers", name)
		}
		if !strings.Contains(off[name], `class="banner"`) {
			t.Fatalf("%s masked page lost the mask banner", name)
		}
	}
	// 回放不承载未过滤（源数据在录制层写盘前已遮蔽）：恒无危险横幅
	if strings.Contains(on["cast"], `class="banner unfiltered"`) {
		t.Fatal("cast page must never render the unfiltered banner")
	}
}

func TestUnfilteredBannerDictParity(t *testing.T) {
	for name, dicts := range map[string][2]map[string]string{
		"live":   {termDictZh, termDictEn},
		"frozen": {termFrozenDictZh, termFrozenDictEn},
	} {
		for i, d := range dicts {
			if strings.TrimSpace(d["unfilteredBanner"]) == "" {
				t.Fatalf("%s dict #%d missing unfilteredBanner", name, i)
			}
		}
	}
}

// SSE 端点：分享记录的 Unfiltered 原样透传给直播源（遮蔽是 live 源参数，
// 页面不做任何过滤）——遮蔽记录透传 false，未过滤记录透传 true
func TestStreamPassesUnfilteredToLiveSource(t *testing.T) {
	for _, unfiltered := range []bool{false, true} {
		token := fixedToken("unf")
		shares := fakeShares{token: {
			Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-u",
			Name: "直播", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(store.TerminalLiveTTL),
			Unfiltered: unfiltered,
		}}
		doneCh := make(chan struct{})
		close(doneCh)
		live := &stubLive{done: doneCh, ended: true}
		svc := NewService(shares, fakeRoots{}, nil).WithTerminalLive(live)
		rec := httptest.NewRecorder()
		svc.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/s/"+token+"/stream", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("stream status = %d", rec.Code)
		}
		if len(live.unfiltered) != 1 || live.unfiltered[0] != unfiltered {
			t.Fatalf("live source got unfiltered=%v, want [%v]", live.unfiltered, unfiltered)
		}
	}
}

// 访客页入口按记录渲染：未过滤直播记录的页面带危险横幅类
func TestTerminalGuestPageUnfilteredFromRecord(t *testing.T) {
	token := fixedToken("unfpage")
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-p",
		Name: "直播", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(store.TerminalLiveTTL),
		Unfiltered: true,
	}}
	svc := NewService(shares, fakeRoots{}, nil)
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/s/"+token, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, `class="banner unfiltered"`) {
		t.Fatal("unfiltered live record must render the danger banner on the guest page")
	}
}

// ── 观看侧四件 + 粘贴上传链接线（P-20261122-1 渲染级回归，循
// TestWritableViewportResizeWire 先例）──

// 必改9 词表双语 parity：粘贴上传/选区复制/搜索条新键 zh/en 同步
// （TestUnfilteredBannerDictParity 同族；P-20261122-18 增上传按钮/无文件
// 提示/无持权提示三键；P-20261123-1 增输入框聚焦提示 puFocusTerm）
func TestWritableCapabilityDictParity(t *testing.T) {
	keys := []string{
		"puUploading", "puDone", "puTooMany", "puUnsupported", "puFailOne", "puFailed", "puTooLarge", "puPrecheckTooLarge",
		"puUploadBtn", "puNoFile", "puNeedHold", "puFocusTerm",
		"cpCopy", "cpCopied", "cpCopyFailed",
		"seToggle", "seSearch", "sePrev", "seNext", "seClose", "seNoResult",
	}
	for i, d := range [2]map[string]string{termDictZh, termDictEn} {
		for _, k := range keys {
			if strings.TrimSpace(d[k]) == "" {
				t.Fatalf("term dict #%d missing %s", i, k)
			}
		}
	}
	// P-20261123-1 ④：readonlyTip 常驻兜底须如实提及粘贴图片/文件（闸前提示
	// 2.4s 自灭，常驻文案是错过提示后的自助入口说明）
	if !strings.Contains(termDictZh["readonlyTip"], "粘贴图片/文件") {
		t.Fatalf("zh readonlyTip must mention pasting images/files: %q", termDictZh["readonlyTip"])
	}
	if !strings.Contains(termDictEn["readonlyTip"], "paste images/files") {
		t.Fatalf("en readonlyTip must mention pasting images/files: %q", termDictEn["readonlyTip"])
	}
}

// 观看侧四件接线：直播页挂 vendored 四 script（frozen/cast 定格页明确排除出
// 范围，评审裁定 D 防蔓延）；web-links/webgl 主 script 通用挂载（授权模式无关
// 裁定 D）、ImageAddon 条件件=SC.unfiltered 才挂载（遮蔽开=禁用，必改8）、
// webgl navigator.webdriver 跳过（保 Playwright DOM 渲染断言面，必改7）
func TestTermPageWatchingAddonsWire(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("watch01"), "zh", "live", "", false, false, false, true); err != nil {
		t.Fatalf("render writable live page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		`<script src="/assets/addon-web-links.js"></script>`,
		`<script src="/assets/addon-search.js"></script>`,
		`<script src="/assets/addon-webgl.js"></script>`,
		`<script src="/assets/addon-image.js"></script>`,
		"new WebLinksAddon.WebLinksAddon()",
		"new ImageAddon.ImageAddon()",
		"if (SC.unfiltered)",                // ImageAddon 遮蔽闸（条件挂载在 unfiltered 分支内）
		"new WebglAddon.WebglAddon()",       // WebGL 渲染
		"webgl.onContextLoss(",              // 上下文丢失 dispose 降级 DOM
		"if (navigator.webdriver !== true)", // webdriver 跳过惯例（share-terminal-live 断言面）
		"new SearchAddon.SearchAddon()",     // 搜索条依赖 addon（writableJS 段内）
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("term live page missing watching-addon wire %q", want)
		}
	}
	// frozen/cast 排除：定格/回放页不挂观看侧四件（裁定 D 防蔓延）
	for name, page := range renderAllTermPages(t, false) {
		if name == "live" {
			continue
		}
		for _, tag := range []string{"addon-web-links.js", "addon-search.js", "addon-webgl.js", "addon-image.js"} {
			if strings.Contains(page, tag) {
				t.Fatalf("%s page must not carry %s (frozen/cast out of scope)", name, tag)
			}
		}
	}
}

// 聚焦态 Ctrl/Cmd+V 放行接线（P-20261123-3）：xterm 的 _keyDown 只在 custom
// handler 返回 false 时提前放行——否则 Ctrl+V 被译成 \x16 发 PTY 并
// preventDefault+stopPropagation，浏览器原生 paste 永不派发（聚焦终端后文件/
// 图片粘贴链整条失联）。三面钉住：①handler 在 mountWritable 函数体内（可写位
// 在场才挂，只读双关页无 handler 保持 xterm 原行为）；②keydown 守卫 + ctrl/meta
// 双修饰 + AltGr（ctrl+alt）/Ctrl+Shift+V 排除 + e.code 兜底；③条件与 return
// false 同块、其余按键回 true——条件拆行/改序后「锚点在但 handler 不生效」的
// 假接线必须红。
func TestWritablePasteKeyPassthroughWire(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("pkeyv1"), "zh", "live", "", false, false, false, true); err != nil {
		t.Fatalf("render writable live page: %v", err)
	}
	out := b.String()
	// xterm 单 handler 槽位：恰一处 attach（二次 attach 静默覆盖前一个 handler，
	// 未来分享页快捷键必须并入同一函数并同步本断言）
	if n := strings.Count(out, "term.attachCustomKeyEventHandler("); n != 1 {
		t.Fatalf("xterm single custom-key-handler slot: want exactly 1 attach, got %d", n)
	}
	mount := strings.Index(out, "function mountWritable(){")
	mountEnd := strings.Index(out, "} // mountWritable")
	attach := strings.Index(out, "term.attachCustomKeyEventHandler((e) => {")
	if mount < 0 || mountEnd < mount || attach < mount || attach > mountEnd {
		t.Fatal("custom key handler must attach inside mountWritable (writable/guestInput only)")
	}
	h := out[attach:]
	end := strings.Index(h, "\n  });")
	if end < 0 {
		t.Fatal("custom key handler block not terminated")
	}
	h = h[:end]
	// 逐行序 + 完整条件串：keydown 守卫 → mod → isV（code 兜底）→ 放行条件 →
	// fallback true（游标推进式查找：末尾 return true 不会被守卫行的同名子串截走）
	prev := 0
	for _, want := range []string{
		"if (e.type !== 'keydown') return true;",
		"const mod = e.ctrlKey || e.metaKey;",
		"const isV = e.code === 'KeyV' || (e.key && e.key.toLowerCase() === 'v');",
		"if (mod && !e.altKey && !e.shiftKey && isV) return false;",
		"return true;",
	} {
		idx := strings.Index(h[prev:], want)
		if idx < 0 {
			t.Fatalf("custom key handler missing or out of order %q", want)
		}
		prev += idx + len(want)
	}
	if strings.Count(h, "return false") != 1 {
		t.Fatal("only the Ctrl/Cmd+V branch may return false (other keys must reach xterm)")
	}
}

// 粘贴上传链+选区复制+搜索条接线（必改2/3/4/6）：可写位 JS 段的仲裁监听/
// 上传端点/压缩链/term.paste/复制/搜索标记面；只读页门控早退先行（驱动与
// UI 挂载在门后，只读渲染产物里不可达——TestWritableViewportResizeWire 同款
// 死代码不可达断言）
func TestWritablePasteChainWire(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("pchain1"), "zh", "live", "", false, false, false, true); err != nil {
		t.Fatalf("render writable live page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		"const PASTE_FILE_MAX_COUNT = 5;",           // 单批 ≤5（两端同参数，裁定 A）
		"const PU_MAX_EDGE = 1920;",                 // 压缩链 vanilla 移植（主人端同值）
		"async function compressPasteImage(file){",  // 压缩入口
		"'/s/' + SC.token + '/paste-upload'",        // 上传端点（访客页 fetch）
		"window.addEventListener('paste', (e) => {", // 仲裁监听（window 捕获相）
		// P-20261123-1：闸前不再静默——诊断前置记账 + 闸值分档 + 原因提示
		//（旧锚点 "if (!canType || !wsOpen) return;" 退休：该早退使主失败形态
		// 在 ?paste=diag 下零记录）
		"const gate = !wsOpen ? 'need_conn' : (!canType ? 'need_hold' : 'ok');", // 闸值三态
		"targetKind: targetKind,", // 目标分类与闸值分开记
		"gate: gate,",
		"holdMode: !!holdMode,",
		"directStatus: lastDirectStatus,",
		"if (gate !== 'ok') {",          // 无资格：给原因后 return（不再静默）
		"function pasteTargetKind(el){", // 目标优先判定（term/input/body）
		"function gateReasonTip(){",     // 原因分档
		"pasteTip('need_hold', t('puNeedHold'));",
		"if (lastDirectStatus === 'none') reqBoxFlash();",              // 申请槽在场：指入口
		"if (!msg || SC.collab) return;",                               // collab 只记诊断不弹提示
		"const GATE_TIP_MS = 10000;",                                   // 同原因 10s 限频
		"if (gate === 'ok') pasteTip('focus_term', t('puFocusTerm'));", // 输入框带文件
		"e.preventDefault(); e.stopPropagation();",                     // 抢先（先于 collab document 监听）
		"term.paste(paths.join('\\n'));",                               // 路径入输入行（bracketed paste）
		"async function copyText(text){",                               // 选区复制降级链
		"(e.ctrlKey || e.metaKey) && e.shiftKey",                       // 快捷键双修饰约定
		"'data-testid', 'wr-copy'",                                     // 复制钮
		"'data-testid', 'wr-search-toggle'",                            // 搜索开关
		"'data-testid', 'wr-search-input'",                             // 搜索条输入
		"searchAddon.findNext(q, opts)",                                // addon-search 消费
		// P-20261122-18：常驻上传按钮（跨浏览器文件投递保底）/ 诊断环形缓冲 /
		// 无文件提示收紧 / clipboard.read 图片补链（降级）/ image CT 四类对齐
		"'data-testid', 'wr-upload'",                           // 上传按钮（wr-actions 常驻）
		"'data-testid', 'wr-upload-input'",                     // 隐藏 file input（multiple）
		"fileInput.value = '';",                                // 选完重置（同文件可再选）
		"if (!canType) { flashTip(t('puNeedHold')); return; }", // 无持权提示先申请
		"window.__scPasteDiag",                                 // ?paste=diag 诊断面
		"const PU_DIAG_MAX = 10;",                              // 环形缓冲 10 条
		"function puDiagAdd(ev, fields){",                      // 诊断入口（仅元数据）
		"no clipboard content, file names or paths",            // 红线注记：绝不记内容/文件名
		"function tipNoClipboardFile(){",                       // 无文件+无文本提示（30s 限频）
		"if (now - puNoFileTipAt < 30000) return;",
		"async function tryClipboardImage(){", // 图片补链（async read，明确降级）
		"navigator.clipboard.read()",
		"function pasteHtmlImage(html){", // text/html 内联 data:image 兜底
		"const PASTE_IMAGE_CT = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);",
		"const textPlain = dt.getData('text/plain') || '';", // 文本优先判定
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("writable live page missing paste-chain wire %q", want)
		}
	}
	// 捕获相仲裁：监听注册第三参 true，且挂 window——collab 的 document 捕获
	// 监听注册在前（同目标同相按注册序），document 级无法抢占；window 捕获恒
	// 先于 document（实测锚点：document 级旧写法使 share-collab 仲裁用例收件箱误收）
	if !strings.Contains(out, "window.addEventListener('paste', (e) => {") ||
		!strings.Contains(out, "}, true);") {
		t.Fatal("paste arbitration listener must register on window in capture phase")
	}
	// 只读页不可达：门控（SC.writable||SC.guestInput）先于粘贴链/搜索条挂载
	//（P-20261122-19 起双关页只做 state 探测等待，能力面仍由挂载门控隔离）
	var ro strings.Builder
	if err := renderTermPage(&ro, fixedToken("pchain2"), "zh", "live", "", false, false, false, false); err != nil {
		t.Fatalf("render readonly live page: %v", err)
	}
	roOut := ro.String()
	gate := strings.Index(roOut, "if (!SC.writable && !SC.guestInput) return;")
	if gate < 0 {
		t.Fatal("mountWritable gate missing")
	}
	for _, marker := range []string{
		"async function compressPasteImage(file){",
		"'data-testid', 'wr-search-toggle'",
		"'data-testid', 'wr-copy'",
	} {
		idx := strings.Index(roOut, marker)
		if idx >= 0 && idx < gate {
			t.Fatalf("capability marker %q must live after the readonly gate", marker)
		}
	}
}

// 闸前粘贴可见反馈（P-20261123-1）：用户主诉「Ctrl+V 粘图片/文件没反应」的
// 主失败形态 = hold 未持权/未连线时闸前静默。本测试钉四件事：①诊断前置到
// 权限/输入框两闸之前（旧序 !canType || !wsOpen 早退使 ?paste=diag 零记录）；
// ②targetKind 与 gate 分记并带 holdMode/directStatus（lastDirectStatus 在
// applyDirectState 入口更新）；③闸门分支只给提示不 preventDefault（丢弃语义
// 不变）且同原因 10s 限频、collab 开不弹新提示；④申请槽高亮样式与
// prefers-reduced-motion 降级在场。
func TestWritablePasteGateFeedbackWire(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("pgate1"), "zh", "live", "", false, false, false, true); err != nil {
		t.Fatalf("render writable live page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		"let lastDirectStatus = 'none';", // 状态源声明（闸前原因分档用）
		"lastDirectStatus = st;",         // applyDirectState 入口更新
		"function reqBoxFlash(){",        // 申请槽高亮（仅状态 none + 槽在场）
		"reqBox.classList.add('wr-req-flash');",
		".wr-req-flash{animation:wrReqFlash 1.2s ease-out 1;border-radius:999px}",
		"@keyframes wrReqFlash{",
		"@media (prefers-reduced-motion:reduce){",
		"reason: 'gated'",      // 终端/body 无资格：诊断可定位
		"reason: 'input-text'", // 输入框纯文本：零动作（原生语义不动）
		"reason: 'input-files'",
		"if (!msg || SC.collab) return;", // collab 开只记诊断不弹提示
		"if (SC.collab) return;",         // 原因分档/申请槽高亮整段在 collab 下关闭
		"const GATE_TIP_MS = 10000;",     // 同原因 10s 限频（per-reason 时间戳）
		"if (now - (gateTipAt[reason] || 0) < GATE_TIP_MS) return;",
		"pasteTip('waiting', t('wrWaiting'));",    // pending → 等待批准
		"pasteTip('other', t('wrOther'));",        // 他人持权
		"pasteTip('need_conn', t('connecting'));", // 未连线复用既有词条
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("writable live page missing paste-gate feedback wire %q", want)
		}
	}
	// 判定顺序（诊断前置）：targetKind/gate 定值 → meta 记账 → 输入框分流 →
	// 权限闸分流
	seq := []string{
		"const targetKind = pasteTargetKind(e.target);",
		"const gate = !wsOpen ? 'need_conn' : (!canType ? 'need_hold' : 'ok');",
		"const meta = {",
		"if (targetKind === 'input') {",
		"if (gate !== 'ok') {",
	}
	prev := -1
	for _, marker := range seq {
		idx := strings.Index(out, marker)
		if idx < 0 {
			t.Fatalf("paste gate ordering marker missing: %q", marker)
		}
		if idx < prev {
			t.Fatalf("paste gate ordering broken at %q (诊断/闸门次序必须前置)", marker)
		}
		prev = idx
	}
	// 闸门分支不拦缺省动作：从权限闸到文件分支之间不得出现 preventDefault
	//（只可见化不改丢弃语义——collab 链/浏览器原语义照旧）
	gateIdx := strings.Index(out, "if (gate !== 'ok') {")
	fileIdx := strings.Index(out[gateIdx:], "if (files.length) {")
	if fileIdx < 0 {
		t.Fatal("paste files branch missing after the gate branch")
	}
	if seg := out[gateIdx : gateIdx+fileIdx]; strings.Contains(seg, "preventDefault") {
		t.Fatal("gate feedback branch must not preventDefault (drop semantics unchanged)")
	}
}

// 拖拽导航守卫（P-20261122-14 必改1，P-20261122-20 上提为五页族共享件）：
// 缺省动作（导航到本地文件）会整页替换丢终端视图——守卫统一由 dragguard.go
// guestDragGuardJS 注入（见 dragguard_test.go 的 TestDragGuardWireFivePages），
// 直播页只在 collab 关时注册（tip 复用既有词表键 wrDragNoUpload）。本测试钉
// 可写页侧的两件事：①共享守卫确实挂上（enabled 闸 + Files 判定 + 提示词表键）；
// ②writablepage 旧 document 级监听已删——双监听会让同一次投放双
// preventDefault/双提示（P-20261122-20 防回归锚点）。
func TestWritableDragGuardWire(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("dragg1"), "zh", "live", "", false, false, false, true); err != nil {
		t.Fatalf("render writable live page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		"function scDragGuard(opts){",                                     // 共享注入件在场
		"scDragGuard({ enabled: !SC.collab, tip: t('wrDragNoUpload') });", // 直播页注册点：collab 闸 + 既有词表键
		"Array.from(ty).indexOf('Files') >= 0",                            // 仅 Files 载荷（不读字节）
		"document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });",
		"document.addEventListener('drop', (e) => {",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("writable live page missing shared drag-guard wire %q", want)
		}
	}
	// 旧监听已删（writablepage 不再自挂 dragover/drop；遗留的 flashTip 仅服务
	// 粘贴/上传链的 .pu-tip，不与守卫的 .drag-tip 同源）
	if strings.Contains(writableJS, "addEventListener('dragover'") ||
		strings.Contains(writableJS, "addEventListener('drop'") {
		t.Fatal("writablepage must not register its own drag listeners (P-20261122-20 moved the guard to dragguard.go)")
	}
	// collab 闸先于监听注册：collab 开时零注册（收件箱 drop 已 preventDefault+
	// upload，双重收口会同一次投放双上传）
	helper := strings.Index(out, "function scDragGuard(opts){")
	if helper < 0 {
		t.Fatal("shared drag guard helper not injected on live page")
	}
	gate := strings.Index(out[helper:], "if (opts.enabled === false) return;")
	listen := strings.Index(out[helper:], "document.addEventListener('dragover'")
	if gate < 0 || listen < 0 || gate > listen {
		t.Fatal("drag guard must short-circuit on opts.enabled === false before registering listeners")
	}
}

// 拖拽/粘贴语义文案纠偏（P-20261122-14 必改2）：粘贴已归终端键入通道——
// clDropHint 删「粘贴 / / Paste or」半句，clDragHint 补「发到终端请 Ctrl+V」；
// wrDragNoUpload 为可写页拖放兜底提示（zh/en 成对）。
func TestDragHintCopyCorrection(t *testing.T) {
	if got := termDictZh["clDropHint"]; strings.Contains(got, "粘贴") {
		t.Fatalf("clDropHint must not mention pasting (terminal channel owns it): %q", got)
	}
	if got := termDictEn["clDropHint"]; strings.Contains(strings.ToLower(got), "paste") {
		t.Fatalf("clDropHint (en) must not mention pasting: %q", got)
	}
	for i, d := range [2]map[string]string{termDictZh, termDictEn} {
		if !strings.Contains(d["clDragHint"], "Ctrl+V") {
			t.Fatalf("term dict #%d clDragHint must point typing-bound drops at Ctrl+V: %q", i, d["clDragHint"])
		}
		if strings.TrimSpace(d["wrDragNoUpload"]) == "" {
			t.Fatalf("term dict #%d missing wrDragNoUpload", i)
		}
	}
	if !strings.Contains(termDictZh["wrDragNoUpload"], "Ctrl+V") ||
		!strings.Contains(termDictEn["wrDragNoUpload"], "Ctrl+V") {
		t.Fatal("wrDragNoUpload must tell the visitor to use Ctrl+V")
	}
}

// 可写上行桥生命周期收口（P-20261122-19）接线面对账：停止条件与开启感知
// 必须由 /writable/state 探测（WS close 拿不到 404/410/401，升级失败通常
// 落到 1006）；任意 close 统一退避 1s→2s→5s→10s；双关页惰性挂载
// （window.__scMountWritable，不 reload 丢 scrollback）；收回/关闭原因用
// 独立 notice（≥6s，不被 wr-strip 的 teardown/none 分支清掉）。
func TestWritableLifecycleWire(t *testing.T) {
	var b strings.Builder
	// 双关页也渲染同一资产：生命周期外壳常驻（只读 GET 探测），能力面仍由
	// 挂载门控隔离
	if err := renderTermPage(&b, fixedToken("wlife1"), "zh", "live", "", false, false, false, false); err != nil {
		t.Fatalf("render readonly live page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		"function writableLifecycle(){",                                             // 生命周期外壳（与挂载解耦）
		"/writable/state",                                                           // 停止/开启判定唯一事实源
		"const IDLE_POLL_MS = 5000;",                                                // 双关/无连接等待档
		"const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000];",                   // 退避 1s→10s 封顶
		"if (res.status === 401) { endPolling(t('wrPassExpired'), true); return; }", // 口令失效停止并回口令页
		"if (res.status === 404 || res.status === 410) { endPolling(t('wrGone'), false); return; }",
		"if (res.redirected) { endPolling('', true); return; }", // 一次性确认 cookie 失效
		"window.__scMountWritable = mountWritable;",             // 双关页惰性挂载入口
		"schedulePoll(IDLE_POLL_MS);",                           // 双关 5s 等待
		"let pollTimer = 0;",                                    // 唯一 state 定时器
		"ws.onclose = () => {",                                  // 任意 close（含 hello 前）统一收口
		"schedulePoll(nextBackoffDelay());",
		"case 'denied':", // writer_limit 可见提示 + close 退避
		"showNotice(m.reason === 'channel_closed' ? t('wrClosed') : t('wrRevoked'));",
		"showNotice(t('wrOwnerOff'));", // writable_off 原因公告
		"const NOTICE_MS = 6500;",      // ≥6s：至少跨过一轮 5s 重连/对账
		"'data-testid', 'wr-notice'",   // 独立于 wr-strip 的公告面
		".wr-notice{",                  // 公告样式（横幅右段胶囊，窄屏独占行）
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("writable lifecycle wire missing %q", want)
		}
	}
	// 旧 5s setInterval 轮询形态退役（P-20261122-19：探测与退避统一为一个
	// state 定时器，禁双跑）；hold 的 10s 对账是另一条只在 WS 在场时跑的链
	if strings.Contains(out, "setInterval(async") {
		t.Fatal("legacy interval-based schedulePoll must be gone (single state timer)")
	}
	// 门控早退仍在挂载入口：双关页的探测不建 UI/不接 WS；开关注入挂载前置
	gate := strings.Index(out, "if (!SC.writable && !SC.guestInput) return;")
	drv := strings.Index(out, "function vpTarget(){")
	if gate < 0 || (drv >= 0 && drv < gate) {
		t.Fatal("mount gate must stay before the viewport driver / wiring")
	}
	// 新公告词条双语同键非空（循 wrSubLive parity 先例）
	for i, d := range [2]map[string]string{termDictZh, termDictEn} {
		for _, key := range []string{"wrOwnerOff", "wrGone", "wrPassExpired"} {
			if strings.TrimSpace(d[key]) == "" {
				t.Fatalf("term dict #%d missing %s", i, key)
			}
		}
	}
}
