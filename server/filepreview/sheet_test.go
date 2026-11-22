package filepreview

import (
	"archive/zip"
	"bytes"
	"errors"
	"strconv"
	"strings"
	"testing"
)

// buildXlsx 构造最小 xlsx 包（zip + 任意部件集）。键 = zip 条目名
func buildXlsx(t *testing.T, parts map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range parts {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// 首表定位链部件（评审必改①：首个工作表条目名是 first.xml 而非 sheet1.xml，
// sheet1.xml 是第二表——文件名假设会渲染到错误工作表，本套件以此设防）
const (
	sheetWorkbookXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="数据" sheetId="1" r:id="rId1"/>
<sheet name="Second" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>`

	sheetRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/first.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

	sheetSharedXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>名称</t></si>
<si><t>数量</t></si>
<si><t>苹果 &lt;鲜&gt;</t></si>
</sst>`

	// 全类型单元格 + 稀疏列 + 空行：s 引用/数字/公式缓存值 str/布尔/inlineStr
	sampleSheetXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3.14</v></c><c r="C2" t="str"><v>cached &lt;formula&gt;</v></c></row>
<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="b"><v>0</v></c><c r="C3" t="inlineStr"><is><t>inline &lt;img src=x onerror=alert(1)&gt;</t></is></c></row>
<row r="4"/>
<row r="5"><c r="A5"><v>after gap</v></c><c r="C5" t="s"><v>9</v></c></row>
</sheetData>
</worksheet>`

	secondSheetXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1"><v>WRONG-SHEET</v></c></row></sheetData>
</worksheet>`
)

func sampleXlsx(t *testing.T) []byte {
	t.Helper()
	return buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/sharedStrings.xml":       sheetSharedXML,
		"xl/worksheets/first.xml":    sampleSheetXML,
		"xl/worksheets/sheet1.xml":   secondSheetXML,
	})
}

func TestRenderSheetHTML(t *testing.T) {
	out, err := RenderSheetHTML(sampleXlsx(t))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		`<div class="sc-csv"><table>`,
		"<thead><tr><th>名称</th><th>数量</th></tr></thead>", // 首行表头（csv 惯例）
		"<td>苹果 &lt;鲜&gt;</td>",                          // sharedStrings 引用 + 转义
		"<td>3.14</td>",                                  // 数字
		"<td>cached &lt;formula&gt;</td>",                // 公式取缓存值形态
		"<td>TRUE</td>", "<td>FALSE</td>",                // 布尔
		"<td>inline &lt;img src=x onerror=alert(1)&gt;</td>", // inlineStr + 转义
		"<td>after gap</td>",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("sheet html missing %q in:\n%s", want, out)
		}
	}
	// 首表判定走 workbook 顺序（rId1→first.xml），文件名假设会命中第二表
	if strings.Contains(out, "WRONG-SHEET") {
		t.Errorf("rendered wrong sheet (filename assumption leaked):\n%s", out)
	}
	// 注入面：文本必须转义，绝不允许出现可执行的原始标记
	if strings.Contains(out, "<img src=x") || strings.Contains(out, "<formula>") {
		t.Errorf("raw markup leaked:\n%s", out)
	}
	// 稀疏补空（B5 缺席）+ 悬空共享索引（v=9 超 3 条目表）双双降级空格；
	// 空行 r=4 不产出空 tr
	if !strings.Contains(out, "<td>after gap</td><td></td><td></td>") {
		t.Errorf("sparse gap fill / dangling shared index broken:\n%s", out)
	}
	if got := strings.Count(out, "<tr>"); got != 4 { // 表头+3 数据行，空行跳过
		t.Errorf("row count = %d, want 4:\n%s", got, out)
	}
}

