package share

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"html"
	"io"
	"strings"

	"github.com/EndFirstCorp/doc2txt"
)

// Word 文档（docx/doc）→ HTML 片段的抽取边界：
// 目标是"文本级排版预览"（标题/段落/列表/表格/粗斜体），不做样式与图片
// 还原——那些交给下载。docx 用 stdlib zip+xml 流式解析（零新依赖）；
// doc 老格式经 doc2txt best-effort 抽纯文本（OLE 复合文档解析失败时
// 上层降级为错误卡 + 下载）。所有文本经 html.EscapeString 转义后才进
// 输出，输出结构完全由本文件生成——注入面为零。

const (
	// docxZipMaxBytes document.xml 解压侧上限（防 zip 炸弹）
	docxZipMaxBytes = 64 << 20
	// officeHTMLMaxBytes 生成 HTML 的字节上限
	officeHTMLMaxBytes = 4 << 20
)

// isDocx 嗅探 zip 魔数（部分 .doc 实为 docx 改名）
func isDocx(b []byte) bool { return len(b) > 1 && b[0] == 'P' && b[1] == 'K' }

// renderDocHTML Word 文档入口：按魔数分流 docx/doc，失败返回错误
func renderDocHTML(content []byte) (string, error) {
	if isDocx(content) {
		return renderDocxHTML(content)
	}
	return renderLegacyDocHTML(content)
}

// renderLegacyDocHTML 老 .doc（OLE 复合文档）best-effort 抽纯文本
func renderLegacyDocHTML(content []byte) (string, error) {
	text, err := doc2txt.ParseDoc(bytes.NewReader(content))
	if err != nil {
		return "", err
	}
	raw, err := io.ReadAll(text)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString(`<div class="sc-doc-text">`)
	writeEscapedParagraphs(&b, string(raw))
	return b.String(), nil
}

// renderDocxHTML 解析 word/document.xml 抽文本结构
func renderDocxHTML(content []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", err
	}
	var docXML *zip.File
	for _, f := range zr.File {
		if f.Name == "word/document.xml" {
			docXML = f
			break
		}
	}
	if docXML == nil {
		return "", errDocxNoDocument
	}
	rc, err := docXML.Open()
	if err != nil {
		return "", err
	}
	defer rc.Close()

	p := newDocxBuilder()
	if err := p.parse(io.LimitReader(rc, docxZipMaxBytes)); err != nil {
		return "", err
	}
	return p.html(), nil
}

// errDocxNoDocument docx 包内缺主文档部件
var errDocxNoDocument = errors.New("share: word/document.xml not found")

// ── docx 流式解析 ──
// 事件模型（只关心呈现所需的最小子集）：
//   w:p 段落（pPr/pStyle 判标题、pPr/numPr 判列表项；w:br/w:tab 换行缩进）
//   w:tbl 表格（w:tr 行 / w:tc 单元格，单元格内段落只保内容）
//   w:r 内 w:t 文本、w:b/w:i 粗斜体

type docxBuilder struct {
	b strings.Builder

	para      strings.Builder // 当前段落累积
	inP       bool
	inT       bool // 当前位于 w:t 文本内
	inCell    bool
	inList    bool // 当前段落带 numPr
	listOpen  bool
	tableOpen bool
	styleID   string
	bold      bool
	italic    bool

	outLen int
}

func newDocxBuilder() *docxBuilder { return &docxBuilder{} }

func (p *docxBuilder) write(s string) {
	if p.outLen >= officeHTMLMaxBytes {
		return
	}
	p.b.WriteString(s)
	p.outLen += len(s)
}

// parse 流式消费 document.xml。XML 局部损坏时返回已抽取内容
//（预览语义优先于完整性）
func (p *docxBuilder) parse(r io.Reader) error {
	dec := xml.NewDecoder(r)
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil
		}
		switch t := tok.(type) {
		case xml.StartElement:
			p.start(t)
		case xml.EndElement:
			p.end(t.Name.Local)
		case xml.CharData:
			if p.inT {
				p.charData(string(t))
			}
		}
	}
	p.flushParagraph()
	p.closeList()
	p.closeTable()
	return nil
}

