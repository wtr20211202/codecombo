package filepreview

// xlsx（OOXML 电子表格）→ 净化 HTML 表格：stdlib zip+xml 流式抽取「首表」的
// 文本级预览（P-20261116-5-S1）。与 csv 表格（table.go）同链路同形态——页内
// 注入 .md-article.csv（全宽横滚）+ enhanceArticle 表格增强自动生效，行上限
// 同 CSVMaxDataRows 口径、截断 note 复用 sc-csv-trunc（前端按 data 属性补双语）。
// zip 取件与 per-part LimitReader 解压闸沿用 office.go（P-20261116-4）的基建
// 模式（P-20261119-4 起本文件与 office.go 同属本包，闸常量同包直取）：zip 元数据声明尺寸可被伪造，闸施加在解压流上而非元数据。
//
// 首表判定不做 sheet1.xml 文件名假设（文件名与工作表顺序无必然对应）：
// xl/workbook.xml <sheets> 文档顺序首个 <sheet> 的 r:id → xl/_rels/
// workbook.xml.rels 解析 Target（相对 xl/ 基准，/ 开头为包内绝对路径）。
//
// 单元格取值覆盖 t="s"（sharedStrings 引用）/inlineStr（直读，sharedStrings
// 缺失容错——部分生成器全内联书写）/str（公式缓存字符串值）/b（布尔）/
// 缺省数字；日期序列需 styles.xml 数字格式联动，按「文本级预览」定位取舍
// 输出原始序列值。合并单元格取锚点格值、其余格缺席即空——超形态一律降级
// 空单元格。所有文本经 html.EscapeString 转义后才进输出，表格结构完全由
// 本文件生成——注入面为零。零新依赖。

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"html"
	"io"
	"path"
	"strconv"
	"strings"
)

const (
	// sheetPartMaxBytes 工作表部件解压侧上限（防 zip 炸弹；同 docxZipMaxBytes
	// 语义）
	sheetPartMaxBytes = 64 << 20
	// sheetXMLMaxBytes workbook.xml/rels 等小部件解压侧上限（正常几 KB，
	// 防畸形包；与 docxRelsMaxBytes 同量级）
	sheetXMLMaxBytes = 1 << 20
	// sheetSharedMaxBytes sharedStrings.xml 解压侧上限（真实大表 MB 量级）
	sheetSharedMaxBytes = 8 << 20
	// sheetSharedMaxItems 字符串表条目上限（防畸形包海量条目撑大索引表）
	sheetSharedMaxItems = 100000
	// sheetMaxDataRows 渲染行数上限：csv 先例只有行上限无列上限（table.go
	// CSVMaxDataRows 2000 同款语义，表头计一行）
	sheetMaxDataRows = CSVMaxDataRows
	// sheetMaxCols 列上限：xlsx 单元格带位置属性，畸形稀疏行可声明任意远列，
	// 无列闸会把补位空 td 放大成无界 DOM（Excel 上限 16384 列，文本级预览
	// 取 256 收口；超限列直接丢弃）
	sheetMaxCols = 256
	// sheetCellMaxBytes 单元格文本上限（64KB 同 docxParaMaxBytes 语义——超长
	// 单格截断补 …，防单格挤占 4MB 总预算）
	sheetCellMaxBytes = 64 << 10
)

// errSheet* 首表定位链断点（上层降级错误卡，下载始终可用）
var (
	errSheetNoWorkbook  = errors.New("filepreview: xl/workbook.xml not found")
	errSheetNoRels      = errors.New("filepreview: xl/_rels/workbook.xml.rels not found")
	errSheetNoFirstRel  = errors.New("filepreview: workbook has no sheet relationship id")
	errSheetNoWorksheet = errors.New("filepreview: first sheet part not found")
)

// RenderSheetHTML xlsx 入口：zip 打开 → 首表定位 → 流式抽取净化表格
func RenderSheetHTML(content []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", err
	}
	shared := sheetSharedStrings(zr)
	target, err := firstSheetTarget(zr)
	if err != nil {
		return "", err
	}
	f, ok := zipPart(zr, target)
	if !ok {
		return "", errSheetNoWorksheet
	}
	rc, err := f.Open()
	if err != nil {
		return "", err
	}
	defer rc.Close()
	p := &sheetParser{shared: shared}
	p.parse(io.LimitReader(rc, sheetPartMaxBytes))
	return p.html(), nil
}

