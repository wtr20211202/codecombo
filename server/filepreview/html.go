package filepreview

import (
	"html"
	"strings"
)

// InjectHTMLBase 在 html 的 <head> 后插入 <base>（大小写不敏感；无 head
// 时前置——浏览器容错解析同样生效）。htmlview 端点（share /s/{t}/html 与
// 主应用 /api/projects/:id/file/htmlview）共用：相对 css/img 子资源按
// <base> 层级回源各自的 rel 通配端点
func InjectHTMLBase(content []byte, base string) []byte {
	tag := []byte(`<base href="` + html.EscapeString(base) + `">`)
	lower := []byte(strings.ToLower(string(content)))
	idx := strings.Index(string(lower), "<head")
	if idx < 0 {
		return append(tag, content...)
	}
	gt := strings.Index(string(lower[idx:]), ">")
	if gt < 0 {
		return append(tag, content...)
	}
	pos := idx + gt + 1
	out := make([]byte, 0, len(content)+len(tag))
	out = append(out, content[:pos]...)
	out = append(out, tag...)
	out = append(out, content[pos:]...)
	return out
}

// RawContentType raw 响应的 Content-Type：仅文本族追加 charset——字体/图片/
// 音视频不带 charset 参数（P-20261020-4 起 MIME 表含 font/*，二进制类型
// 挂 charset 是无意义的元数据噪声）
func RawContentType(mime string) string {
	if strings.HasPrefix(mime, "text/") || mime == "application/json" ||
		mime == "application/javascript" || strings.HasSuffix(mime, "+xml") {
		return mime + "; charset=utf-8"
	}
	return mime
}
