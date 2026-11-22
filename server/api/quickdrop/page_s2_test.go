package quickdrop

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 访客页 S2 产品化面（P-20261117-2-S2）：外链自持脚本路由 / enforcing CSP /
// 暂存式交互的页面骨架。暂存/进度/记录的浏览器侧行为归 e2e（quickdrop.spec.ts
// S2 用例），此处钉服务端契约面。

// newDropS2Router 测试路由：访客页 + 自持资产精确名挂载（router.go 同款循环）
func newDropS2Router(t *testing.T) *gin.Engine {
	r := newQuickdropRouter(t) // store 装配复用
	for _, name := range AssetNames() {
		r.GET("/drop/assets/"+name, GetDropAsset)
	}
	return r
}

func TestDropPageS2Skeleton(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/"+token, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("page status = %d, want 200", w.Code)
	}
	body := w.Body.String()

	// 外链自持脚本（enforcing CSP 下内联脚本不可用——script-src 'self' 唯一面）
	if !strings.Contains(body, `<script src="/drop/assets/app.js" defer></script>`) {
		t.Fatal("page must reference external app.js (no inline script under enforcing CSP)")
	}
	if strings.Contains(body, "<script>") {
		t.Fatal("page must not carry inline scripts")
	}
	// 暂存式交互骨架锚点（e2e data-testid 依赖）
	for _, anchor := range []string{
		`data-testid="qd-dropzone"`, `id="qd-file-input" type="file" multiple`,
		`data-testid="qd-staged-list"`, `data-testid="qd-send"`,
		`data-testid="qd-progress"`, `data-testid="qd-history-badge"`,
		`data-testid="qd-history-panel"`, `Codecombo`,
	} {
		if !strings.Contains(body, anchor) {
			t.Fatalf("page skeleton anchor missing: %s", anchor)
		}
	}
	// 校验传达（P-20261118-8）：标签说清「有文件才可留空」条件；旧误导文案
	// 「（可留空 / optional）」整串不再裸出现（语义本就正确——内容与文件至
	// 少一项，缺陷纯在传达层）
	if !strings.Contains(body, "有文件时可留空 / optional if files attached") {
		t.Fatal("content label must state the condition (optional only if files attached)")
	}
	if strings.Contains(body, "（可留空 / optional）") {
		t.Fatal("misleading bare 'optional' label must be gone")
	}
	// enforcing CSP：三指令齐备（script 同源/XHR 同源/PRG 自提交同源）
	csp := w.Header().Get("Content-Security-Policy")
	for _, d := range []string{"script-src 'self'", "connect-src 'self'", "form-action 'self'"} {
		if !strings.Contains(csp, d) {
			t.Fatalf("enforcing CSP missing %q: %q", d, csp)
		}
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("drop page must stay no-store (token in URL)")
	}

	// 主题面（P-20261120-1）：data-theme 覆盖块随 share.GuestThemeCSS 注入
	// + 头部切换器挂载点（app.js 建切换器——零内联纪律不变）
	for _, want := range []string{`html[data-theme="dark"]`, ".theme-select{", `id="qd-theme-slot"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("drop page missing theme asset %q", want)
		}
	}

	// 404 品牌页同口径带 enforcing CSP（防御性一致）+ 主题 CSS 注入 + 引用
	// 同源自持脚本（评审必改2 裁定 (ii)：零 JS 则 data-theme 永不设置，
	// 主题块死代码——app.js initTheme 只读偏好，无切换器）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/scd_invalid", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("invalid token status = %d, want 404", w.Code)
	}
	if csp = w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") {
		t.Fatalf("404 page missing enforcing CSP: %q", csp)
	}
	nf := w.Body.String()
	if !strings.Contains(nf, `<script src="/drop/assets/app.js" defer></script>`) {
		t.Fatal("404 page must reference app.js (initTheme reads the shared preference)")
	}
	for _, want := range []string{`html[data-theme="dark"]`, ".theme-select{"} {
		if !strings.Contains(nf, want) {
			t.Fatalf("404 page missing theme asset %q", want)
		}
	}
	if strings.Contains(nf, `id="qd-theme-slot"`) {
		t.Fatal("404 page must not carry a theme switcher (read-only preference)")
	}
}

// assertBrandMark 断言品牌动态 mark 的静态指纹（投递页/404 页同套组件）：
// 48 viewBox 啮合弧（favicon.svg P-20261101-1 精修版真圆弧）+ AppLogo 动态
// 形态的双轨道圈/节点/毂点 class + 四条动画 keyframes + reduced-motion 降级 +
// data-uri favicon；旧临时 logo（圆角块 + 白色播放三角）不得残留
func assertBrandMark(t *testing.T, page, where string) {
	t.Helper()
	for _, want := range []string{
		`class="logo logo-animated" viewBox="0 0 48 48"`,
		`M24 8A16 16 0 0 0 8 24`, // 品牌精修版真圆弧特征串（favicon.svg 同源）
		`logo-orbit-outer`, `logo-orbit-inner`,
		`logo-node-a`, `logo-node-b`, `logo-core`,
		`@keyframes logo-orbit-cw`, `@keyframes logo-orbit-ccw`,
		`@keyframes logo-pulse`, `@keyframes logo-core-glow`,
		`@media (prefers-reduced-motion: reduce)`,
		`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,`,
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("%s: brand mark feature missing: %s", where, want)
		}
	}
	for _, gone := range []string{`rx="6" fill="#6a5cff"`, `M8 5.5v13l11-6.5z`} {
		if strings.Contains(page, gone) {
			t.Fatalf("%s: temp logo residue: %s", where, gone)
		}
	}
}

// 品牌 mark 换装 + favicon 补齐 + 投递页视口垂直居中（P-20261119-6）：
// 此前两处是临时手绘 SVG（圆角块+播放三角，非产品资产）、head 零 icon link、
// body 顶对齐（大屏下半全空）。页面渲染契约面在此钉死，动画实际运动归浏览器
// 行为不作断言（CSS 规则在场即可）。
func TestDropPageBrandMark(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/"+token, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("page status = %d, want 200", w.Code)
	}
	body := w.Body.String()
	assertBrandMark(t, body, "drop page")
	if !strings.Contains(body, "animation: none;") {
		t.Fatal("drop page: reduced-motion rule must disable logo animations")
	}
	// 视口垂直居中：flex 列 + auto 边距策略 + dvh/vh 双行回落（大屏「下半全空」
	// 回归锚点）；auto 边距而非 justify-content:center——溢出时可完整滚动
	for _, want := range []string{
		`min-height: 100vh; min-height: 100dvh`,
		`display: flex; flex-direction: column`,
		`margin: auto auto 16px`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("drop page viewport centering missing: %q", want)
		}
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/scd_invalid", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("invalid token status = %d, want 404", w.Code)
	}
	nf := w.Body.String()
	assertBrandMark(t, nf, "404 page")
	if !strings.Contains(nf, "min-height:100vh; min-height:100dvh") {
		t.Fatal("404 page must keep viewport dvh fallback (mobile URL bar)")
	}
	// 404 文案不动：files_test 门禁前置用例按「链接无效」判品牌页
	if !strings.Contains(nf, "链接无效") {
		t.Fatal("404 brand page copy must stay (files_test gate-first assertion)")
	}
}

// 内容整体放大 + 背景氛围对齐访客页族（P-20261120-6）：此前 860px 阅读列在
// 宽屏四周大留白、且访客页族「两有一无」（文件/终端分享页有双 blob 模糊光斑，
// 快投递缺层——#f4f6fb 底+纯白卡整页读作纯白）。此处钉服务端渲染契约：
// 列宽一档（.top/.card 双锚 min(92vw,1120px)）+ hist-panel 贴卡公式随新列宽
// 同步 + 字号/内衬/最小高度锚点 + 触达红线（qd-send 44px）不回归 + blob
// CSS/挂载逐字同源（page_css.go:25-27/termpage.go:272-274 取值）+ 内容列
// z-index:1 压 blob 之上；404 品牌页同源挂载（share 404 页 blob 先例），
// 卡片宽度本身不放大。浏览器侧渲染归 e2e 宽屏冒烟（quickdrop.spec.ts）。
func TestDropPageCanvasScaleAndBlobBackdrop(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/"+token, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("page status = %d, want 200", w.Code)
	}
	body := w.Body.String()

	// 列宽一档：.top 与 .card 同列宽（双锚各一处）；hist-panel 贴卡公式随
	// 新列宽同步（否则宽屏弹卡不贴卡右缘）
	if got := strings.Count(body, "max-width: min(92vw, 1120px)"); got != 2 {
		t.Fatalf("column width anchor count = %d, want 2 (.top + .card)", got)
	}
	for _, want := range []string{
		`right: max(14px, calc((100vw - min(92vw, 1120px)) / 2))`,
		// 字号/内衬/最小高度上一档（h1 22px / 卡内衬 28px / dropzone 与
		// textarea 最小高度随宽一档后于 P-20261120-7 归一 200px——等高锚
		// 细断言归 TestDropPageColumnsEqualHeight）
		`h1 { font-size: 22px;`,
		`padding: 28px;`,
		`min-height: 200px;`,
		// 触达红线零回归：提交钮 44px 热区不缩
		`min-height: 44px`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("drop page canvas-scale anchor missing: %q", want)
		}
	}

	// blob 氛围层：CSS 取值逐字同 share 访客页族 + body 开篇挂载 + 内容列
	// （.top/main）显式 z-index:1 压 blob 之上（termpage .wrap 同构）
	for _, want := range []string{
		`.blob { position: fixed; border-radius: 50%; filter: blur(90px); z-index: 0; pointer-events: none; }`,
		`.b1 { width: 380px; height: 380px; background: rgba(106,92,255,.30); top: -90px; right: -70px; }`,
		`.b2 { width: 320px; height: 320px; background: rgba(61,123,253,.26); bottom: -90px; left: -60px; }`,
		`<div class="blob b1"></div><div class="blob b2"></div>`,
		`position: relative; z-index: 1;`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("drop page blob backdrop anchor missing: %q", want)
		}
	}

	// 404 品牌页同源氛围（share 404/口令页 blob 先例）：同一常量注入 + 挂载 +
	// 卡片压层；卡片 420px 口径不放大
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/scd_invalid", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("invalid token status = %d, want 404", w.Code)
	}
	nf := w.Body.String()
	for _, want := range []string{
		`.blob { position: fixed; border-radius: 50%; filter: blur(90px); z-index: 0; pointer-events: none; }`,
		`<div class="blob b1"></div><div class="blob b2"></div>`,
		`.nf-card { max-width:420px;`,
		`position:relative; z-index:1;`,
	} {
		if !strings.Contains(nf, want) {
			t.Fatalf("404 page blob backdrop anchor missing: %q", want)
		}
	}
}

// 双栏两输入框等高对齐（P-20261120-7）：此前 .cols align-items:start 两列各
// 按内容收缩 + dropzone 140px/textarea 180px 两值不一 + hint/提交行只在右列
// ——两框顶底均不齐（用户截图双箭头实锚，业界分栏表单通例=两框等高、顶底
// 对齐、动作行脱离单列全宽）。修复=三行等高网格：行1 双 label 对齐行、行2
// 两框同轨（缺省 stretch 同高）、行3 尾行同轨底齐；min-height 归一 200px；
// form 外扩包裹 .cols+动作行（提交锚零位移——urlencoded 303 人面与 XHR 双路
// 都锚 qd-form/qd-send/content/qd-msg）。真实渲染几何归 e2e 宽屏用例
// （quickdrop.spec.ts 两框 boundingBox 等高 ≤2px + 顶缘相等）。
func TestDropPageColumnsEqualHeight(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/"+token, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("page status = %d, want 200", w.Code)
	}
	body := w.Body.String()

	// 等高失效根因清除：显式 align-items:start 不得残留（grid 缺省 stretch
	// 即同轨等高语义——两框同处行 2 轨道，高度恒等）
	if strings.Contains(body, "align-items: start") {
		t.Fatal(".cols must not pin align-items:start (equal-height root cause)")
	}
	// 三行网格与显式摆位：<760px 单栏回落为块流基础规则 + ≥760px 媒体查询
	// 摆位（display:contents 退化 .col 为逻辑分组，DOM 序=单栏视序）
	for _, want := range []string{
		`.cols { display: block; }`,
		`.col + .col { margin-top: 16px; }`,
		`@media (min-width: 760px) {`,
		`.cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: 24px; }`,
		`.col { display: contents; }`,
		`.lb-files { grid-column: 1; grid-row: 1; }`,
		`.lb-content { grid-column: 2; grid-row: 1; }`,
		`.dz { grid-column: 1; grid-row: 2; margin-bottom: 0; }`,
		`textarea { grid-column: 2; grid-row: 2; }`,
		`.ftail { grid-column: 1; grid-row: 3; margin-top: 14px; }`,
		`#qd-progress { grid-column: 2; grid-row: 3; }`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("drop page equal-height grid anchor missing: %q", want)
		}
	}
	// 两框同轨等高的最小高度前提：归一 200px 恰两处（dropzone + textarea）
	// ——grid 项 margin 参与轨道尺寸，dz 网格内下边距必须归零（14px 残留会
	// 让左框矮一档破坏 stretch 等高）
	if got := strings.Count(body, "min-height: 200px;"); got != 2 {
		t.Fatalf("unified min-height:200px count = %d, want 2 (dropzone + textarea)", got)
	}
	// 左列对称 label（「文件 / Files」）呼应右列「内容 / Content」，关联隐藏
	// 文件 input——点击 label 即原生打开选择器（可达性：input 获得可访问名）
	if !strings.Contains(body, `<label class="lb-files" for="qd-file-input">文件 / Files</label>`) {
		t.Fatal("left column must carry symmetric files label bound to the hidden file input")
	}
	// 暂存清单/汇总收进左列尾格（清单在 dropzone 之下语义保持；右列尾格=
	// 进度条——尾行同轨故清单增长两框仍等高）
	if !strings.Contains(body, `<div class="ftail">`) ||
		!strings.Contains(body, `data-testid="qd-staged-summary"`) {
		t.Fatal("staged list/summary must stay in the left column tail cell")
	}
	// 动作行脱离单列：form 外扩包裹 .cols，hint-line 与提交行位于 .cols 之后
	// 全宽（提交钮右对齐 margin-left:auto 既有规则）——提交锚 id 零位移
	formIdx := strings.Index(body, `<form id="qd-form"`)
	colsIdx := strings.Index(body, `<div class="cols">`)
	summaryIdx := strings.Index(body, `data-testid="qd-staged-summary"`)
	hintIdx := strings.Index(body, `class="hint-line"`)
	sendIdx := strings.Index(body, `data-testid="qd-send"`)
	if formIdx < 0 || colsIdx < 0 || formIdx > colsIdx {
		t.Fatal("form#qd-form must wrap .cols (action row outside the split)")
	}
	if summaryIdx < 0 || hintIdx < summaryIdx || sendIdx < hintIdx {
		t.Fatal("hint line + submit row must follow the .cols split (full-width action row)")
	}
	// 校验传达文案（P-20261118-8 门禁）随结构迁移零缺失：内容 label 条件句
	// 与「只投文字也可以」告知行原样保留
	if !strings.Contains(body, "有文件时可留空 / optional if files attached") ||
		!strings.Contains(body, "只投文字也可以，无文件直接投 / Text-only drops are fine") {
		t.Fatal("P-20261118-8 copy must survive the action-row relocation")
	}
}