// zipPart 按条目名取 zip 部件（office.go 同款取件模式；本链路取件数固定
// ≤4，线性扫描即可，不建全包索引）
func zipPart(zr *zip.Reader, name string) (*zip.File, bool) {
	for _, f := range zr.File {
		if f.Name == name {
			return f, true
		}
	}
	return nil, false
}

// firstSheetTarget 首表定位链：workbook.xml 首个 <sheet> 的 r:id → rels
// 解析 Target 为 zip 条目名
func firstSheetTarget(zr *zip.Reader) (string, error) {
	wb, ok := zipPart(zr, "xl/workbook.xml")
	if !ok {
		return "", errSheetNoWorkbook
	}
	rid, err := firstSheetRelID(wb)
	if err != nil {
		return "", err
	}
	rels, ok := zipPart(zr, "xl/_rels/workbook.xml.rels")
	if !ok {
		return "", errSheetNoRels
	}
	target, ok := sheetRelTarget(rels, rid)
	if !ok {
		return "", errSheetNoWorksheet
	}
	return target, nil
}

// firstSheetRelID 读 workbook.xml 文档顺序首个 <sheet> 的 r:id（命名空间
// URI 不统一，只认局部名——office.go attrLocal 同口径）
func firstSheetRelID(f *zip.File) (string, error) {
	rc, err := f.Open()
	if err != nil {
		return "", err
	}
	defer rc.Close()
	dec := xml.NewDecoder(io.LimitReader(rc, sheetXMLMaxBytes))
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", err
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "sheet" {
			continue
		}
		if id := attrLocal(se, "id"); id != "" {
			return id, nil
		}
		return "", errSheetNoFirstRel
	}
}

// sheetRelTarget 在 rels 里找 Id 匹配的 Target 并解析为 zip 条目名。
// 预览语义优先于完整性：rels 解析中断按未命中处理
func sheetRelTarget(f *zip.File, rid string) (string, bool) {
	rc, err := f.Open()
	if err != nil {
		return "", false
	}
	defer rc.Close()
	dec := xml.NewDecoder(io.LimitReader(rc, sheetXMLMaxBytes))
	for {
		tok, err := dec.Token()
		if err != nil {
			return "", false
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "Relationship" {
			continue
		}
		if attrLocal(se, "Id") != rid {
			continue
		}
		name := resolveSheetTarget(attrLocal(se, "Target"))
		return name, name != ""
	}
}

// resolveSheetTarget rels Target → zip 条目名（rels 驻留 xl/_rels/，基部件
// 在 xl/——与 office.go resolveMediaTarget 同判式：相对 Target 按 xl/ 基准
// 解析，OPC 包根绝对形态 /xl/... 按包根解析；反斜杠/越界（.. 逃出包根）
// 一律忽略）
func resolveSheetTarget(target string) string {
	if strings.ContainsAny(target, "\\\x00") {
		return ""
	}
	var name string
	if strings.HasPrefix(target, "/") {
		name = path.Clean("/" + target)
	} else {
		name = path.Clean("xl/" + target)
	}
	name = strings.TrimPrefix(name, "/")
	if strings.HasPrefix(name, "../") || name == ".." {
		return ""
	}
	return name
}

// sheetSharedStrings 解析 xl/sharedStrings.xml 为索引表。部分生成器无此
// 部件（全 inlineStr 书写）——缺失容错为空表；<si> 内所有 <t>（含富文本
// run）拼接为条目文本，条目数与解压字节双闸
func sheetSharedStrings(zr *zip.Reader) []string {
	f, ok := zipPart(zr, "xl/sharedStrings.xml")
	if !ok {
		return nil
	}
	rc, err := f.Open()
	if err != nil {
		return nil
	}
	defer rc.Close()
	var (
		out    []string
		cur    strings.Builder
		inSI   bool
		inText bool
		total  int
	)
	dec := xml.NewDecoder(io.LimitReader(rc, sheetSharedMaxBytes))
	for {
		tok, err := dec.Token()
		if err != nil {
			break // 预览语义优先于完整性：已解析条目照用
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inSI = true
				inText = false
				cur.Reset()
			case "t":
				inText = true
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "t":
				inText = false
			case "si":
				if inSI {
					inSI = false
					s := utf8Cut(cur.String(), sheetCellMaxBytes)
					if len(out) < sheetSharedMaxItems {
						out = append(out, s)
					}
					total += len(s)
					if total > sheetSharedMaxBytes {
						return out // 字节闸触顶：不再累积
					}
				}
			}
		case xml.CharData:
			if inSI && inText {
				cur.Write(t)
			}
		}
	}
	return out
}

