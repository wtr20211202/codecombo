package filepreview

// csv/tsv → 净化 HTML 表格：encoding/csv 解析（容忍脏行/不齐列），首行作
// 表头，超行数截断——分享访客面 render 管道与主应用预览 API 同链路（P-20261119-4
// 抽包下沉）。单元格经 html.EscapeString 转义后进输出，结构完全由本文件
// 生成——注入面为零

import (
	"encoding/csv"
	"html"
	"io"
	"strconv"
	"strings"
)

// CSVMaxDataRows 渲染行数上限（数据行，不含表头）：万行级 DOM 会拖垮
// 渲染与滚动，截断后由页面补"仅渲染前 N 行"提示
const CSVMaxDataRows = 2000

// RenderCSVHTML 解析 csv/tsv（comma 为字段分隔符）并输出净化表格片段。
// 解析出错按脏行跳过继续（best-effort 预览，下载始终可用）
func RenderCSVHTML(content []byte, comma rune) string {
	r := csv.NewReader(strings.NewReader(string(content)))
	r.Comma = comma
	r.FieldsPerRecord = -1 // 列数不齐不报错：预览尽力呈现
	r.LazyQuotes = true

	var b strings.Builder
	b.WriteString(`<div class="sc-csv"><table>`)
	rows, headerDone, truncated := 0, false, false
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue // 脏行跳过
		}
		if rows >= CSVMaxDataRows {
			truncated = true
			break
		}
		rows++
		if !headerDone {
			// 首行作表头（csv 惯例）
			b.WriteString("<thead><tr>")
			for _, cell := range rec {
				b.WriteString("<th>")
				b.WriteString(html.EscapeString(cell))
				b.WriteString("</th>")
			}
			b.WriteString("</tr></thead>")
			headerDone = true
			continue
		}
		b.WriteString("<tr>")
		for _, cell := range rec {
			b.WriteString("<td>")
			b.WriteString(html.EscapeString(cell))
			b.WriteString("</td>")
		}
		b.WriteString("</tr>")
	}
	if rows == 0 {
		return `<div class="doc-err"><p>empty</p></div>`
	}
	b.WriteString("</table></div>")
	if truncated {
		// 行数由前端补文案（双语在页面字典）：data 属性承载已渲染行数
		b.WriteString(`<p class="doc-note sc-csv-trunc" data-rows="` +
			strconv.Itoa(rows) + `"></p>`)
	}
	return b.String()
}
