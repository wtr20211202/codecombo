package shared

// SanitizeCSVCell 防 CSV 公式注入（业界惯例注记）：以 = + - @（及制表/回车）
// 开头的单元格前置单引号——Excel/WPS 等表格软件会把这类开头当公式执行，而
// 导出列常含用户可控片段（审计 Detail / 审批 op·target·reason 等自由文本）。
// 前缀单引号后按纯文本呈现，属 OWASP CSV 注入防护的通行做法。
//
// P-20261003-247 起自 system 包提升为导出族公共 helper（审计 CSV 与审批裁决
// CSV 两个消费方；纯函数平移零行为变化），与 ContentDispositionFile 同属
// 「导出族响应 hygiene」——后续 CSV 导出端点一律经此，不再各包自带
func SanitizeCSVCell(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}
