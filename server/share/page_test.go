package share

import (
	"strings"
	"testing"
	"time"
)

// 分享访客页打印样式回归：page-css 必须携带 @media print 块——隐藏
// 导航/装饰（滚动指示条/背景 blob/加载 spin/页头操作按钮），暗色主题
// token 翻转为黑字白底（浏览器打印默认去背景，缺翻转则暗色下白纸
// 不可读），代码块/表格防跨页截断、pre 换行防溢出页宽
func TestSharePagePrintCSS(t *testing.T) {
	var b strings.Builder
	if err := renderSharePage(&b, "tok", "zh", "", false, time.Time{}, time.Time{}, pageMeta{}, false); err != nil {
		t.Fatalf("render share page: %v", err)
	}
	out := b.String()
	start := strings.Index(out, `<style id="page-css">`)
	if start < 0 {
		t.Fatalf("page-css style block not found")
	}
	end := strings.Index(out[start:], "</style>")
	if end < 0 {
		t.Fatalf("page-css style block not closed")
	}
	css := out[start : start+end]

	pi := strings.Index(css, "@media print")
	if pi < 0 {
		t.Fatalf("page-css missing @media print block")
	}
	printCSS := css[pi:]

	// 打印时必须隐藏的导航与装饰元素（持久化 PDF 里不应出现）
	for _, sel := range []string{".topbar", ".blob", ".spin", ".header .actions"} {
		if !strings.Contains(printCSS, sel) {
			t.Fatalf("print css must hide %s\nprint block: %s", sel, printCSS)
		}
	}
	// 溯源水印（P-20261005-193）不进打印隐藏清单：纸面外传同属归因范围，
	// 打印/PDF 必须保留水印层
	if strings.Contains(printCSS, "sc-wm") {
		t.Fatalf("print css must NOT hide the watermark layer (attribution scope)\nprint block: %s", printCSS)
	}
	// 暗色 token 翻转：print 块内必须显式落黑字白底
	if !strings.Contains(printCSS, "#000") || !strings.Contains(printCSS, "#fff") {
		t.Fatalf("print css must flip colors to black on white\nprint block: %s", printCSS)
	}
	// 代码块/表格防跨页截断
	if !strings.Contains(printCSS, "break-inside:avoid") {
		t.Fatalf("print css must keep code/table blocks intact across pages\nprint block: %s", printCSS)
	}
	// pre 放开换行，长行不得横向溢出页宽
	if !strings.Contains(printCSS, "pre-wrap") {
		t.Fatalf("print css must wrap long lines in pre\nprint block: %s", printCSS)
	}
}

// 访客页 reader 形态回归（P-20261020-7）：去卡片全幅内容 + 细顶栏 +
// 窄屏动作菜单 + 阅读列全宽切换。锚点是选择器/函数名级别，防止后续改版
// 把「无卡片/单滚动/边到边 iframe/导出克隆源」等硬约束静默丢回旧形态。
// 同时守住既有能力：enhanceArticle 管线（复制/表格拖拽/锚点）、打印隐藏
// 动作按钮不得因布局改造缺席。
func TestSharePageReaderLayout(t *testing.T) {
	var b strings.Builder
	if err := renderSharePage(&b, "tok", "zh", "", false, time.Time{}, time.Time{}, pageMeta{}, false); err != nil {
		t.Fatalf("render share page: %v", err)
	}
	out := b.String()
	start := strings.Index(out, `<style id="page-css">`)
	if start < 0 {
		t.Fatalf("page-css style block not found")
	}
	end := strings.Index(out[start:], "</style>")
	if end < 0 {
		t.Fatalf("page-css style block not closed")
	}
	css := out[start : start+end]

	// 去卡片：旧的四层套框（.card/.footer/渐变 hero）不再是页面骨架
	for _, banned := range []string{".card{", ".footer{"} {
		if strings.Contains(css, banned) {
			t.Fatalf("page css must not keep the old card/footer rule %q\ncss: %s", banned, css)
		}
	}
	if hi := strings.Index(css, ".header{"); hi >= 0 {
		if seg := css[hi:]; strings.Contains(seg[:strings.Index(seg, "}")], "linear-gradient") {
			t.Fatalf("header must drop the gradient hero (P-20261020-7)\nheader rule: %s", seg[:strings.Index(seg, "}")])
		}
	}

	// 全幅 reader + 移动端 100dvh / safe-area / 动作菜单 / 阅读列全宽
	for _, want := range []string{
		".wrap{position:relative;z-index:1;height:100vh;height:100dvh",
		"env(safe-area-inset-bottom)",
		".reader{flex:1;min-height:0;display:flex;flex-direction:column",
		".more-btn",
		".more-menu",
		".more.open .more-menu{display:flex}",
		"@media (max-width:700px)",
		".list .col-modified{display:none}",
		".mtime-m{display:block",
		".info .kv{display:flex;flex-wrap:wrap",
		// 目录表固定列宽：长文件名不把行内操作列撑出容器（窄屏按钮可达）
		"table.list{width:100%;border-collapse:collapse;table-layout:fixed}",
		".list .acts-col{width:calc(104px + env(safe-area-inset-right))}",
		// iframe 贴边：无内衬/圆角（HTML/PDF 边到边）
		".preview iframe{flex:1;min-height:0;width:100%;border:none;border-radius:0",
		// 文本单滚动：pre 自身不滚、页面底色
		"background:transparent;overflow:visible;min-height:100%",
		// md/docx 阅读列 + 全宽切换；CSV 全宽
		".md-article{max-width:860px",
		".md-article.wide{max-width:none}",
		".md-article.csv{max-width:none",
	} {
		if !strings.Contains(css, want) {
			t.Fatalf("page css must contain %q (reader layout P-20261020-7)\ncss: %s", want, css)
		}
	}

	// 100dvh + env(safe-area-*) 要生效，viewport 必须声明 viewport-fit=cover
	// （否则 iOS 上 safe-area 恒为 0，刘海/圆角区域只会被浏览器整体缩进）
	if !strings.Contains(out, "viewport-fit=cover") {
		t.Fatalf("share page viewport must opt into viewport-fit=cover for safe-area insets")
	}

	// 打印样式同步：顶栏动作仍隐藏（既有 share-print 断言同源）
	pi := strings.Index(css, "@media print")
	if pi < 0 {
		t.Fatalf("page css missing @media print block")
	}
	if !strings.Contains(css[pi:], ".header .actions") {
		t.Fatalf("print css must keep hiding header actions\nprint block: %s", css[pi:])
	}

	// 脚本侧：reader 骨架/动作菜单/全宽切换/导出克隆源；既有增强管线保留
	for _, want := range []string{
		"function setMoreOpen",
		"function closeMore",
		"function toggleFullscreen",
		"function syncFullscreen",
		"function updateWideBtn",
		"function toggleWide",
		"function copyShareLink",
		"function newTabUrl",
		"more-menu",
		"readerEl",
		"const readerClone = readerEl.cloneNode(true)",
		"function enhanceArticle",
		"enableTableColResize(tb)",
		"pre-copy",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("page script must contain %q (reader layout P-20261020-7)", want)
		}
	}
	// 导出克隆源不得退回旧卡片变量
	if strings.Contains(out, "cardEl") {
		t.Fatalf("page script must not reference the removed .card container (cardEl)")
	}
}

