package shared

import "strings"

// ContentDispositionFile 生成附件下载的 Content-Disposition 头值（P-20261003-109
// 全站统一净化 helper）。下载端点（单文件/zip/导出族，既有与新增）一律经此产出
// 下载头，禁止手拼——文件名常是用户可控内容（文件名/会话名/分支名/目录名），
// 自拼头在含引号/CRLF 时是响应头注入面、含非 ASCII 时乱码。
//
// 输出为 RFC 6266 双形式：
//   - filename="<ASCII 兜底>"：净化后非 ASCII rune 折叠 '_'（真实名由 filename*
//     承载，兜底只为可保存性负责）；与历史手拼端点的 ASCII 输出逐字节兼容
//   - filename*=UTF-8''<percent 编码>：RFC 5987 ext-value，现代浏览器优先取用
//
// 净化规则与会话导出先例（P-44）一致：控制字符（含 CRLF——响应头注入面）与
// 引号/反斜杠剥除；剥除后 quoted-string 无需转义形态。filename* 值按 RFC 8187
// attr-char 白名单逐字节百分号编码——url.PathEscape 会放过 `;`/`=`/`,` 等参数
// 分隔符，直接用会把头参数拆散（历史实现的隐患，本 helper 一并收口）。
// 整名被剥空时回退裸 attachment（无文件名附件仍可下载，P-44 同语义）。
func ContentDispositionFile(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '"' || r == '\\' {
			continue
		}
		b.WriteRune(r)
	}
	clean := b.String()
	if clean == "" {
		return "attachment"
	}
	return `attachment; filename="` + cdASCIIFallback(clean) + `"; filename*=UTF-8''` + cdRFC8187Encode(clean)
}

// cdASCIIFallback 双形式的 filename 兜底值：非 ASCII rune 折叠为 '_'（一 rune
// 一占位，多字节不重复占位）。净化已保证无引号/反斜杠/控制字符，quoted-string
// 直拼安全
func cdASCIIFallback(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r < 0x80 {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// cdRFC8187Encode RFC 8187 ext-value 编码：attr-char 之外的字节逐字节数字转义
//（大写 hex；多字节 UTF-8 按字节展开，与 RFC 5987 示例口径一致）
func cdRFC8187Encode(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if c := s[i]; cdIsAttrChar(c) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[s[i]>>4])
			b.WriteByte(hex[s[i]&0xf])
		}
	}
	return b.String()
}

// cdIsAttrChar RFC 8187 attr-char：ALPHA / DIGIT / "!#$&+-.^_`|~"
//（`*` 与 `'` 是 ext-value 结构定界符，必须转义）
func cdIsAttrChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
		strings.IndexByte("!#$&+-.^_`|~", c) >= 0
}