func (p *docxBuilder) start(t xml.StartElement) {
	switch t.Name.Local {
	case "p":
		p.flushParagraph()
		p.inP = true
		p.styleID = ""
	case "tbl":
		p.flushParagraph()
		p.closeList()
		p.tableOpen = true
		p.write("<table>")
	case "tr":
		p.write("<tr>")
	case "tc":
		p.inCell = true
		p.write("<td>")
	case "pStyle":
		p.styleID = attrVal(t)
	case "numPr":
		p.inList = true
	case "r":
		// 新运行：重置上一运行的粗斜体。w:b/w:i 是自闭合属性标记，
		// 只能在 run 边界复位——靠自身的 EndElement 复位会在文本
		// 到达前就被清掉
		p.bold = false
		p.italic = false
	case "b":
		p.bold = flagOn(t)
	case "i":
		p.italic = flagOn(t)
	case "br":
		if p.inP {
			p.para.WriteString("<br>")
		}
	case "tab":
		if p.inP {
			p.para.WriteString("  ")
		}
	case "t":
		p.inT = true
	}
}

func (p *docxBuilder) end(name string) {
	switch name {
	case "p":
		p.flushParagraph()
	case "tbl":
		p.closeTable()
	case "tr":
		p.write("</tr>")
	case "tc":
		p.flushParagraph()
		p.write("</td>")
		p.inCell = false
	case "t":
		p.inT = false
	}
}

// charData 累积 w:t 文本（转义在此处完成）
func (p *docxBuilder) charData(text string) {
	seg := html.EscapeString(text)
	if p.bold {
		seg = "<strong>" + seg + "</strong>"
	}
	if p.italic {
		seg = "<em>" + seg + "</em>"
	}
	p.para.WriteString(seg)
}

// flushParagraph 段落收口：按样式/列表语境映射为 h1-h6/li/p
func (p *docxBuilder) flushParagraph() {
	body := p.para.String()
	p.para.Reset()
	p.inP = false
	p.inT = false
	if p.inCell {
		// 单元格内段落不套 p（td 已有盒模型），仅保内容
		p.write(body)
		return
	}
	trimmed := strings.TrimSpace(strings.ReplaceAll(body, "<br>", ""))
	if trimmed == "" {
		p.closeList()
		return
	}

	level := headingLevel(p.styleID)
	switch {
	case level > 0:
		p.closeList()
		if level > 6 {
			level = 6
		}
		p.write("<h" + digit(level) + ">" + body + "</h" + digit(level) + ">")
	case p.inList:
		if !p.listOpen {
			p.write("<ul>")
			p.listOpen = true
		}
		p.write("<li>" + body + "</li>")
	default:
		p.closeList()
		p.write("<p>" + body + "</p>")
	}
	p.inList = false
}

func (p *docxBuilder) closeList() {
	if p.listOpen {
		p.write("</ul>")
		p.listOpen = false
	}
}

func (p *docxBuilder) closeTable() {
	if p.tableOpen {
		p.write("</table>")
		p.tableOpen = false
	}
}

func (p *docxBuilder) html() string { return p.b.String() }

// attrVal 取 w:val 属性（命名空间 URI 不统一，按 local name 匹配）
func attrVal(t xml.StartElement) string {
	for _, a := range t.Attr {
		if a.Name.Local == "val" {
			return a.Value
		}
	}
	return ""
}

// flagOn 布尔属性语义：无 val = 开（<w:b/>）；val="0"/"false"/"off" = 关
func flagOn(t xml.StartElement) bool {
	switch strings.ToLower(attrVal(t)) {
	case "0", "false", "off":
		return false
	}
	return true
}

// headingLevel 样式 ID → 标题级别（Title/Subtitle/Heading1..9；docx 模板
// 的样式 ID 与界面语言无关，中文模板同样使用这些英文 ID）
func headingLevel(styleID string) int {
	s := strings.ToLower(styleID)
	switch {
	case s == "title":
		return 1
	case s == "subtitle":
		return 2
	case len(s) > 7 && strings.HasPrefix(s, "heading"):
		if n := atoi(s[7:]); n > 0 {
			return clamp(n, 1, 9)
		}
	}
	return 0
}

func clamp(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func digit(n int) string { return string(rune('0' + n)) }

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// writeEscapedParagraphs 纯文本按行分段输出（doc 老格式抽取路径）
func writeEscapedParagraphs(b *strings.Builder, text string) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	for _, para := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(para)
		if trimmed == "" {
			continue
		}
		b.WriteString("<p>" + html.EscapeString(trimmed) + "</p>")
	}
	b.WriteString("</div>")
}