// ── 工作表流式解析 ──
// 事件模型（只关心呈现所需的最小子集）：
//   row 行（全空行跳过；行号间隙不补空行——畸形行号 r="1048576" 无放大面）
//   c 单元格：r 属性列位（缺省顺位）、t 类型；稀疏缺席列补空 td 保对齐
//   v 值（公式单元格取缓存值形态，<f> 公式本体不参与预览）
//   is 内 t 直读文本（inlineStr）

type sheetParser struct {
	out     strings.Builder
	outN    int // 已落盘字节（officeHTMLMaxBytes 真预算）
	full    bool
	shared  []string
	rows    int
	header  bool // 已发射表头（首个非空行，csv 惯例同款）
	trunc   bool
	rowCaps []string // 当前行单元格（已转义）
	rowFull bool     // 当前行已达列上限
	curCol  int      // 行内下一格列位游标（稀疏补空）
	cellCol int
	cellT   string
	rawV    strings.Builder
	inl     strings.Builder
	inV     bool
	inT     bool
	inIS    bool
}

// parse 流式消费工作表 XML。中断/局部损坏时返回已抽取内容
// （预览语义优先于完整性）
func (p *sheetParser) parse(r io.Reader) {
	dec := xml.NewDecoder(r)
	for {
		tok, err := dec.Token()
		if err != nil {
			return
		}
		switch t := tok.(type) {
		case xml.StartElement:
			p.start(t)
		case xml.EndElement:
			p.end(t.Name.Local)
		case xml.CharData:
			p.chars(string(t))
		}
		if p.full {
			return
		}
	}
}

func (p *sheetParser) start(t xml.StartElement) {
	switch t.Name.Local {
	case "c":
		p.cellCol = p.curCol // 无 r 属性（部分生成器）：按顺位列位
		if ref := attrLocal(t, "r"); ref != "" {
			p.cellCol = colIndexOf(ref)
		}
		p.cellT = attrLocal(t, "t")
		p.rawV.Reset()
		p.inl.Reset()
		p.inV, p.inT, p.inIS = false, false, false
	case "v":
		p.inV = true
	case "is":
		p.inIS = true
	case "t":
		p.inT = p.inIS // worksheet 内 <t> 只出现在 <is> 里
	}
}

func (p *sheetParser) end(name string) {
	switch name {
	case "v":
		p.inV = false
	case "t":
		p.inT = false
	case "is":
		p.inIS = false
	case "c":
		p.closeCell()
	case "row":
		p.closeRow()
	}
}

func (p *sheetParser) chars(s string) {
	switch {
	case p.inV:
		p.rawV.WriteString(s)
	case p.inT:
		p.inl.WriteString(s)
	}
}

// colIndexOf "A1" → 0（A=0、AA=26…）；只取前导字母段
func colIndexOf(ref string) int {
	n := 0
	for _, c := range ref {
		switch {
		case c >= 'A' && c <= 'Z':
			n = n*26 + int(c-'A') + 1
		case c >= 'a' && c <= 'z':
			n = n*26 + int(c-'a') + 1
		default:
			return n - 1 // 数字行号段开始
		}
		if n > sheetMaxCols {
			return sheetMaxCols // 提前截断：远列必被丢弃，防字符串超长放大
		}
	}
	return n - 1
}

// closeCell 单元格收口：列闸内补空对齐 + 取值转义；超限列/满行丢弃
// （超形态降级）。补空循环同步推进游标——间隙补到列位即止，不靠
// rowCaps 上限兜底终止
func (p *sheetParser) closeCell() {
	if p.cellCol < sheetMaxCols && !p.rowFull {
		for p.curCol < p.cellCol && len(p.rowCaps) < sheetMaxCols {
			p.rowCaps = append(p.rowCaps, "")
			p.curCol++
		}
		if len(p.rowCaps) < sheetMaxCols {
			p.rowCaps = append(p.rowCaps, escapeCell(p.cellText()))
		}
		p.rowFull = len(p.rowCaps) >= sheetMaxCols
		if p.cellCol+1 > p.curCol {
			p.curCol = p.cellCol + 1
		}
	}
	p.inV, p.inT, p.inIS = false, false, false
}