func TestDropAssetRoute(t *testing.T) {
	r := newDropS2Router(t)

	// 白名单精确名：200 + application/javascript + no-cache（升级即时可见）
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/assets/app.js", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("asset status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/javascript") {
		t.Fatalf("asset content-type = %q, want application/javascript", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("asset cache-control = %q, want no-cache", cc)
	}
	js := w.Body.String()
	if len(js) < 500 || !strings.Contains(js, "sc.drop.history") {
		t.Fatal("asset body looks truncated (history key marker missing)")
	}
	if strings.Contains(js, "</script>") {
		t.Fatal("asset must not contain script-closing literal (embed safety)")
	}
	// 空表单拦截文案与页面标签同口径「至少一项」（P-20261118-8）；旧误导
	// 文案不得残留在资产中
	if !strings.Contains(js, "内容与文件至少填写一项即可投递") {
		t.Fatal("app.js empty-form error must state 'at least one required'")
	}
	if strings.Contains(js, "Add text or files first") {
		t.Fatal("old misleading empty-form copy must be gone from app.js")
	}

	// 主题段（P-20261120-1）：与 share 访客页族同键共享偏好（uiStateLanes
	// ls.share.theme externalKey 登记），挂载点 null-guard（404 页复用本文件）
	for _, want := range []string{"sc.share.theme", "qd-theme-slot", "dataset.theme", "sc:themechange"} {
		if !strings.Contains(js, want) {
			t.Fatalf("app.js theme section missing %q", want)
		}
	}

	// 未知名：白名单外 → 404 品牌页口径（不暴露文件树存在性）
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/assets/secret.js", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown asset status = %d, want 404", w.Code)
	}

	// 穿越形态：不伺服任意包内文件
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/assets/..%2Fpage.go", nil))
	if w.Code == http.StatusOK || strings.Contains(w.Body.String(), "package quickdrop") {
		t.Fatalf("traversal must not serve source: %d", w.Code)
	}

	// 与 /drop/:token 同树共存：页面路由不受资产段影响
	token := genToken(t, r)
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/"+token, nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<textarea") {
		t.Fatalf("page route broken by asset mount: %d", w.Code)
	}
}
