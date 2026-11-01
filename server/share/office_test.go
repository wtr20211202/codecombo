package share

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

// buildDocx 构造最小 docx 包（zip + word/document.xml）。
// 内容含标题/列表/粗体/XSS 探针/表格，覆盖解析器的主要映射分支
func buildDocx(t *testing.T, documentXML string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(documentXML)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const sampleDocXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>部署指南</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>必须</w:t></w:r><w:r><w:t>先建目录 &lt; 不是注入 &gt;</w:t><w:t>second run</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>键</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>port</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>9999</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:sectPr/>
</w:body>
</w:document>`

func TestRenderDocxHTML(t *testing.T) {
	out, err := renderDocHTML(buildDocx(t, sampleDocXML))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		"<h1>部署指南</h1>",
		"<strong>必须</strong>",
		"<li>第一项</li>", "<li>第二项</li>", "<ul>",
		"<table>", "<tr>", "<td>port</td>", "<td>9999</td>",
		"second run", // 同段落多 run 顺序拼接
	} {
		if !strings.Contains(out, want) {
			t.Errorf("docx html missing %q in:\n%s", want, out)
		}
	}
	// 注入面：文本必须转义，绝不允许出现可执行的原始标记
	if strings.Contains(out, "<script>") || strings.Contains(out, "不是注入 &gt;") == false {
		t.Errorf("escaping broken:\n%s", out)
	}
	if strings.Contains(out, "不是注入 <") && !strings.Contains(out, "先建目录 &lt; 不是注入 &gt;") {
		t.Errorf("raw < leaked:\n%s", out)
	}
}

func TestRenderDocxXSSProbe(t *testing.T) {
	// 文档文本里藏脚本：解析输出必须只出现转义后的形态
	xml := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t><![CDATA[<script>alert(1)</script>]]></w:t></w:r></w:p></w:body></w:document>`
	out, err := renderDocHTML(buildDocx(t, xml))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(out, "<script>alert") {
		t.Fatalf("script tag survived: %s", out)
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("escaped form missing: %s", out)
	}
}

func TestRenderDocLegacyGarbageFails(t *testing.T) {
	// 非 zip 非 OLE 的垃圾字节：解析报错（上层降级为错误卡）
	if _, err := renderDocHTML([]byte("this is not a document")); err == nil {
		t.Fatal("garbage .doc should fail parsing")
	}
}

func TestRenderDocxRenamedAsDoc(t *testing.T) {
	// .doc 扩展名但内容是 zip（改名场景）：按 docx 解析成功
	out, err := renderDocHTML(buildDocx(t, sampleDocXML))
	if err != nil {
		t.Fatalf("zip-sniffed docx failed: %v", err)
	}
	if !strings.Contains(out, "<h1>") {
		t.Fatalf("unexpected output: %s", out)
	}
}

func TestDocxHeadingLevels(t *testing.T) {
	cases := map[string]int{
		"Title": 1, "title": 1, "Subtitle": 2,
		"Heading1": 1, "heading3": 3, "Heading9": 9,
		"Normal": 0, "": 0, "Heading": 0, "HeadingX": 0,
	}
	for style, want := range cases {
		if got := headingLevel(style); got != want {
			t.Errorf("headingLevel(%q) = %d, want %d", style, got, want)
		}
	}
}
