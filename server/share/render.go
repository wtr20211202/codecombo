package share

import (
	stdhtml "html"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// renderSnippetHTML 文本片段的访客面渲染：单一 <pre><code> 代码块形态
// （等宽 + 页面主题变量由 .md-article 管线提供）。正文 html 转义——片段是
// 任意用户文本，绝不能当 HTML 解释；裸片段（不经页面 JS 注入、直接访问
// render 端点）同样安全。语言未知不加标注类（页面高亮管道对未标注块跳过，
// 错误高亮比没有更糟）。
// 片段语义属 share 访客面故不入 filepreview——md/docx 等富渲染管线在
// filepreview（P-20261119-4），本文件只留片段直出与 /s/{token} 相对资源
// 重写（NormalizeRelPath/端点形态均为 share 特有）
func renderSnippetHTML(content string) string {
	return "<pre><code>" + stdhtml.EscapeString(content) + "</code></pre>"
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