func TestRenderSheetNoSharedStrings(t *testing.T) {
	// 部分生成器全 inlineStr 书写且无 sharedStrings 部件——缺失容错
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/worksheets/first.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>only inline</t></is></c></row></sheetData></worksheet>`,
	}))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(out, "<th>only inline</th>") { // 单行 sheet：首行即表头
		t.Errorf("inlineStr without sharedStrings broken:\n%s", out)
	}
}

func TestRenderSheetFirstSheetAbsoluteTarget(t *testing.T) {
	// OPC 包根绝对形态 Target（/xl/...）
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml": sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": strings.Replace(sheetRelsXML,
			"worksheets/first.xml", "/xl/worksheets/first.xml", 1),
		"xl/sharedStrings.xml":     sheetSharedXML,
		"xl/worksheets/first.xml":  sampleSheetXML,
		"xl/worksheets/sheet1.xml": secondSheetXML,
	}))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(out, "WRONG-SHEET") || !strings.Contains(out, "苹果") {
		t.Errorf("absolute target resolution broken:\n%s", out)
	}
}

func TestRenderSheetErrorPaths(t *testing.T) {
	cases := []struct {
		name string
		pkg  []byte
		want error
	}{
		{"no workbook", buildXlsx(t, map[string]string{
			"xl/_rels/workbook.xml.rels": sheetRelsXML,
			"xl/worksheets/first.xml":    sampleSheetXML,
		}), errSheetNoWorkbook},
		{"no rels", buildXlsx(t, map[string]string{
			"xl/workbook.xml":         sheetWorkbookXML,
			"xl/worksheets/first.xml": sampleSheetXML,
		}), errSheetNoRels},
		{"rel id unresolved", buildXlsx(t, map[string]string{
			"xl/workbook.xml": sheetWorkbookXML,
			"xl/_rels/workbook.xml.rels": strings.Replace(sheetRelsXML,
				`Id="rId1"`, `Id="rIdX"`, 1),
			"xl/worksheets/first.xml": sampleSheetXML,
		}), errSheetNoWorksheet},
		{"target dangling", buildXlsx(t, map[string]string{
			"xl/workbook.xml":            sheetWorkbookXML,
			"xl/_rels/workbook.xml.rels": sheetRelsXML,
			"xl/worksheets/sheet1.xml":   secondSheetXML, // first.xml 不在包内
		}), errSheetNoWorksheet},
		{"sheet has no r:id", buildXlsx(t, map[string]string{
			"xl/workbook.xml":            strings.Replace(sheetWorkbookXML, `r:id="rId1"`, ``, 1),
			"xl/_rels/workbook.xml.rels": sheetRelsXML,
			"xl/worksheets/first.xml":    sampleSheetXML,
		}), errSheetNoFirstRel},
		{"not a zip (xls 改名)", []byte("legacy OLE bytes"), nil},
	}
	for _, c := range cases {
		_, err := RenderSheetHTML(c.pkg)
		if err == nil {
			t.Errorf("%s: want error, got nil", c.name)
			continue
		}
		if c.want != nil && !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
}

func TestRenderSheetDirtyXMLBestEffort(t *testing.T) {
	// 局部损坏（截半标签）：预览语义优先于完整性，已抽取行照常返回
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/worksheets/first.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1"><v>ok</v></c></row><row r="2"><c r="A2"><v>broken`,
	}))
	if err != nil {
		t.Fatalf("dirty xml must degrade, got: %v", err)
	}
	if !strings.Contains(out, "<th>ok</th>") { // 单行 sheet：首行即表头
		t.Errorf("best-effort rows lost:\n%s", out)
	}
}

func TestRenderSheetEmpty(t *testing.T) {
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/worksheets/first.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"/><row r="2"><c r="A2"/></row></sheetData></worksheet>`,
	}))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(out, `<div class="doc-err"><p>empty</p></div>`) {
		t.Errorf("empty sheet should yield csv 同款空表卡:\n%s", out)
	}
}

func TestRenderSheetRowCap(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for i := 1; i <= 2100; i++ {
		b.WriteString(`<row r="` + strconv.Itoa(i) + `"><c r="A` + strconv.Itoa(i) + `"><v>` + strconv.Itoa(i) + `</v></c></row>`)
	}
	b.WriteString(`</sheetData></worksheet>`)
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/worksheets/first.xml":    b.String(),
	}))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	// csv 同款语义：截断 note 经 data-rows 由前端补双语（表头计一行，共 2000）
	if !strings.Contains(out, `data-rows="2000"`) {
		t.Errorf("row-cap note missing:\n...%s", tail(out, 300))
	}
	if strings.Contains(out, "<td>2001</td>") {
		t.Errorf("rows beyond cap leaked:\n...%s", tail(out, 300))
	}
	if !strings.Contains(out, "<td>2000</td>") {
		t.Errorf("cap-edge row lost:\n...%s", tail(out, 300))
	}
}

