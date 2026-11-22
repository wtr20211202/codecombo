package share

// 访客页族主题切换注入件回归（P-20261120-1）：六页同源单一事实源（theme.go
// GuestThemeCSS/guestThemeJS）的在场性、四主题块 token 全量覆盖（基础十枚 +
// 扩展 token——缺失会让显式主题下扩展消费面保留 OS 媒体取值）、跨页词典键
// 对账、终端画布恒深端面（P-20261121-4：chrome 换装照旧、xterm 端面不随档）、
// 文件页拼接形态回归（e2e 主题断言兜底 share-reader-layout.spec.ts）。

import (
	"strings"
	"testing"
	"time"
)

// themeBlock 提取单个主题的覆盖块（ GuestThemeCSS 内四块按行界相邻）
func themeBlock(t *testing.T, css, theme string) string {
	t.Helper()
	start := strings.Index(css, `html[data-theme="`+theme+`"]{`)
	if start < 0 {
		t.Fatalf("theme block %q missing from GuestThemeCSS", theme)
	}
	rest := css[start+len(`html[data-theme="`+theme+`"]{`):]
	end := strings.Index(rest, "}\n")
	if end < 0 {
		t.Fatalf("theme block %q not closed", theme)
	}
	return rest[:end]
}

func TestGuestThemeBlocksTokenCoverage(t *testing.T) {
	// 基础十枚（与原文件页主题块同表）+ 扩展 token（评审必改1：终端系/会话/
	// 快投递页消费面——缺失即显式主题下保留 OS 媒体取值的破绽）
	tokens := []string{
		"--bg", "--card", "--text", "--muted", "--border",
		"--accent", "--accent2", "--hover", "--chip", "--shadow",
		"--warn-bg", "--warn-bd", "--warn-tx",
		"--danger-bg", "--danger-bd", "--danger-tx",
		"--think-bg", "--think-bd", "--tool-bg", "--tool-bd", "--fail",
		"--accent-weak", "--ok-bg", "--ok", "--err-bg", "--err",
	}
	// 每主题一枚 accent 锚（调色板对齐主应用 themes/，原 page_css.go 同值）
	accents := map[string]string{
		"light": "--accent:#0969da", "dark": "--accent:#4493f8",
		"one-dark": "--accent:#61afef", "dracula": "--accent:#bd93f9",
	}
	for _, theme := range []string{"light", "dark", "one-dark", "dracula"} {
		block := themeBlock(t, GuestThemeCSS, theme)
		for _, tok := range tokens {
			if !strings.Contains(block, tok+":") {
				t.Fatalf("theme %q block missing token %s", theme, tok)
			}
		}
		if !strings.Contains(block, accents[theme]) {
			t.Fatalf("theme %q block missing accent anchor %s", theme, accents[theme])
		}
	}
	// 控件规则随件（评审必改4：住 theme.go 六页同款，非仅文件页）
	for _, want := range []string{".theme-select{", ".theme-select option{"} {
		if !strings.Contains(GuestThemeCSS, want) {
			t.Fatalf("GuestThemeCSS missing control rule %s", want)
		}
	}
	// auto 档不落覆盖块：data-theme="auto" 无规则（回落各页 :root 双媒体块）
	if strings.Contains(GuestThemeCSS, `html[data-theme="auto"]`) {
		t.Fatal("GuestThemeCSS must not carry an auto override block (auto falls back to OS media queries)")
	}
}

func TestGuestThemeJSSelfContained(t *testing.T) {
	// 注入件不得引用文件页专属的全局名（终端页无 el()/SC；t 仅在函数体内
	// 运行期引用，宿主页均有定义）
	for _, forbidden := range []string{"SC.", "el('", "el(\"", "$app"} {
		if strings.Contains(guestThemeJS, forbidden) {
			t.Fatalf("guestThemeJS must stay self-contained (found %s)", forbidden)
		}
	}
	for _, want := range []string{
		"const THEME_KEY = 'sc.share.theme'",
		"const THEMES = ['auto', 'light', 'dark', 'one-dark', 'dracula']",
		"function applyTheme(", "function initTheme(", "initTheme();",
		"function makeThemeSelect(",
		"sc:themechange", // applyTheme 派发端事件契约（终端页监听端已退役 P-20261121-4）
		"themeSelects",   // 多切换器即时同步登记表（文件页桌面顶栏+「⋯」菜单双份）
	} {
		if !strings.Contains(guestThemeJS, want) {
			t.Fatalf("guestThemeJS missing %q", want)
		}
	}
}