// cellText 按 t 类型取显示文本（公式单元格取缓存值形态）
func (p *sheetParser) cellText() string {
	v := strings.TrimSpace(p.rawV.String())
	switch p.cellT {
	case "s": // sharedStrings 索引
		idx, err := strconv.Atoi(v)
		if err != nil || idx < 0 || idx >= len(p.shared) {
			return "" // 悬空索引降级空单元格
		}
		return p.shared[idx]
	case "inlineStr":
		return p.inl.String()
	case "str": // 公式缓存字符串值
		return v
	case "b":
		if v == "" {
			return ""
		}
		if v == "1" {
			return "TRUE"
		}
		return "FALSE"
	default: // n/缺省=数字；e=错误值原文；日期序列按文本级定位输出原值
		return v
	}
}

// closeRow 行收口：整行构建为完整片段后原子发射（预算不足整行放弃——
// 杜绝截半标签），超行上限截断停机
func (p *sheetParser) closeRow() {
	// 全空行跳过（无单元格，或单元格在但全无值——视觉空行，csv 空行同款；
	// 行号间隙不补空行：畸形行号 r="1048576" 无放大面）
	empty := true
	for _, c := range p.rowCaps {
		if c != "" {
			empty = false
			break
		}
	}
	row := ""
	if !empty {
		row = p.rowHTML()
	}
	p.rowCaps = p.rowCaps[:0]
	p.rowFull = false
	p.curCol = 0
	if row == "" {
		return
	}
	if p.rows >= sheetMaxDataRows {
		p.trunc = true
		p.full = true
		return
	}
	if !p.emit(row) {
		return
	}
	p.rows++
	p.header = true
}

// rowHTML 当前行 → 完整表格片段（空行返回 ""）。首行作表头（csv 惯例同款）
func (p *sheetParser) rowHTML() string {
	if len(p.rowCaps) == 0 {
		return ""
	}
	var b strings.Builder
	if p.header {
		b.WriteString("<tr>")
	} else {
		b.WriteString("<thead><tr>")
	}
	for _, c := range p.rowCaps {
		if p.header {
			b.WriteString("<td>" + c + "</td>")
		} else {
			b.WriteString("<th>" + c + "</th>")
		}
	}
	if p.header {
		b.WriteString("</tr>")
	} else {
		b.WriteString("</tr></thead>")
	}
	return b.String()
}

// emit 整段原子写入 + 真预算（officeHTMLMaxBytes 同闸：不足整段放弃并
// 停机，杜绝截半标签）
func (p *sheetParser) emit(s string) bool {
	if p.outN+len(s) > officeHTMLMaxBytes {
		p.full = true
		p.trunc = true
		return false
	}
	p.out.WriteString(s)
	p.outN += len(s)
	return true
}

// html 汇总输出：外层结构与 csv 表格同形（.sc-csv 容器 + 截断 note 复用
// sc-csv-trunc，前端按 data-rows 补双语）。零行时同 csv 的空表错误卡
func (p *sheetParser) html() string {
	if p.rows == 0 {
		return `<div class="doc-err"><p>empty</p></div>`
	}
	var b strings.Builder
	b.WriteString(`<div class="sc-csv"><table>`)
	b.WriteString(p.out.String())
	b.WriteString("</table></div>")
	if p.trunc {
		note := `<p class="doc-note sc-csv-trunc" data-rows="` + strconv.Itoa(p.rows) + `"></p>`
		if p.outN+len(note) <= officeHTMLMaxBytes {
			b.WriteString(note)
		}
	}
	return b.String()
}

// escapeCell 单元格文本转义（构造期转义、注入面为零——table.go 同模式）。
// 原始字节超限先按 rune 边界裁剪并补 … 指示（docx charData 同款）；转义可
// 膨胀（& → &amp;），转义后仍超限再裁一次——单格尺寸有界
func escapeCell(text string) string {
	if len(text) > sheetCellMaxBytes {
		text = utf8Cut(text, sheetCellMaxBytes-3) + "…"
	}
	s := html.EscapeString(text)
	if len(s) > sheetCellMaxBytes {
		s = utf8Cut(s, sheetCellMaxBytes-3) + "…"
	}
	return s
}
