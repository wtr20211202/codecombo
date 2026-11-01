// Package preview 分享预览能力注册表：文件名 → 预览描述符的唯一判定源。
//
// 扩展模型：分享页与服务端都不硬编码"支持哪些后缀"，一切由描述符驱动——
// 新增一类预览（如 csv 表格渲染、office 在线转换）= 注册一个后缀映射 +
// 分享页为对应 Kind 增加一个渲染分支（页面分支集中且带默认信息卡兜底，
// 后端只多一条映射）。未注册后缀一律回退 KindInfo（展示名称/大小/修改
// 时间等信息卡 + 下载按钮），保证"任何格式都可分享"。
package preview

import (
	"path/filepath"
	"strings"
	"sync"
)

// Kind 分享页的渲染分支标识
type Kind string

const (
	KindMarkdown Kind = "markdown" // 服务端渲染净化 HTML
	KindPDF      Kind = "pdf"      // 浏览器内嵌查看
	KindImage    Kind = "image"
	KindText     Kind = "text" // 纯文本/代码
	KindVideo    Kind = "video"
	KindAudio    Kind = "audio"
	// KindDocx Word 文档（docx 直解；doc 老格式 best-effort 抽取）：
	// 服务端抽取文本结构渲染净化 HTML
	KindDocx Kind = "docx"
	// KindHTML 静态网页：经 /html 端点注入 <base> 后以 sandbox iframe 呈现，
	// 相对 css/img 子资源经 /f/ 路由回源分享根（脚本默认被双层拦死；访客可
	// 按文件显式 opt-in「运行脚本（隔离）」，sandbox 只加 allow-scripts，
	// 绝不放宽 allow-same-origin——见 server/share/service.go handleHTMLDoc）
	KindHTML Kind = "html"
	// KindCSV 表格数据（csv/tsv）：服务端解析渲染为净化表格，超行数截断
	KindCSV  Kind = "csv"
	KindInfo Kind = "info" // 不支持内联预览：信息卡（名称/大小/修改时间）+ 下载
)

// Descriptor 描述一个后缀如何被分享子服务呈现
type Descriptor struct {
	Kind Kind
	// MIME raw 端点的 Content-Type（含 charset 由服务端统一追加）
	MIME string
}

// Entry 单条注册项
type Entry struct {
	Ext  string // 不带点的小写后缀
	Desc Descriptor
}

var (
	mu       sync.RWMutex
	registry = map[string]Descriptor{}
)

// Register 注册/覆盖一个后缀的预览描述符（内置表在 init 里装配；
// 运行期注册供扩展与测试使用）。ext 不带点、大小写不敏感
func Register(ext string, d Descriptor) {
	mu.Lock()
	defer mu.Unlock()
	registry[strings.ToLower(strings.TrimPrefix(ext, "."))] = d
}

// ForFile 按文件名解析预览描述符。未注册后缀 → KindInfo +
// application/octet-stream（任何文件都可分享，展示信息卡）。
// 后缀优先；无点文件名（Makefile）按整名兜底；点开头文件（.gitignore、
// .probe-sample.docx）先整名、再按真实后缀——隐藏标记不吞类型
func ForFile(name string) Descriptor {
	lookup := func(key string) (Descriptor, bool) {
		mu.RLock()
		d, ok := registry[strings.ToLower(key)]
		mu.RUnlock()
		return d, ok
	}
	ext := strings.TrimPrefix(filepath.Ext(name), ".")
	if d, ok := lookup(ext); ok && ext != "" {
		return d
	}
	if d, ok := lookup(name); ok {
		return d
	}
	return Descriptor{Kind: KindInfo, MIME: "application/octet-stream"}
}