func TestGuestThemeInjectedAllGuestPages(t *testing.T) {
	pages := renderAllTermPages(t, false)
	var session strings.Builder
	if err := renderSessionPage(&session, fixedToken("theme1"), "zh", "sess", ""); err != nil {
		t.Fatalf("render session page: %v", err)
	}
	pages["session"] = session.String()
	var file strings.Builder
	if err := renderSharePage(&file, fixedToken("theme2"), "zh", "", false, time.Time{}, time.Time{}, pageMeta{}, false); err != nil {
		t.Fatalf("render file page: %v", err)
	}
	pages["file"] = file.String()

	// CSS 面：四主题覆盖块 + 控件规则六页全注入（漏接注入点即红）
	for name, page := range pages {
		for _, want := range []string{
			`html[data-theme="light"]`, `html[data-theme="dark"]`,
			`html[data-theme="one-dark"]`, `html[data-theme="dracula"]`,
			".theme-select{", "--warn-bg", // 扩展 token 代表位
		} {
			if !strings.Contains(page, want) {
				t.Fatalf("%s page missing theme asset %q", name, want)
			}
		}
	}
	// JS 面：注入件原语 + head 期 initTheme（防闪白）六页全注入
	for name, page := range pages {
		for _, want := range []string{"const THEME_KEY", "function makeThemeSelect(", "initTheme();"} {
			if !strings.Contains(page, want) {
				t.Fatalf("%s page missing theme JS asset %q", name, want)
			}
		}
		if strings.Count(page, "const THEME_KEY") != 1 {
			t.Fatalf("%s page must declare THEME_KEY exactly once (cut-and-splice shape)", name)
		}
	}
	// 终端系/会话页：头部切换器挂载点（服务端直出 span + 脚本挂切换器）
	for _, name := range []string{"live", "frozen", "cast", "session"} {
		if !strings.Contains(pages[name], `<span id="themeSlot"></span>`) {
			t.Fatalf("%s page missing header theme slot", name)
		}
		if !strings.Contains(pages[name], "$('themeSlot').appendChild(makeThemeSelect())") {
			t.Fatalf("%s page must mount the theme select into the header slot", name)
		}
		// 渲染产物里 {{.ThemeJS}} 已展开——head 注入以「initTheme 先于
		// </head> 执行」为证（防闪白时序：xterm.js 与正文脚本之前）
		if strings.LastIndex(pages[name], "initTheme();") > strings.Index(pages[name], "</head>") {
			t.Fatalf("%s page theme JS must ride the head injection point", name)
		}
	}
	// 文件页：既有双切换器形态与「⋯」菜单全宽修饰不回归（拼接同形回归锚）
	for _, want := range []string{
		"makeThemeSelect('desktop-only')",
		".more-theme .theme-select{flex:1",
	} {
		if !strings.Contains(pages["file"], want) {
			t.Fatalf("file page regression: %q missing", want)
		}
	}
}

// 终端画布恒深端面（P-20261121-4）：三页 xterm 端面收敛常量深色（底色同各页
// OS-dark --bg=#0e1320、前景恒 #e6eaf3、cursor 'transparent' 只隐藏主机光标位）
// ——主人控制台 ANSI 按深色控制台语义发出（PSReadLine 亮黄/红绿输出），浅色
// 主题透明底承接即深色语义落浅底不可辨，故端面不随主题档（P-20261120-1 主题
// 随档接线退役）；页面 chrome 换装面（GuestThemeCSS/guestThemeJS）不受影响。
// 旧接线三面归零由负断言钉住：TERM_FG 前景映射 / matchMedia OS 门禁 /
// sc:themechange 换装监听（addEventListener 形态；dispatchEvent 派发端随
// ThemeJS 注入属既有契约不在此列）/ 透明底 rgba(0,0,0,0) 任一回流即红
func TestTermPagesXtermCanvasConstantDark(t *testing.T) {
	pages := renderAllTermPages(t, false)
	for _, name := range []string{"live", "frozen", "cast"} {
		page := pages[name]
		for _, want := range []string{
			"function termTheme(){",
			"background: '#0e1320', foreground: '#e6eaf3', cursor: 'transparent'",
		} {
			if !strings.Contains(page, want) {
				t.Fatalf("%s page missing constant dark canvas %q", name, want)
			}
		}
		for _, banned := range []string{"TERM_FG", "matchMedia(", "addEventListener('sc:themechange'", "rgba(0,0,0,0)"} {
			if strings.Contains(page, banned) {
				t.Fatalf("%s page must not carry retired terminal re-theming %q", name, banned)
			}
		}
	}
	// 会话回放页无 xterm：不挂终端端面（结构化时间线页，纯 DOM）
	if strings.Contains(pages["session"], "termTheme") {
		t.Fatal("session page must not carry xterm canvas wiring (no terminal instance)")
	}
	// 派发端保留（TestGuestThemeJSSelfContained 同款断言面）：applyTheme 仍派发
	// sc:themechange——退役的是终端页监听端，事件本身是主题注入件的既有契约
	if !strings.Contains(guestThemeJS, "sc:themechange") {
		t.Fatal("guestThemeJS must keep dispatching sc:themechange (applyTheme contract)")
	}
}

// 主题词条键对账：四套访客词典 × 双语各持六键（键名与文件页 page_i18n.go
// 主题段同表——makeThemeSelect 的 t() 消费契约）
func TestGuestThemeDictKeysParity(t *testing.T) {
	keys := []string{"theme", "themeAuto", "themeLight", "themeDark", "themeOneDark", "themeDracula"}
	dicts := map[string]map[string]string{
		"termZh": termDictZh, "termEn": termDictEn,
		"castZh": castDictZh, "castEn": castDictEn,
		"frozenZh": termFrozenDictZh, "frozenEn": termFrozenDictEn,
		"sessionZh": sessionDictZh, "sessionEn": sessionDictEn,
	}
	for name, d := range dicts {
		for _, k := range keys {
			if d[k] == "" {
				t.Fatalf("%s dict missing theme key %q", name, k)
			}
		}
	}
	// 文件页既有键不动（回归锚：同键同文案源）
	if dictZh["theme"] != "主题" || dictEn["theme"] != "Theme" {
		t.Fatal("file page dict theme keys must stay intact")
	}
}
