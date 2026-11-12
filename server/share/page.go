package share

import (
	"encoding/json"
	"html/template"
	"io"
	"strings"
	"time"
)

// 页面为内嵌单文件 HTML：零外部依赖（无 CDN/字体请求），双语字典由服务端
// 按 Accept-Language 注入，深浅色跟随系统。页面 JS 只做取数与渲染，
// 所有用户字符串经 textContent 写入（不拼 HTML）；markdown/Word 文档
// 由服务端渲染为净化片段后页内注入（单滚动区，无 iframe 双滚动），
// pdf/html 类以 sandbox iframe 呈现 raw（html 脚本默认被双层拦死，访客按
// 文件显式 opt-in「运行脚本（隔离）」时才放开 allow-scripts，绝不放开
// allow-same-origin——P-20261020-4）。

// pageMeta 分享页服务端直出的链接元信息（P-20261020-11）。页面 JS 就位前
// 聊天工具/邮件网关只读首屏 HTML——title/description/OG 必须在此直出。
// Sensitive（口令/一次性分享）时标题与描述整体泛化，记录字段零进入。
type pageMeta struct {
	Name        string
	ProjectName string
	IsDir       bool
	Snippet     bool
	// Sensitive 口令/一次性分享：OG 与 title 泛化（未解锁抓取不得见文件名/
	// 项目名）。内容页只在解锁/确认后渲染，泛化是纵深防御的第二层
	Sensitive bool
	// URL 当前分享页绝对地址（og:url；空串 = 不出该标签，如 Host 缺失）
	URL string
}

type pageData struct {
	Lang        string
	Title       string
	Description string
	PageURL     string
	Boot        template.JS
	// StatusBanner 快照/过期合并的单行紧凑状态条文案（P-20261111-5，服务端
	// 双语拼装——条随 HTML 直出，不依赖页面 JS 就位；空串 = live 永久记录
	// 两段皆无 → 零渲染，访客面零变化）
	StatusBanner string
	// StatusTitle 状态条的悬停 title（P-20261111-5：紧凑条只留时点短文案，
	// 完整长句降为悬停说明层——信息不丢；与 StatusBanner 同条件渲染）
	StatusTitle string
	// BoardCSS/BoardJS 访客留言区共享资产（P-20261006-13，guestboard.go
	// 单一事实源——三形态访客页同一段脚本挂载，样式/文案键三页同表）
	BoardCSS template.CSS
	BoardJS  template.JS
}