// builtin 内置映射表（声明一行 = 一类可预览格式；扩展点见包注释）
func builtin() []Entry {
	textExts := []struct {
		ext, mime string
	}{
		{"txt", "text/plain"}, {"log", "text/plain"}, {"text", "text/plain"},
		{"json", "application/json"}, {"yaml", "text/plain"}, {"yml", "text/plain"},
		{"toml", "text/plain"}, {"ini", "text/plain"}, {"conf", "text/plain"},
		{"xml", "text/plain"}, {"sql", "text/plain"},
		{"sh", "text/plain"}, {"bash", "text/plain"}, {"zsh", "text/plain"},
		{"bat", "text/plain"}, {"ps1", "text/plain"}, {"makefile", "text/plain"},
		// js/mjs/cjs 与 css 不在此列：HTML 预览的 <link>/<script> 子资源必须
		// 按浏览器可消费的 MIME 响应（text/plain + nosniff 会被拒绝执行）。
		// ts/tsx/jsx/scss/less 仍按源文件纯文本预览——浏览器本就不消费它们
		{"ts", "text/plain"}, {"tsx", "text/plain"}, {"jsx", "text/plain"},
		{"go", "text/plain"}, {"py", "text/plain"}, {"rs", "text/plain"}, {"java", "text/plain"},
		{"kt", "text/plain"}, {"c", "text/plain"}, {"h", "text/plain"}, {"cpp", "text/plain"}, {"hpp", "text/plain"},
		{"cs", "text/plain"}, {"rb", "text/plain"}, {"php", "text/plain"}, {"swift", "text/plain"},
		{"vue", "text/plain"}, {"scss", "text/plain"}, {"less", "text/plain"},
		{"gitignore", "text/plain"}, {"gitattributes", "text/plain"}, {"env", "text/plain"}, {"lock", "text/plain"},
		{"diff", "text/plain"}, {"patch", "text/plain"}, {"proto", "text/plain"}, {"graphql", "text/plain"},
		// 常见缺省补齐：字幕、构建/配置、文档标记、点开头配置
		{"srt", "text/plain"}, {"vtt", "text/plain"}, {"ass", "text/plain"}, {"ssa", "text/plain"},
		{"properties", "text/plain"}, {"gradle", "text/plain"}, {"cmake", "text/plain"}, {"mk", "text/plain"},
		{"rst", "text/plain"}, {"adoc", "text/plain"}, {"tex", "text/plain"}, {"ipynb", "application/json"},
		{"editorconfig", "text/plain"}, {"npmrc", "text/plain"},
	}
	entries := []Entry{
		// markdown：服务端渲染净化 HTML；html/htm 经 /html 端点注入 <base>
		// 后走 sandbox iframe（相对子资源经 /f/ 路由回源）
		{Ext: "md", Desc: Descriptor{Kind: KindMarkdown, MIME: "text/markdown"}},
		{Ext: "markdown", Desc: Descriptor{Kind: KindMarkdown, MIME: "text/markdown"}},
		// HTML 预览的外链资源（P-20261020-4）：浏览器对 nosniff 响应严格按
		// Content-Type 消费样式表/脚本——text/plain 会静默丢样式与脚本。
		// text/javascript 是 WHATWG 现行标准类型（application/javascript 已
		// 过时但等价），ES module 的 mjs 同型
		{Ext: "css", Desc: Descriptor{Kind: KindText, MIME: "text/css"}},
		{Ext: "js", Desc: Descriptor{Kind: KindText, MIME: "text/javascript"}},
		{Ext: "mjs", Desc: Descriptor{Kind: KindText, MIME: "text/javascript"}},
		{Ext: "cjs", Desc: Descriptor{Kind: KindText, MIME: "text/javascript"}},
		// 字体：HTML 预览的 @font-face 子资源（/f/ 路由另加 CORS——不透明
		// 源下的字体请求按跨源处理，缺 ACAO 会被浏览器拒绝）。字体本身
		// 无内联预览语义，按信息卡 + 下载呈现
		{Ext: "woff", Desc: Descriptor{Kind: KindInfo, MIME: "font/woff"}},
		{Ext: "woff2", Desc: Descriptor{Kind: KindInfo, MIME: "font/woff2"}},
		{Ext: "ttf", Desc: Descriptor{Kind: KindInfo, MIME: "font/ttf"}},
		{Ext: "otf", Desc: Descriptor{Kind: KindInfo, MIME: "font/otf"}},
		{Ext: "pdf", Desc: Descriptor{Kind: KindPDF, MIME: "application/pdf"}},
		{Ext: "png", Desc: Descriptor{Kind: KindImage, MIME: "image/png"}},
		{Ext: "jpg", Desc: Descriptor{Kind: KindImage, MIME: "image/jpeg"}},
		{Ext: "jpeg", Desc: Descriptor{Kind: KindImage, MIME: "image/jpeg"}},
		{Ext: "gif", Desc: Descriptor{Kind: KindImage, MIME: "image/gif"}},
		{Ext: "webp", Desc: Descriptor{Kind: KindImage, MIME: "image/webp"}},
		{Ext: "bmp", Desc: Descriptor{Kind: KindImage, MIME: "image/bmp"}},
		{Ext: "ico", Desc: Descriptor{Kind: KindImage, MIME: "image/x-icon"}},
		{Ext: "avif", Desc: Descriptor{Kind: KindImage, MIME: "image/avif"}},
		// svg 是可携带脚本的 XML：内联展示走 img 标签（页面侧不 iframe，
		// 服务端另加 CSP sandbox 头）——按图片处理，不在 raw 里当文档渲染
		{Ext: "svg", Desc: Descriptor{Kind: KindImage, MIME: "image/svg+xml"}},
		{Ext: "mp4", Desc: Descriptor{Kind: KindVideo, MIME: "video/mp4"}},
		{Ext: "m4v", Desc: Descriptor{Kind: KindVideo, MIME: "video/mp4"}},
		{Ext: "webm", Desc: Descriptor{Kind: KindVideo, MIME: "video/webm"}},
		// ogv 是 theora 视频；ogg 容器绝大多数是音频（按 video 播会出现空画面），
		// opus 常以 ogg 封装——三者按内容主流形态归类
		{Ext: "ogv", Desc: Descriptor{Kind: KindVideo, MIME: "video/ogg"}},
		{Ext: "mov", Desc: Descriptor{Kind: KindVideo, MIME: "video/quicktime"}},
		{Ext: "mkv", Desc: Descriptor{Kind: KindVideo, MIME: "video/x-matroska"}},
		{Ext: "ogg", Desc: Descriptor{Kind: KindAudio, MIME: "audio/ogg"}},
		{Ext: "opus", Desc: Descriptor{Kind: KindAudio, MIME: "audio/ogg"}},
		{Ext: "mp3", Desc: Descriptor{Kind: KindAudio, MIME: "audio/mpeg"}},
		{Ext: "wav", Desc: Descriptor{Kind: KindAudio, MIME: "audio/wav"}},
		{Ext: "flac", Desc: Descriptor{Kind: KindAudio, MIME: "audio/flac"}},
		{Ext: "m4a", Desc: Descriptor{Kind: KindAudio, MIME: "audio/mp4"}},
		{Ext: "oga", Desc: Descriptor{Kind: KindAudio, MIME: "audio/ogg"}},
		// 常见办公/网页格式：
		//   docx/doc → 服务端抽取文本结构渲染（doc 老格式 best-effort，失败降级错误卡）
		//   html/htm → /html 端点注入 <base> 后 sandbox iframe 呈现（相对子资源
		//     经 /f/ 路由回源分享根；脚本默认被 sandbox+CSP 双层拦死，访客按
		//     文件显式 opt-in allow-scripts 时两层同步放开且绝不叠加 same-origin）
		//   csv/tsv → 服务端解析渲染为净化表格（超行数截断）
		//   xls/ppt 等其余办公格式维持信息卡，接转换器时覆盖注册即可
		{Ext: "doc", Desc: Descriptor{Kind: KindDocx, MIME: "application/msword"}},
		{Ext: "docx", Desc: Descriptor{Kind: KindDocx, MIME: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}},
		{Ext: "html", Desc: Descriptor{Kind: KindHTML, MIME: "text/html"}},
		{Ext: "htm", Desc: Descriptor{Kind: KindHTML, MIME: "text/html"}},
		{Ext: "csv", Desc: Descriptor{Kind: KindCSV, MIME: "text/csv"}},
		{Ext: "tsv", Desc: Descriptor{Kind: KindCSV, MIME: "text/tab-separated-values"}},
		{Ext: "xls", Desc: Descriptor{Kind: KindInfo, MIME: "application/vnd.ms-excel"}},
		{Ext: "xlsx", Desc: Descriptor{Kind: KindInfo, MIME: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}},
		{Ext: "ppt", Desc: Descriptor{Kind: KindInfo, MIME: "application/vnd.ms-powerpoint"}},
		{Ext: "pptx", Desc: Descriptor{Kind: KindInfo, MIME: "application/vnd.openxmlformats-officedocument.presentationml.presentation"}},
	}
	for _, t := range textExts {
		entries = append(entries, Entry{Ext: t.ext, Desc: Descriptor{Kind: KindText, MIME: t.mime}})
	}
	return entries
}

func init() {
	for _, e := range builtin() {
		Register(e.Ext, e.Desc)
	}
}
