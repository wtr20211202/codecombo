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
			".wrap>.gb-root .gb-body{position:absolute", // 页底留言浮层（不挤压终端区）
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

func TestTermPagesWireContentAdaptiveWidth(t *testing.T) {
	pages := renderAllTermPages(t, false)
	// 直播：hello/resize 帧主机列数（setHost → scTermNeed）；定格：快照行宽；
	// 回放：cast header 宽度
	if !strings.Contains(pages["live"], "setHost(m.cols, m.rows)") {
		t.Fatal("live page must size the column from hello cols")
	}
	if !strings.Contains(pages["frozen"], "scTermNeed(scTextCols(text))") {
		t.Fatal("frozen page must size the column from snapshot line widths")
	}
	if !strings.Contains(pages["cast"], "scTermNeed(cols)") {
		t.Fatal("cast page must size the column from the cast header width")
	}
}

// 渲染参数跨栈对账（P-20261107-4 渲染保真）：三页统一经 scTermOptions 构造、
// 挂 Unicode 11 宽度表、加载 vendored addon；常量与产品内终端缺省值对齐——
// 产品侧定义源：字体栈 web/src/terminal-themes/index.ts XTERM_FONT_STACKS.jetbrains、
// 字号 web/src/stores/font.ts FONT_DEFAULTS.terminal = 14、scrollback
// server/terminal/scrollback.go DefaultScrollbackLines = 20000。访客页零依赖不读
// settings，此处钉死的是「对齐时点的产品缺省值」——产品侧改缺省时本测试红即
// 提示同步审视访客侧常量（总纲：参数对齐，不承诺同一配置源）
func TestTermPagesRenderParamsAligned(t *testing.T) {
	pages := renderAllTermPages(t, false)
	js := termLayoutJS
	for _, want := range []string{
		`const SC_TERM_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace";`,
		"const SC_TERM_FONT_SIZE = 14;",
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