// pageTmplSrc 模板按段拆分（P-20261007-22 纯搬运重组，零逻辑改动）：页头段
// 留本文件，CSS 段在 page_css.go、JS 三段在 page_js_core/shell/nav.go；
// 段间以常量拼接装配，拼接结果与拆分前的单常量逐字节一致（模板解析与
// 渲染产物零变化）
const pageTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M12 15l-3-3c.5-1.3 1.2-2.6 2-4 3.4-5.9 8.5-8 11-7 .9 2.5-1 7.5-7 11-.9.5-2 1.2-3 2z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M9 12H4s.5-3.4 2-4.5c1.7-1.2 5 0 5 0' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E">
<title>{{.Title}}</title>
<meta name="description" content="{{.Description}}">
<meta property="og:title" content="{{.Title}}">
<meta property="og:description" content="{{.Description}}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Codecombo">
{{if .PageURL}}<meta property="og:url" content="{{.PageURL}}">{{end}}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{{.Title}}">
<meta name="twitter:description" content="{{.Description}}">
` + pageTmplCssSrc + `</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div id="app" class="wrap">
{{if .StatusBanner}}<div class="status-banner" id="status-banner" title="{{.StatusTitle}}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>{{.StatusBanner}}</span></div>{{end}}
<div class="spin"></div></div>
<script>
` + pageTmplJsCoreSrc + pageTmplJsShellSrc + pageTmplJsNavSrc + `</body>
</html>`

var pageTmpl = template.Must(template.New("share").Parse(pageTmplSrc))

// renderSharePage 输出分享页（已知 token）。wm 为溯源水印文本（P-20261005-193，
// 空串 = 记录未开水印，boot 不携带、页面不出水印层）。frozen + snapshotAt 为
// 冻结快照分享的时点声明（P-20261005-168；P-20261111-5 起与有效期声明合并为
// 单行紧凑状态条，完整长句降为悬停 title）：观看者有权知道看到的是创建时刻
// 的定格副本——文案走 lang 双语字典服务端拼装（{time} 占位替换，
// csvTruncated/snippetExpiresAt 同款占位约定），时刻取记录 CreatedAt（幂等
// 重建不刷新，正是「首次定格」语义）；snapshotAt 零值（live 记录/防御分支）
// 无该段，live 永久记录两段皆空 → 整条零渲染。
// meta 为链接元信息（P-20261020-11）；expiresAt 非零时状态条追加过期段
// （P-20261020-5；snippet 由内容区既有提示承接，调用方传零值避免重复声明）
func renderSharePage(w io.Writer, token, lang, wm string, frozen bool, snapshotAt, expiresAt time.Time, meta pageMeta, collab bool) error {
	d := dictFor(lang)
	title, desc := pageLinkMeta(d, meta)
	// 快照/过期合并单行紧凑状态条（P-20261111-5）：此前快照横幅（P-20261005-168）
	// 与有效期横幅（P-20261020-5）各占一行完整长句、挤占首屏视觉权重，收成
	// 「快照 {t} · {t} 过期」单行弱化条，完整长句降为悬停 title——信息不丢。
	// 永久分享（无过期）只显快照段；两段皆空整条不出
	snapAt, expAt := "", ""
	if frozen && !snapshotAt.IsZero() {
		snapAt = snapshotAt.Format("2006-01-02 15:04")
	}
	if !expiresAt.IsZero() {
		// Local()：显式时点可能以 UTC/带偏移的 RFC3339 落库，访客看到的是
		// 服务端部署时区的本地时间（与快照横幅同一呈现口径）
		expAt = expiresAt.Local().Format("2006-01-02 15:04")
	}
	statusLine, statusTitle := compactStatusLine(d, lang, snapAt, expAt)
	boot, err := json.Marshal(bootState{Token: token, Lang: lang, Dict: d, Wm: wm, MsgMax: boardMsgMax(collab)})
	if err != nil {
		return err
	}
	return pageTmpl.Execute(w, pageData{
		Lang:         lang,
		Title:        title,
		Description:  desc,
		PageURL:      meta.URL,
		Boot:         template.JS(boot),
		StatusBanner: statusLine,
		StatusTitle:  statusTitle,
		BoardCSS:     template.CSS(guestBoardCSS),
		BoardJS:      template.JS(guestBoardJS),
	})
}

// compactStatusLine 紧凑状态条与悬停 title 的拼装（P-20261111-5）：短段键
// snapshotShort/expiresShort（各一个 {time} 占位）按段存在与否拼为单行
// 「快照 {t} · {t} 过期」，全句键 snapshotBanner/shareExpiresAt 同步拼为
// title——两段都在时短文案以「 · 」相连、全句按语言连接（zh 分号；en 全句
// 自带句点，空格即可）；快照段缺席（live+TTL）单独出过期段，两段皆空零渲染
func compactStatusLine(d map[string]string, lang, snapAt, expAt string) (string, string) {
	line, full := "", ""
	if snapAt != "" {
		line = strings.Replace(d["snapshotShort"], "{time}", snapAt, 1)
		full = strings.Replace(d["snapshotBanner"], "{time}", snapAt, 1)
	}
	if expAt == "" {
		return line, full
	}
	seg := strings.Replace(d["expiresShort"], "{time}", expAt, 1)
	fullSeg := strings.Replace(d["shareExpiresAt"], "{time}", expAt, 1)
	if line == "" {
		return seg, fullSeg
	}
	joiner := "；"
	if lang != "zh" {
		joiner = " "
	}
	return line + " · " + seg, full + joiner + fullSeg
}

// metaLine 链接元信息的单行文本：控制字符折叠为空格、连续空白压缩，
// 并按 rune 截断——文件名/项目名可能含换行/制表符（Linux 合法文件名字符），
// 直接进 title/OG 会造成多行头与不可预期换行；html/template 只会做 HTML
// 转义，这一层负责「单行语义」。截断防超长标题占满聊天卡片。
func metaLine(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if max > 0 {
		runes := []rune(s)
		if len(runes) > max {
			return string(runes[:max]) + "…"
		}
	}
	return s
}

// pageLinkMeta 直出 title/description（P-20261020-11）。口令/一次性记录
// 整体泛化：记录字段不进入任何元信息；普通记录 = 文件名 + 类型 + 项目。
func pageLinkMeta(d map[string]string, m pageMeta) (string, string) {
	fallbackTitle := "Codecombo " + d["appTitle"]
	if m.Sensitive {
		return fallbackTitle, d["metaDescGeneric"]
	}
	name := metaLine(m.Name, 120)
	if name == "" {
		return fallbackTitle, d["metaDescGeneric"]
	}
	title := name + " · " + d["appTitle"]
	if m.Snippet {
		return title, strings.ReplaceAll(d["metaDescSnippet"], "{name}", name)
	}
	project := metaLine(m.ProjectName, 80)
	key, plainKey := "metaDescFile", "metaDescFilePlain"
	if m.IsDir {
		key, plainKey = "metaDescDir", "metaDescDirPlain"
	}
	if project == "" {
		return title, strings.ReplaceAll(d[plainKey], "{name}", name)
	}
	// NewReplacer 单遍替换：文件名/项目名本身含 {name}/{project} 字面量时
	// 不会被二次展开
	return title, strings.NewReplacer("{name}", name, "{project}", project).Replace(d[key])
}
