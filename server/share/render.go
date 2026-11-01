package share

import (
	stdhtml "html"
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/gomarkdown/markdown"
	"github.com/gomarkdown/markdown/html"
	"github.com/gomarkdown/markdown/parser"
	"github.com/microcosm-cc/bluemonday"
)

// renderSnippetHTML 文本片段的访客面渲染：单一 <pre><code> 代码块形态
// （等宽 + 页面主题变量由 .md-article 管线提供）。正文 html 转义——片段是
// 任意用户文本，绝不能当 HTML 解释；裸片段（不经页面 JS 注入、直接访问
// render 端点）同样安全。语言未知不加标注类（页面高亮管道对未标注块跳过，
// 错误高亮比没有更糟）
func renderSnippetHTML(content string) string {
	return "<pre><code>" + stdhtml.EscapeString(content) + "</code></pre>"
}

// renderMarkdownHTML markdown → 净化 HTML 片段（不带页面骨架）。
// 渲染后过 bluemonday 白名单：分享内容是"任意用户文件"，必须假设其中
// 含脚本/事件属性；外链统一 target=_blank（渲染 Flag），脚本由净化器 +
// render 端点的 CSP sandbox 双保险拦截
func renderMarkdownHTML(content []byte) string {
	exts := parser.CommonExtensions | parser.AutoHeadingIDs | parser.NoEmptyLineBeforeBlock
	doc := parser.NewWithExtensions(exts).Parse(content)
	opts := html.RendererOptions{
		Flags: html.CommonFlags | html.HrefTargetBlank,
	}
	body := markdown.Render(doc, html.NewRenderer(opts))
	return string(sanitizer().SanitizeBytes(body))
}

// sanitizer 文档净化策略：UGC 白名单 + 表格/删除线/任务清单等 md 常用元素；
// 外链保留渲染器写入的 target=_blank（只允许这一个值，避免 reverse tabnabbing
// 面扩大），rel nofollow 由 UGCPolicy 默认附带。
// 标题 id 必须放行：AutoHeadingIDs 生成的锚点 id 是文内目录（[xx](#xx)）的
// 跳转目标——历史上 id 被净化器剥掉，目录点击全部静默失效
func sanitizer() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	p.AllowElements("del", "s", "input", "details", "summary")
	p.AllowAttrs("type").OnElements("input")
	p.AllowAttrs("align").OnElements("th", "td")
	p.AllowAttrs("target").Matching(regexp.MustCompile(`^_blank$`)).OnElements("a")
	// 标题锚点 id：仅允许常规 id 字符（字母/数字/下划线/连字符/点/空格/中文），
	// 拒绝引号、尖括号、控制字符等可能破坏属性边界的输入
	p.AllowAttrs("id").Matching(regexp.MustCompile(`^[\w\-. \p{L}\p{N}]+$`)).OnElements("h1", "h2", "h3", "h4", "h5", "h6")
	return p
}

// ── 相对资源重写（md 预览的分享内图片/链接可达性） ──
//
// 渲染片段注入在 /s/{token} 页面：md 里的相对引用（![](img/a.png)、
// [其他](other.md)）会按页面 URL 解析成 /s/img/a.png 之类的不存在路径
// ——图片破图、文档互链 404。净化之后统一重写（净化前正文转义文本不可能
// 产出真实 img/a 标签，正则只命中真实元素）：
//   img src   → /s/{t}/raw?path=<解析后的分享内路径>
//   a href    → /s/{t}?path=<…> 页内导航（分享页可预览任何文件；去掉
//     渲染器为外链写的 target=_blank，相对链接留在当前标签）
// 解析越界/异常引用原样保留，由 raw 端 404——重写绝不放宽路径边界

var (
	imgSrcRe = regexp.MustCompile(`(<img\b[^>]*?\bsrc=")([^"]*)(")`)
	// a 标签 href 后还可能跟 target/rel（渲染器为外链写的顺序）——一并
	// 捕获才能去掉重写链接上的 target=_blank
	aHrefRe = regexp.MustCompile(`(<a\b[^>]*?\bhref=")([^"]*)("[^>]*>)`)
)

// rewriteRelativeAssets dir 为片段所属文件在分享根内的目录（"" = 根）
func rewriteRelativeAssets(token, dir, htmlStr string) string {
	resolve := func(ref string) (string, bool) {
		if ref == "" || strings.HasPrefix(ref, "#") {
			return "", false
		}
		if strings.Contains(ref, "://") || strings.HasPrefix(ref, "data:") ||
			strings.HasPrefix(ref, "mailto:") {
			return "", false
		}
		// 与路径无关的装饰先行剥离（img.png?v=1、doc.md#锚点）
		if i := strings.IndexAny(ref, "?#"); i >= 0 {
			ref = ref[:i]
		}
		if ref == "" {
			return "", false
		}
		var candidate string
		if strings.HasPrefix(ref, "/") {
			// 根相对引用按分享根解析（页面里它指向站点根，必然 404）
			candidate = strings.TrimPrefix(ref, "/")
		} else {
			candidate = path.Join(dir, ref)
		}
		p, err := NormalizeRelPath(candidate)
		if err != nil || p == "" {
			return "", false
		}
		return p, true
	}
	rawURL := func(p string) string {
		return "/s/" + token + "/raw?path=" + url.QueryEscape(p)
	}
	navURL := func(p string) string {
		return "/s/" + token + "?path=" + url.QueryEscape(p)
	}
	htmlStr = imgSrcRe.ReplaceAllStringFunc(htmlStr, func(m string) string {
		sub := imgSrcRe.FindStringSubmatch(m)
		if p, ok := resolve(sub[2]); ok {
			return sub[1] + rawURL(p) + sub[3]
		}
		return m
	})
	htmlStr = aHrefRe.ReplaceAllStringFunc(htmlStr, func(m string) string {
		sub := aHrefRe.FindStringSubmatch(m)
		if p, ok := resolve(sub[2]); ok {
			// 相对链接是页内导航：href 后的属性里去掉 target=_blank
			tail := strings.Replace(sub[3], ` target="_blank"`, "", 1)
			return sub[1] + navURL(p) + tail
		}
		return m
	})
	return htmlStr
}