func TestRenderSheetColCapAndSparse(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	// A1 + KN1（0 基 299 ≥ 上限丢弃）+ C1：KN 不占位，稀疏补空只到 C
	b.WriteString(`<row r="1"><c r="A1"><v>a</v></c><c r="KN1"><v>far</v></c><c r="C1"><v>c</v></c></row>`)
	b.WriteString(`</sheetData></worksheet>`)
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/worksheets/first.xml":    b.String(),
	}))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(out, "<td>far</td>") {
		t.Errorf("column cap leaked:\n%s", out)
	}
	if got := strings.Count(out, "<th>"); got != 3 { // A + 1 补空 + C
		t.Errorf("sparse header cells = %d, want 3:\n%s", got, out)
	}
}

func TestRenderSheetCellTextCap(t *testing.T) {
	long := strings.Repeat("字", 200000) // 600KB UTF-8，超单格闸
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/worksheets/first.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1"><v>表头</v></c></row><row r="2"><c r="A2"><v>` + long + `</v></c></row></sheetData></worksheet>`,
	}))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(out, "…") {
		t.Errorf("cell cap missing ellipsis:\n...%s", tail(out, 200))
	}
	if got := strings.Count(out, "<td>"); got != 1 {
		t.Errorf("cell count = %d, want 1 (无截半标签):\n...%s", got, tail(out, 200))
	}
	if len(out) > officeHTMLMaxBytes+500 {
		t.Errorf("output over budget: %d bytes", len(out))
	}
}

func TestRenderSheetBudgetAtomic(t *testing.T) {
	// 大单元格多行挤爆 4MB 总闸：截断整行放弃（原子），标签必须配对
	cell := strings.Repeat("x", 100000) // 单格闸内（64KB 裁后）
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for i := 1; i <= 100; i++ {
		b.WriteString(`<row r="` + strconv.Itoa(i) + `"><c r="A` + strconv.Itoa(i) + `"><v>` + cell + `</v></c></row>`)
	}
	b.WriteString(`</sheetData></worksheet>`)
	out, err := RenderSheetHTML(buildXlsx(t, map[string]string{
		"xl/workbook.xml":            sheetWorkbookXML,
		"xl/_rels/workbook.xml.rels": sheetRelsXML,
		"xl/worksheets/first.xml":    b.String(),
	}))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if tr, etr := strings.Count(out, "<tr>"), strings.Count(out, "</tr>"); tr != etr {
		t.Errorf("unbalanced <tr>: %d vs %d", tr, etr)
	}
	if td, etd := strings.Count(out, "<td>"), strings.Count(out, "</td>"); td != etd {
		t.Errorf("unbalanced <td>: %d vs %d", td, etd)
	}
	if !strings.HasSuffix(out, "</div>") && !strings.HasSuffix(out, "></p>") {
		t.Errorf("output truncated mid-structure (表格或 note 收口):\n...%s", tail(out, 200))
	}
}

func TestResolveSheetTarget(t *testing.T) {
	cases := []struct{ target, want string }{
		{"worksheets/sheet1.xml", "xl/worksheets/sheet1.xml"},     // 相对 xl/ 基准
		{"/xl/worksheets/sheet1.xml", "xl/worksheets/sheet1.xml"}, // 包根绝对形态
		{"../sharedStrings.xml", "sharedStrings.xml"},             // xl/ 上一级 = 包根（合法 OPC）
		{"../../escape.xml", ""},                                  // 逃出包根
		{`worksheets\a.xml`, ""},                                  // 反斜杠
		{"a\x00b", ""},                                            // NUL
	}
	for _, c := range cases {
		if got := resolveSheetTarget(c.target); got != c.want {
			t.Errorf("resolveSheetTarget(%q) = %q, want %q", c.target, got, c.want)
		}
	}
}

func TestColIndexOf(t *testing.T) {
	cases := []struct {
		ref  string
		want int
	}{
		{"A1", 0}, {"Z1", 25}, {"AA1", 26}, {"BA1", 52}, {"IV1", 255},
		{"IW1", sheetMaxCols}, // 超上限列（必被丢弃区）
		{"a1", 0},             // 小写容错
		{"1", -1}, {"", -1},   // 畸形（顺位降级）
		{"A", 0},
	}
	for _, c := range cases {
		if got := colIndexOf(c.ref); got != c.want {
			t.Errorf("colIndexOf(%q) = %d, want %d", c.ref, got, c.want)
		}
	}
}

// tail 取字符串尾部（大输出断言提示用）
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
