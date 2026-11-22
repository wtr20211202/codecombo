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
	// live/cast 双滚动条收敛件（overset 标记 + 滚轮路由 + 死槽收敛）随共用
	// 布局件在场；frozen 软折行无 scFitGrid，收敛件只随布局 CSS/JS 注入存在
	for _, name := range []string{"live", "cast"} {
		if !strings.Contains(pages[name], "scWheelRoute") {
			t.Fatalf("%s page must wire the overset wheel route", name)
		}
	}
	if !strings.Contains(pages["live"], "scWheelRoute(term, $('termBox'))") {
		t.Fatal("live page must route the wheel after term open")
	}
	if !strings.Contains(pages["cast"], "scWheelRoute(term, $('termBox'))") {
		t.Fatal("cast page must route the wheel after term open")
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
	if !strings.Contains(pages["live"], "scTermNeed(hostCols, term.options.fontSize)") {
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

// 宽度优先字号布局 + overset 底部跟随（P-20261119-2 放大段 + P-20261120-8 必改0
// 宽度优先修订）：scFitGrid 放大段只看宽度（3× SC_TERM_MAX_FONT 封顶、0.25 步进、
// 宽度装得下逐 0.25 校验，不再要求 hR≥1——高会话/矮终端区此前掉收缩段被压字号
// 网格窄条居中）；收缩段只随宽度收缩到装得下为止（min(1, wR) 取代 min(1, wR, hR)
// 双拟合，高度溢出交给 overset 钉底而非压缩字号）；两段高度都不设限走共用 overset
// 面；scTermNeed 半边参数化钳 ≥ 产品字号（只放宽不收窄——防宽主机收缩段 need→aw
// →fs 正反馈字号跌落，放大段闭环被 cap 兜底收敛无追逐）；scPinBottom 条件钉底挂点
// （钉到最新输出行=scCursorRowY 光标行锚，live data/tail 写回调 + setHost 尾部、
// cast drain 批尾一次钉勿逐 write 挂）与两个清态面（overset 撤销复位钉底态与
// scrollTop、scClearGrid 同撤）
func TestTermPagesEnlargeFontAndPinBottom(t *testing.T) {
	pages := renderAllTermPages(t, false)
	js := termLayoutJS
	for _, want := range []string{
		"const SC_TERM_MAX_FONT = 42;",                       // 放大上限 = 3×产品字号
		"function scPinBottom(box, force, rowY)",             // 条件钉底 helper（rowY=光标行顶锚）
		"function scCursorRowY(term)",                        // 光标行 px 锚点（最新输出行）
		"Math.min(wR, SC_TERM_MAX_FONT / SC_TERM_FONT_SIZE)", // 放大段：宽度比×cap
		"SC_TERM_FONT_SIZE * Math.min(1, wR)",                // 收缩段：宽度优先（必改0）
		"if (wR >= 1) {",                                     // 放大段门槛只看宽度（hR 门槛已撤）
		"fs = Math.max(SC_TERM_FONT_SIZE, fs || 0)",          // 半边参数化钳 ≥ 产品字号
		"scPinBottom(box, true, scCursorRowY(term))",         // 重排进入 overset 强制回钉
	} {
		if !strings.Contains(js, want) {
			t.Fatalf("term layout js missing enlarge/pin piece %q", want)
		}
	}
	// 清态面全量：scPinBottom（fits 守卫/上滚解钉两处）+ scFitGrid fits 分支 +
	// scClearGrid——四处齐才算清干净（残留钉底态在非溢出容器空转/顶对齐误判）
	if n := strings.Count(js, "delete box.dataset.pinBottom"); n != 4 {
		t.Fatalf("pin-bottom state clear points = %d, want 4 (scPinBottom×2 + scFitGrid + scClearGrid)", n)
	}
	// live：data/tail 写回调钉底（宽字符流经 write 回调挂点）+ setHost 尾部同钉
	live := pages["live"]
	for _, want := range []string{
		"term.write(b64bytes(ev.data), () => scPinBottom($('termBox'), false, scCursorRowY(term)))",
		"scPinBottom($('termBox'), true, scCursorRowY(term));\n  relayout();",
	} {
		if !strings.Contains(live, want) {
			t.Fatalf("live page missing pin-bottom wire %q", want)
		}
	}
	// cast：drain 批尾一次钉（100ms tick 批量写面，勿逐 write 挂回调）
	if !strings.Contains(pages["cast"], "scPinBottom($('termBox'), false, scCursorRowY(term));\n  syncChapter();") {
		t.Fatal("cast page must pin bottom once at the drain batch tail")
	}
	// frozen 软折行不进栅格路径（doFit 不同路径，评审核实）：布局件定义随
	// LayoutJS 注入三页（Contains 会命中函数定义体——定义内部互引 scCursorRowY/
	// scPinBottom），断言面钉「页级调用形态（$('termBox') 首参）零出现」
	if strings.Contains(pages["frozen"], "scFitGrid(term, $('termBox')") || strings.Contains(pages["frozen"], "scPinBottom($('termBox')") {
		t.Fatal("frozen page must stay on the container-fit path (no enlarge/pin call sites)")
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

// 可写视口反喂 resize 接线（P-20261120-8）：驱动只在可写页挂载（SC.writable
// 门控，只读页零驱动零上行——「只读页不新增 resize 上行」红线）；termpage 侧
// 两枚钩子（SSE resize 帧回声对账 wrHostResize + layout 几何 kick wrLayoutHook）
// 全页在场但只读页保持 null 零开销；钳制域与服务端逐字对齐（20..500 / 2..300，
// 两端同域防钳制差振荡）；hello 开通 / teardown 停用 / resize_applied 诚实回执
// （wrResized 双语）/ resize_denied（TmuxExternal 拒绝即停驱动）四面齐
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
		"const VP_MIN_DELTA = 2;",                                            // |目标−现值|≥2 才发（1 格抖动不发）
		"const VP_OWNER_SUPPRESS_MS = 10000;",                                // 主人侧动作抑制窗
		"function vpTarget(){",                                               // 视口目标栅格计算
		"Math.max(20, Math.min(500,",                                         // 钳制域下/上限与服务端同域（cols）
		"Math.max(2, Math.min(300,",                                          // 钳制域下/上限与服务端同域（rows）
		"setHost(tgt.cols, tgt.rows);",                                       // 本地乐观先行（服务端确认帧对账）
		"JSON.stringify({ type: 'resize', cols: tgt.cols, rows: tgt.rows })", // 控制面上行
		"function setTyping(on){",                                            // 键入资格闸（P-20261121-1 双模式：hello 开通/持权/失权同点驱动）
		"vp.on = on;",                                                        // 画布反喂随键入资格开关
		"vp.on = false;",                                                     // teardown/resize_denied 停用
		"showStrip('on', t('wrResized'));",                                   // resize_applied 诚实回执
		"'resize_denied':",                                                   // TmuxExternal 拒绝帧处理在位
		"wrHostResize = function(cols, rows){",                               // 回声门注入（自源回声 vs 主人动作分流）
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("writable live page missing viewport-resize wire %q", want)
		}
	}
	// wrResized 双语同键（循 wrSubLive parity 先例）
	for i, d := range [2]map[string]string{termDictZh, termDictEn} {
		if strings.TrimSpace(d["wrResized"]) == "" {
			t.Fatalf("term dict #%d missing wrResized", i)
		}
	}
	// 只读页零驱动（SC.writable||SC.guestInput 门控早退在挂载之前——
	// writableJS 全页注入、运行态门控是 P-20261106-8 既有形态，P-20261121-1
	// 双模式准入）：门控早退必须在驱动挂载之前，只读页渲染产物里驱动代码
	// 不可达（死代码不执行 = 零上行零驱动）
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
