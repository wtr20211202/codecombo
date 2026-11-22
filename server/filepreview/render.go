package filepreview

import (
	"regexp"

	"github.com/gomarkdown/markdown"
	"github.com/gomarkdown/markdown/html"
	"github.com/gomarkdown/markdown/parser"
	"github.com/microcosm-cc/bluemonday"
)

// 渲染上限常量（P-20261119-4 自 server/share/service.go 随迁——渲染面与
// 上限同包单一事实源；share 渲染端点与主应用预览 API 共用）：

// MaxRenderBytes markdown 服务端渲染的字节上限（超出给 413 仅下载提示）。
// 20MB 对齐前端文本预览上限：真实使用里大 README/导出文档在此量级常见，
// 2MB 时代"能下载不能看"的抱怨集中于此；渲染耗时随体积线性，20MB 在
// 秒级完成，内存峰值可控
const MaxRenderBytes = 20 << 20

// MaxDocxBytes docx/xlsx 包文件的读取上限（zip 解压侧另有 64MB 独立上限）
const MaxDocxBytes = 128 << 20

// RenderMarkdownHTML markdown → 净化 HTML 片段（不带页面骨架）。
// 渲染后过 bluemonday 白名单：内容是"任意用户文件"，必须假设其中
// 含脚本/事件属性；外链统一 target=_blank（渲染 Flag），脚本由净化器 +
// render 端点的 CSP sandbox 双保险拦截
func RenderMarkdownHTML(content []byte) string {
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