// md 表格列宽失衡修正回归（P-20261010-1）：短列下限保护（min-width + anywhere
// 兜底）、拖拽手柄样式与窄屏回落必须落在 page-css；拖拽交互 JS（fixed 切换/
// 双击恢复/matchMedia 窄屏守卫）必须落在页面脚本。锚点是选择器/函数名级别
// （宽容空白差异），防止渲染管线改动时静默丢保护
func TestSharePageTableColResize(t *testing.T) {
	var b strings.Builder
	if err := renderSharePage(&b, "tok", "zh", "", false, time.Time{}, time.Time{}, pageMeta{}, false); err != nil {
		t.Fatalf("render share page: %v", err)
	}
	out := b.String()
	start := strings.Index(out, `<style id="page-css">`)
	if start < 0 {
		t.Fatalf("page-css style block not found")
	}
	end := strings.Index(out[start:], "</style>")
	if end < 0 {
		t.Fatalf("page-css style block not closed")
	}
	css := out[start : start+end]

	// 短列下限保护 + 长列 anywhere 兜底（calc 补回 border-box 的 padding/边框壳）
	for _, want := range []string{"min-width:calc(4em + 26px)", "overflow-wrap:anywhere"} {
		if !strings.Contains(css, want) {
			t.Fatalf("page css must contain %q (md table column protection)\ncss: %s", want, css)
		}
	}
	// 拖拽手柄与窄屏回落（<700px 隐藏手柄）
	for _, want := range []string{".col-handle", "col-resize", "@media (max-width:699px)"} {
		if !strings.Contains(css, want) {
			t.Fatalf("page css must contain %q (column drag handle)\ncss: %s", want, css)
		}
	}
	// fixed 后超长内容 ellipsis 收敛 + 打印不截断
	if !strings.Contains(css, ".sc-cols-fixed") {
		t.Fatalf("page css must contain .sc-cols-fixed rules\ncss: %s", css)
	}
	pi := strings.Index(css, "@media print")
	if pi < 0 {
		t.Fatalf("page css missing @media print block")
	}
	if !strings.Contains(css[pi:], "sc-cols-fixed") {
		t.Fatalf("print css must relax fixed-table ellipsis (paper cannot hover title)\nprint block: %s", css[pi:])
	}

	// 拖拽交互 JS：手柄挂载入口 + 窄屏守卫 + 双击恢复
	for _, want := range []string{
		"function enableTableColResize",
		"matchMedia('(min-width: 700px)')",
		"dblclick",
		"sc-cols-fixed",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("page script must contain %q (column drag logic)", want)
		}
	}
}
