package filepreview

import (
	"fmt"
	"html"
	"net/http/httptest"
	"strings"
	"testing"

	fx "codecombo/server/filepreview/fixtures"
)

// docxTestToken/docxTestPath 渲染侧单测的端点 URL 构造参数（合法形态 token +
// 分享根内路径；emitImage 用它产 docx-media 端点 URL）
var (
	docxTestToken = "0123456789abcdef"
	docxTestPath  = "report.docx"
)

// docxMediaURL/docxEmbedURL 渲染面单测的 URL 断言落字（/s/{token} 端点
// 形态，与 share 侧包装同构——唯一实现为本包 DocxMediaURL/DocxEmbedURL）
func docxMediaURL(token, docPath, media string) string {
	return DocxMediaURL("/s/"+token+"/docx-media", docPath, media)
}

func docxEmbedURL(token, docPath, entry string) string {
	return DocxEmbedURL("/s/"+token+"/docx-embed", docPath, entry)
}

// docxRender 按 P-20261116-6 端点供给形态调 RenderDocHTML（测试集中走
// 同一组线程化参数，期望 URL 断言才有单一事实源）
// docxTestURLs 渲染侧单测的端点 URL 构造器（share 侧 /s/{token} 形态的
// 等价落字——断言串含完整 URL 时与 docxMediaURL/docxEmbedURL 局部别名同源）
var docxTestURLs = &MediaURLs{
	Media: func(m string) string { return docxMediaURL(docxTestToken, docxTestPath, m) },
	Embed: func(e string) string { return docxEmbedURL(docxTestToken, docxTestPath, e) },
}

func docxRender(t *testing.T, pkg []byte, lang string) string {
	t.Helper()
	out, err := RenderDocHTML(pkg, lang, docxTestURLs)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return out
}

// docxMediaSrcAttr 期望的 img src 属性形态（端点供给口径）：path=/m=
// 查询值经 url.QueryEscape，src 属性值再经 html.EscapeString（& → &amp;）
func docxMediaSrcAttr(entry string) string {
	return `<img src="` + html.EscapeString(docxMediaURL(docxTestToken, docxTestPath, entry)) + `"`
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
	out := docxRender(t, fx.BuildDocx(t, sampleDocXML), "en")
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

func TestRenderDocxImageInline(t *testing.T) {
	rels := fx.RelsShell +
		fx.ImgRel("rId1", "media/image1.png") +
		fx.ImgRel("rId2", "media/image1.png") + // 同目标多 rId（同一部件 → 同一端点 URL）
		fx.ImgRel("rId3", "/word/media/image1.png") // OPC 包根绝对形态
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rId1") + fx.BlipXML("rId2") + fx.BlipXML("rId3") +
		`</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/image1.png": fx.PNGTestBytes,
	}), "en")
	// P-20261116-6 端点供给形态：src 是同源 docx-media URL（图片字节不进
	// HTML）；三个 rId（含绝对 Target 归一）落同一部件名 → 同一 URL，
	// 线上格式钉死（path=/m= 经 QueryEscape、src 属性 & 转义 &amp;）
	wantImg := docxMediaSrcAttr("word/media/image1.png") + ` alt="image1.png">`
	if n := strings.Count(out, wantImg); n != 3 {
		t.Fatalf("want 3 identical endpoint-src imgs (multi-rId + abs-target), got %d:\n%.300s", n, out)
	}
	if strings.Contains(out, "data:") {
		t.Fatalf("images must stream from the endpoint, not inline data: URLs:\n%.200s", out)
	}
	if !strings.Contains(out, "/s/0123456789abcdef/docx-media?path=report.docx&amp;m=word%2Fmedia%2Fimage1.png") {
		t.Fatalf("wire form drifted:\n%.300s", out)
	}
}

func TestRenderDocxJpegEndpointSupply(t *testing.T) {
	// JPEG 端到端用例迁端点供给口径（P-20261116-4-S2 原钉 data:image/jpeg
	// 内联形态）：渲染侧照常产端点 src，JPEG 字节绝不进 HTML——实字节
	// 供给由端点用例覆盖（service_test TestDocxMediaEndpoint）
	jpeg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, []byte("fake-jpeg-payload")...)
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/photo.jpg")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rId1") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/photo.jpg": jpeg,
	}), "en")
	if want := docxMediaSrcAttr("word/media/photo.jpg") + ` alt="photo.jpg">`; !strings.Contains(out, want) {
		t.Fatalf("jpeg must reference the endpoint src:\n%.300s", out)
	}
	if strings.Contains(out, "data:image/jpeg") || strings.Contains(out, "fake-jpeg-payload") {
		t.Fatalf("jpeg bytes must not enter the HTML:\n%.300s", out)
	}
}

func TestRenderDocxDanglingAndIgnoredRels(t *testing.T) {
	rels := fx.RelsShell +
		fx.ImgRel("rIdOK", "media/pic.png") +
		fx.ImgRel("rIdUp", "../outside/evil.png") + // 越界（逃出 word/media）
		`<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://example.com/x.png" TargetMode="External"/>` +
		fx.ImgRel("rIdDangling", "media/missing.png") + // zip 内不存在
		`<Relationship Id="rIdOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/>`
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rIdOK") + fx.BlipXML("rIdUp") + fx.BlipXML("rIdExt") + fx.BlipXML("rIdDangling") + fx.BlipXML("rIdOle") +
		`</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/pic.png":    fx.PNGTestBytes,
		"word/outside/evil.png": fx.PNGTestBytes, // 包内存在但越界：仍不可达
	}), "en")
	if n := strings.Count(out, "<img"); n != 1 {
		t.Fatalf("want exactly 1 endpoint-src img, got %d:\n%s", n, out)
	}
	// 越界条目绝不产端点 URL（哪怕包内存在）；四个未命中 rId 全占位
	if n := strings.Count(out, "doc-img-missing"); n != 4 {
		t.Fatalf("want 4 placeholders (up/ext/dangling/ole), got %d:\n%s", n, out)
	}
	if !strings.Contains(out, "evil.png") || !strings.Contains(out, "missing.png") {
		t.Fatalf("placeholders should name unresolved targets:\n%s", out)
	}
	if !strings.Contains(out, docxMediaSrcAttr("word/media/pic.png")) {
		t.Fatalf("the only valid rel must reference the endpoint:\n%s", out)
	}
	if strings.Contains(out, "data:") {
		t.Fatalf("no data: URLs in endpoint-supply form:\n%s", out)
	}
}

func TestRenderDocxAlternateContentDedup(t *testing.T) {
	// 兼容模式文档：同图同文本同时写进 mc:Choice（w:drawing）与
	// mc:Fallback（w:pict）——Choice 中选，Fallback 整棵抑制
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/once.png")
	choice := strings.Replace(fx.BlipXML("rId1"), "<w:p>", "<w:p><w:r><w:t>ChoiceText</w:t></w:r>", 1)
	fallback := strings.Replace(fx.PictXML("rId1"), "<w:pict>", "<w:t>FallbackText</w:t><w:pict>", 1)
	ac := `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
		`<mc:Choice Requires="wps">` + choice + `</mc:Choice>` +
		`<mc:Fallback>` + fallback + `</mc:Fallback>` +
		`</mc:AlternateContent></w:r></w:p>`
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + ac + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/once.png": fx.PNGTestBytes,
	}), "en")
	if n := strings.Count(out, "<img"); n != 1 {
		t.Fatalf("AlternateContent dedup broken: want 1 img, got %d:\n%s", n, out)
	}
	if !strings.Contains(out, "ChoiceText") {
		t.Fatalf("Choice content lost:\n%s", out)
	}
	if strings.Contains(out, "FallbackText") {
		t.Fatalf("Fallback content leaked alongside Choice:\n%s", out)
	}
}

func TestRenderDocxPictFallbackWithoutChoice(t *testing.T) {
	// AC 只有 Fallback（无 Choice）：Fallback 正常渲染（不误伤）
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/p.png")
	ac := `<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
		`<mc:Fallback>` + fx.PictXML("rId1") + `</mc:Fallback>` +
		`</mc:AlternateContent></w:r></w:p>`
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` + ac + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/p.png": fx.PNGTestBytes,
	}), "en")
	if strings.Count(out, "<img") != 1 {
		t.Fatalf("standalone Fallback pict should render:\n%s", out)
	}
}

func TestRenderDocxPictLegacy(t *testing.T) {
	// 老形态 w:pict/v:imagedata（无 AC 包裹）直出（端点供给 src 形态）
	rels := fx.RelsShell + fx.ImgRel("rId9", "media/old.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.PictXML("rId9") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/old.png": fx.PNGTestBytes,
	}), "en")
	if !strings.Contains(out, docxMediaSrcAttr("word/media/old.png")) {
		t.Fatalf("legacy pict not rendered:\n%s", out)
	}
}

func TestRenderDocxNoRels(t *testing.T) {
	// 无 rels 部件：文本正常，blip 全部占位（不 panic）
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		`<w:p><w:r><w:t>正文</w:t></w:r></w:p>` + fx.BlipXML("rIdX") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocx(t, doc), "en")
	if !strings.Contains(out, "<p>正文</p>") || strings.Count(out, "doc-img-missing") != 1 {
		t.Fatalf("no-rels doc broken:\n%s", out)
	}
}

func TestRenderDocxRelsCorrupt(t *testing.T) {
	// rels 损坏容错：截断 XML → 映射为空，文本预览不受影响
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		`<w:p><w:r><w:t>仍然可读</w:t></w:r></w:p>` + fx.BlipXML("rId1") + `</w:body></w:document>`
	rels := fx.RelsShell + `<Relationship Id="rId1" Typ` // 半截
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/a.png": fx.PNGTestBytes,
	}), "en")
	if !strings.Contains(out, "<p>仍然可读</p>") || strings.Count(out, "doc-img-missing") != 1 {
		t.Fatalf("corrupt rels should degrade to placeholders, not fail:\n%s", out)
	}
}

func TestRenderDocxNonImageBytesDeferToEndpoint(t *testing.T) {
	// media 条目伪装（非图字节）迁端点供给口径（P-20261116-6）：渲染侧
	// 不再嗅探/解压字节——映射命中照常产端点 src，伪装条目由端点侧魔数
	// 嗅探 404（见 service_test 端点用例）；伪装字节本身绝不进 HTML
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/fake.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rId1") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/fake.png": []byte("<script>alert(1)</script>"),
	}), "en")
	if strings.Contains(out, "data:") || strings.Contains(out, "<script>") {
		t.Fatalf("non-image bytes must never enter the HTML:\n%s", out)
	}
	if !strings.Contains(out, docxMediaSrcAttr("word/media/fake.png")) {
		t.Fatalf("mapped media should reference the endpoint (sniff deferred):\n%s", out)
	}
}

func TestRenderDocxImgAltEscaped(t *testing.T) {
	// zip 内媒体名藏注入载荷：alt 必须转义（rels Target 经 &quot; 等实体
	// 携带）；P-20261116-6 起该名字还进 m= 查询值——QueryEscape 的 %XX
	// 形态同样不得在 HTML 属性边界破口
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/a&quot;&gt;&lt;script&gt;b.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rId1") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		`word/media/a"><script>b.png`: fx.PNGTestBytes,
	}), "en")
	if strings.Contains(out, "<script>") {
		t.Fatalf("media name injection survived:\n%s", out)
	}
	if !strings.Contains(out, `alt="a&#34;&gt;&lt;script&gt;b.png"`) {
		t.Fatalf("alt escaping broken:\n%.300s", out)
	}
	if !strings.Contains(out, "m=word%2Fmedia%2Fa%22%3E%3Cscript%3Eb.png") {
		t.Fatalf("media name must be query-escaped in src:\n%.300s", out)
	}
}

func TestRenderDocxImageOnlyParagraph(t *testing.T) {
	// 纯图段（无文本）：段落不可被空段裁剪逻辑吞掉
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/solo.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		`<w:p><w:r><w:t>前段</w:t></w:r></w:p>` + fx.BlipXML("rId1") +
		`<w:p><w:r><w:t>后段</w:t></w:r></w:p></w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/solo.png": fx.PNGTestBytes,
	}), "en")
	if strings.Count(out, "<img") != 1 || !strings.Contains(out, "<p>前段</p>") || !strings.Contains(out, "<p>后段</p>") {
		t.Fatalf("image-only paragraph lost:\n%s", out)
	}
}

func TestRenderDocxPlaceholderI18n(t *testing.T) {
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/x.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rId1") + `</w:body></w:document>`
	pkg := fx.BuildDocxFull(t, doc, rels, nil)
	zh := docxRender(t, pkg, "zh")
	if !strings.Contains(zh, "图片未随预览内嵌，下载文档可见") {
		t.Fatalf("zh placeholder text missing:\n%s", zh)
	}
	en := docxRender(t, pkg, "en")
	if !strings.Contains(en, "Download the document to view it") {
		t.Fatalf("en placeholder text missing:\n%s", en)
	}
}

func TestRenderDocxBudgetExhaustedAtomically(t *testing.T) {
	// 纯文本结构闸口径（P-20261116-6：图片字节不进 HTML，img 只占端点
	// URL 的 ~150B 常数体积，预算不可能被图片耗尽——图片预算闸随 data:
	// 内联形态拆除，正确解法正是本切换）：大段文本把预算推到闸值附近，
	// 再用海量小段把残量耗尽——残量耗尽后 img 标签（即便只有 ~150B）与
	// 占位块同受原子发射约束整块放弃，无截半标签
	rels := fx.RelsShell + fx.ImgRel("rId1", "media/late.png")
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`)
	for i := 0; i < 130; i++ { // 130 × 120KB 原始文本，渲染闸裁到 64KB/段
		sb.WriteString(`<w:p><w:r><w:t>` + strings.Repeat("字", 40_000) + `</w:t></w:r></w:p>`)
	}
	for i := 0; i < 9000; i++ { // 小段把剩余残量爬耗尽（每段 ~9-12 字节）
		sb.WriteString(`<w:p><w:r><w:t>a</w:t></w:r></w:p>`)
	}
	sb.WriteString(fx.BlipXML("rId1"))
	sb.WriteString(`</w:body></w:document>`)
	out := docxRender(t, fx.BuildDocxFull(t, sb.String(), rels, map[string][]byte{
		"word/media/late.png": fx.PNGTestBytes,
	}), "en")
	if len(out) > officeHTMLMaxBytes+docxParaMaxBytes {
		t.Fatalf("output must respect the text budget: got %d bytes", len(out))
	}
	if strings.Contains(out, "<img") || strings.Contains(out, "data:") {
		t.Fatalf("image tag must be dropped after budget exhaustion:\n%.200s", out)
	}
	if strings.Contains(out, "doc-img-missing") {
		t.Fatalf("placeholder must be dropped too when remaining ~0:\n%.200s", out)
	}
	if !strings.Contains(out, "…") {
		t.Fatalf("budget truncation indicator missing:\n%.200s", out)
	}
	if !strings.HasSuffix(out, "</p>") {
		t.Fatalf("output must end with a complete tag (no half-cut):\n%s", out[len(out)-80:])
	}
}

func TestDocxParaAccumulationGate(t *testing.T) {
	// 潜伏点回归：超长单段（1MB 文本）不再无界累积——按 rune 边界截断
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		`<w:p><w:r><w:t>` + strings.Repeat("汉", 1_000_000) + `</w:t></w:r></w:p></w:body></w:document>`
	out := docxRender(t, fx.BuildDocx(t, doc), "en")
	// 64KB 文本闸 + 段标签 + 截断指示，远小于原始 1MB
	if len(out) > docxParaMaxBytes+4096 {
		t.Fatalf("single paragraph unbounded: got %d bytes", len(out))
	}
	if !strings.Contains(out, "…") {
		t.Fatalf("truncation indicator missing:\n%.200s", out)
	}
	if !strings.HasPrefix(out, "<p>") || !strings.HasSuffix(out, "</p>") {
		t.Fatalf("paragraph tags broken:\n%.100s", out)
	}
}

// per-media 解压闸已迁 docx-media 端点侧（P-20261116-6，原
// TestDocxMediaPerPartAndTotalGates：超大拒收见 service_test
// TestDocxMediaOversizeAndSniff；累计闸 docxMediaTotalMaxBytes 随渲染侧
// 解压链拆除——「图片预算不要限制太小」的正解是不把图片字节塞进 HTML）

func TestRenderDocxXSSProbe(t *testing.T) {
	// 文档文本里藏脚本：解析输出必须只出现转义后的形态
	xml := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t><![CDATA[<script>alert(1)</script>]]></w:t></w:r></w:p></w:body></w:document>`
	out := docxRender(t, fx.BuildDocx(t, xml), "en")
	if strings.Contains(out, "<script>alert") {
		t.Fatalf("script tag survived: %s", out)
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("escaped form missing: %s", out)
	}
}

func TestRenderDocLegacyGarbageFails(t *testing.T) {
	// 非 zip 非 OLE 的垃圾字节：解析报错（上层降级为错误卡）
	if _, err := RenderDocHTML([]byte("this is not a document"), "en", docxTestURLs); err == nil {
		t.Fatal("garbage .doc should fail parsing")
	}
}

func TestRenderDocxRenamedAsDoc(t *testing.T) {
	// .doc 扩展名但内容是 zip（改名场景）：按 docx 解析成功
	out := docxRender(t, fx.BuildDocx(t, sampleDocXML), "en")
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

func TestSniffImageMime(t *testing.T) {
	cases := []struct {
		name string
		b    []byte
		want string
	}{
		{"png", append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0x00), "image/png"},
		{"jpeg", []byte{0xFF, 0xD8, 0xFF, 0xE0}, "image/jpeg"},
		{"gif87a", []byte("GIF87a-x"), "image/gif"},
		{"gif89a", []byte("GIF89a-x"), "image/gif"},
		{"webp", []byte("RIFF....WEBPVP8 "), "image/webp"},
		{"bmp", []byte{'B', 'M', 0x00, 0x00}, "image/bmp"},
		{"text", []byte("hello world"), ""},
		{"svg-text", []byte("<svg xmlns="), ""},
		{"empty", nil, ""},
		{"short-png-magic", []byte{0x89, 'P', 'N', 'G'}, ""},
	}
	for _, c := range cases {
		if got := SniffImageMime(c.b); got != c.want {
			t.Errorf("SniffImageMime(%s) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestResolveMediaTarget(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"media/image1.png", "word/media/image1.png"},       // 相对 word/ 基准
		{"../media/image1.png", ""},                         // 解析到包根 media/（逃出 word/）
		{"/word/media/image1.png", "word/media/image1.png"}, // OPC 包根绝对形态
		{"../outside/evil.png", ""},                         // 逃出 word/media
		{"media/../../etc/passwd", ""},                      // 越界
		{"..\\media\\evil.png", ""},                         // 反斜杠
		{"http://example.com/x.png", ""},                    // 外部 URL（另有 TargetMode 过滤）
		{"media/", ""},                                      // 空条目
		{"embeddings/oleObject1.bin", ""},                   // 非 media 形态
		{"media/../media/x.png", "word/media/x.png"},        // 归一化
	}
	for _, c := range cases {
		if got := resolveMediaTarget(c.in); got != c.want {
			t.Errorf("resolveMediaTarget(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ---- docx 嵌入对象（附件）可见化（P-20261116-7） ----

func TestRenderDocxEmbedBothForms(t *testing.T) {
	rels := fx.RelsShell +
		fx.ImgRel("rIcon1", "media/image1.png") +
		fx.EmbedRel("rEmb1", "oleObject", "embeddings/oleObject1.bin") +
		fx.EmbedRel("rEmb2", "package", "/word/embeddings/attached.html") + // OPC 包根绝对形态
		fx.ImgRel("rIcon2", "media/image2.png")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("rIcon1", "rEmb1", "Package") +
		fx.ObjectXML("rIcon2", "rEmb2", "Package") +
		`</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/image1.png":          fx.PNGTestBytes,
		"word/media/image2.png":          fx.PNGTestBytes,
		"word/embeddings/oleObject1.bin": []byte("ole container"),
		"word/embeddings/attached.html":  []byte("<html>需求文档</html>"),
	}), "zh")
	// 抽名失败块：单链接形态（条目名 .bin + ProgID 唯一身份 + 大小 + 双语文案）
	want1 := `<a class="doc-embed" href="` + html.EscapeString(docxEmbedURL(docxTestToken, docxTestPath, "word/embeddings/oleObject1.bin")) + `">📎 oleObject1.bin · Package · 13B · 嵌入文件，可下载</a>`
	if !strings.Contains(out, want1) {
		t.Fatalf("oleObject form block missing:\n%s", out)
	}
	// 可预览块：单行 span 双动作（预览新标签=壳页 &ui=1 + 下载），零 data 标记
	dl2 := docxEmbedURL(docxTestToken, docxTestPath, "word/embeddings/attached.html")
	pv2 := dl2 + "&ui=1"
	want2 := `<span class="doc-embed"><span class="doc-embed-name">📎 attached.html · 25B</span>` +
		`<span class="doc-embed-acts"><a href="` + html.EscapeString(pv2) +
		`" target="_blank" rel="noopener">预览</a> · <a href="` + html.EscapeString(dl2) +
		`" data-embed-dl="1">下载</a></span></span>`
	if !strings.Contains(out, want2) {
		t.Fatalf("package form block missing:\n%s", out)
	}
	// ProgID 语义（必改④）：抽名失败的 .bin 块显 Package；可预览块不显
	//（还原名扩展名承载类型）
	if n := strings.Count(out, "Package"); n != 1 {
		t.Fatalf("ProgID must show only on the un-extracted block, got %d:\n%s", n, out)
	}
	if n := strings.Count(out, `class="doc-embed"`); n != 2 {
		t.Fatalf("want exactly 2 embed blocks, got %d:\n%s", n, out)
	}
	// PNG 图标不回归：两个图标 img 照常发射（端点 src 形态）
	if n := strings.Count(out, "<img"); n != 2 {
		t.Fatalf("png icons must keep rendering, got %d imgs:\n%s", n, out)
	}
	// 文档序锁定：图标在前、嵌入块在后（同段内先 img 后 a）
	i1 := strings.Index(out, docxMediaSrcAttr("word/media/image1.png"))
	e1 := strings.Index(out, want1)
	if i1 < 0 || e1 < 0 || i1 > e1 {
		t.Fatalf("icon must precede embed block:\n%s", out)
	}
}

// TestRenderDocxEmbedDanglingAndNoRID 悬空 rId → 无链接诚实占位（可从
// 名字/ProgID 报得出）；o:OLEObject 无 r:id → 静默跳过不产出任何块
func TestRenderDocxEmbedDanglingAndNoRID(t *testing.T) {
	rels := fx.RelsShell +
		fx.EmbedRel("rEmbOK", "oleObject", "embeddings/gone.bin") + // zip 内不存在
		fx.EmbedRel("rEmbExt", "package", "https://example.com/x.html") // 外部形态（同语义）
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("", "rEmbOK", "Package") +
		fx.ObjectXML("", "rEmbExt", "Package") +
		fx.ObjectXML("", "", "Package") + // 无 r:id：死引用
		`</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, nil), "en")
	// 无 docx-embed 链接（越权面为零）；两个可报名的占位 + 一个静默跳过
	if strings.Contains(out, "docx-embed") {
		t.Fatalf("dangling/external embeds must not produce endpoint links:\n%s", out)
	}
	if n := strings.Count(out, "doc-img-missing"); n != 2 {
		t.Fatalf("want 2 no-link placeholders (dangling/external), got %d:\n%s", n, out)
	}
	if !strings.Contains(out, "gone.bin") || !strings.Contains(out, "x.html") {
		t.Fatalf("placeholders should name the referenced targets:\n%s", out)
	}
	if strings.Count(out, "📎") != 2 {
		t.Fatalf("r:id-less OLEObject must be silently skipped:\n%s", out)
	}
}

// TestRenderDocxEmbedTargetModeExternal TargetMode=External 过滤（评审必改③
// 的 embed 通道版）：OLE Link 型外链关系不入簿，落无链接占位
func TestRenderDocxEmbedTargetModeExternal(t *testing.T) {
	rels := fx.RelsShell +
		`<Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="file:///C:/tmp/data.csv" TargetMode="External"/>`
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("", "rLink", "Excel.Sheet.12") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, nil), "en")
	if strings.Contains(out, "docx-embed") {
		t.Fatalf("external link must not produce endpoint URL:\n%s", out)
	}
	if !strings.Contains(out, "data.csv") || !strings.Contains(out, "embedded file cannot be fetched") {
		t.Fatalf("no-link placeholder missing:\n%s", out)
	}
}

// TestRenderDocxMetafileIconMerge 同 w:object 内 EMF 图标+嵌入块合并为单块
// （评审建议①：避免破图占位+嵌入占位双块堆叠——用户实测主诉的形态）
func TestRenderDocxMetafileIconMerge(t *testing.T) {
	rels := fx.RelsShell +
		fx.ImgRel("rIcon", "media/image8.emf") +
		fx.EmbedRel("rEmb", "oleObject", "embeddings/oleObject2.bin")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("rIcon", "rEmb", "Package") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/image8.emf":          []byte{0x01, 0x00, 0x00, 0x00, 'e', 'm', 'f'},
		"word/embeddings/oleObject2.bin": []byte("ole container"),
	}), "en")
	if strings.Count(out, "<img") != 0 {
		t.Fatalf("metafile icon must not emit a doomed img:\n%s", out)
	}
	if strings.Count(out, "doc-img-missing") != 0 {
		t.Fatalf("metafile icon must merge into the embed block, not stack:\n%s", out)
	}
	if n := strings.Count(out, "doc-embed"); n != 1 {
		t.Fatalf("want exactly 1 merged embed block, got %d:\n%s", n, out)
	}
}

// TestRenderDocxMetafileIconWithoutEmbed object 内图元图标但无 o:OLEObject
// （部分生成器把普通 VML 图也包进 w:object）：</object> 收口时补发图元占位
func TestRenderDocxMetafileIconWithoutEmbed(t *testing.T) {
	rels := fx.RelsShell + fx.ImgRel("rIcon", "media/pic.wmf")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("rIcon", "", "") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/pic.wmf": []byte{0xD7, 0xCD, 0xC6, 0x9A},
	}), "zh")
	if strings.Count(out, "<img") != 0 || strings.Count(out, "doc-embed") != 0 {
		t.Fatalf("no doomed img and no embed link expected:\n%s", out)
	}
	if !strings.Contains(out, "doc-img-missing") || !strings.Contains(out, "图元格式") {
		t.Fatalf("deferred metafile placeholder missing:\n%s", out)
	}
}

// TestRenderDocxMetafileStandalone 独立图元（w:drawing 与 w:pict 两形态，
// 不在 object 内）：不发射注定 404 的 img，诚实占位块 + 原子发射语义保留
func TestRenderDocxMetafileStandalone(t *testing.T) {
	rels := fx.RelsShell + fx.ImgRel("rBlip", "media/scan.tiff") + fx.ImgRel("rPict", "media/old.emf")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.BlipXML("rBlip") + fx.PictXML("rPict") + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/media/scan.tiff": []byte{0x49, 0x49, 0x2A, 0x00},
		"word/media/old.emf":   []byte{0x01, 0x00, 0x00, 0x00},
	}), "en")
	if strings.Count(out, "<img") != 0 {
		t.Fatalf("metafiles must not emit imgs:\n%s", out)
	}
	if n := strings.Count(out, "doc-img-missing"); n != 2 {
		t.Fatalf("want 2 honest placeholders, got %d:\n%s", n, out)
	}
	if !strings.Contains(out, "EMF/WMF metafile") {
		t.Fatalf("metafile i18n text missing:\n%s", out)
	}
	if !strings.Contains(out, "scan.tiff") || !strings.Contains(out, "old.emf") {
		t.Fatalf("placeholder should name the media:\n%s", out)
	}
}

// TestRenderDocxEmbedEscaped ProgID/嵌入名藏注入载荷：占位块全部转义
func TestRenderDocxEmbedEscaped(t *testing.T) {
	rels := fx.RelsShell + fx.EmbedRel("rEmb", "oleObject", `embeddings/a&quot;&gt;&lt;script&gt;b.bin`)
	// 载荷经 XML 实体进源（属性值里的裸 < 非法，会打断解析器）——解码后
	// 的属性值才是注入探针本体
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("", "rEmb", `Package&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;`) + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		`word/embeddings/a"><script>b.bin`: []byte("x"),
	}), "en")
	if strings.Contains(out, "<script>") {
		t.Fatalf("embed injection survived:\n%s", out)
	}
	if !strings.Contains(out, "e=word%2Fembeddings%2Fa%22%3E%3Cscript%3Eb.bin") {
		t.Fatalf("embed entry name must be query-escaped in href:\n%.400s", out)
	}
	if !strings.Contains(out, "Package&#34;&gt;") {
		t.Fatalf("progID escaping broken:\n%.400s", out)
	}
}

func TestResolveEmbedTarget(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"embeddings/oleObject1.bin", "word/embeddings/oleObject1.bin"}, // 相对 word/ 基准
		{"/word/embeddings/x.html", "word/embeddings/x.html"},           // OPC 包根绝对形态
		{"../embeddings/oleObject1.bin", ""},                            // 归一化到包根 embeddings/（逃出 word/）
		{"../evil.bin", ""},                                             // 逃出 word/
		{"media/image1.png", ""},                                        // 非 embeddings 形态
		{"media/../embeddings/x", "word/embeddings/x"},                  // 归一化落位
		{"..\\embeddings\\evil", ""},                                    // 反斜杠
		{"http://example.com/x", ""},                                    // 外部 URL（另有 TargetMode 过滤）
		{"embeddings/", ""},                                             // 空条目
	}
	for _, c := range cases {
		if got := resolveEmbedTarget(c.in); got != c.want {
			t.Errorf("resolveEmbedTarget(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestRenderDocxEmbedNameRestore 渲染侧名字还原（P-20261118-1②）：CFB 嵌入
// 的 GBK 名在簿构建期解码还原——块上显示原始文件名+html 预览标记，ProgID
// 隐（必改④：抽名成功 Package 恒显噪声）。P-20261118-2：主用例改喂真实
// Word 有标志布局（否则盲区自证延续）；第二嵌入保持无标志布局——渲染全链
// 同时覆盖两种布局 + 仲裁并列同分取候选 A
func TestRenderDocxEmbedNameRestore(t *testing.T) {
	rels := fx.RelsShell + fx.EmbedRel("rEmb", "oleObject", "embeddings/oleObject2.bin")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("", "rEmb", "Package") + `</w:body></w:document>`
	cfb := fx.BuildCFB(t, 512, fx.Ole10FlaggedPayload(fx.GbkSampleName, 600), true, nil)
	out := docxRender(t, fx.BuildDocxFull(t, doc, rels, map[string][]byte{
		"word/embeddings/oleObject2.bin": cfb,
	}), "zh")
	if !strings.Contains(out, "📎 根据IP关联组织.html") {
		t.Fatalf("extracted original name missing:\n%s", out)
	}
	// P-20261118-3：html 档预览动作 = 新标签壳页 URL（&ui=1），零 data 标记
	if !strings.Contains(out, "&amp;ui=1") {
		t.Fatalf("shell-page preview URL missing:\n%s", out)
	}
	if strings.Contains(out, "Package") {
		t.Fatalf("ProgID must hide once the name is restored (必改④):\n%s", out)
	}
	if strings.Contains(out, "📎 oleObject2.bin") {
		t.Fatalf("container entry name must not surface once restored (URL 取件键保留，显示名让位):\n%s", out)
	}
	// 同文档双嵌入不同名互不串扰：第二块抽不出（非 CFB）回落条目名
	rels2 := fx.RelsShell +
		fx.EmbedRel("rA", "oleObject", "embeddings/oleObject1.bin") +
		fx.EmbedRel("rB", "package", "embeddings/plain.txt")
	doc2 := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		fx.ObjectXML("", "rA", "Package") + fx.ObjectXML("", "rB", "Package") + `</w:body></w:document>`
	cfbA := fx.BuildCFB(t, 512, fx.Ole10Payload("alpha.html", 4200), false, nil) // ≥4KB 走常规链
	out2 := docxRender(t, fx.BuildDocxFull(t, doc2, rels2, map[string][]byte{
		"word/embeddings/oleObject1.bin": cfbA,
		"word/embeddings/plain.txt":      []byte("not a cfb"),
	}), "zh")
	if !strings.Contains(out2, "📎 alpha.html") || !strings.Contains(out2, "📎 plain.txt") {
		t.Fatalf("dual embeds must not cross-contaminate names:\n%s", out2)
	}
}

// TestRenderDocxEmbedNameBounded 簿级有界化（评审必改③/必改⑤）：>16 个嵌入
// 时第 17 个起停止抽名，回落 .bin 条目名——堵病态包数千嵌入 × 逐请求重建
// 簿的放大面（观感降级红线：可下载性不受影响）
func TestRenderDocxEmbedNameBounded(t *testing.T) {
	const total = docxEmbedNameMax + 4
	var rels strings.Builder
	var doc strings.Builder
	media := map[string][]byte{}
	rels.WriteString(fx.RelsShell)
	for i := 1; i <= total; i++ {
		id := fmt.Sprintf("rE%d", i)
		entry := fmt.Sprintf("word/embeddings/oleObject%d.bin", i)
		name := fmt.Sprintf("doc-%02d.html", i)
		rels.WriteString(fx.EmbedRel(id, "oleObject", fmt.Sprintf("embeddings/oleObject%d.bin", i)))
		doc.WriteString(fx.ObjectXML("", id, "Package"))
		media[entry] = fx.BuildCFB(t, 512, fx.Ole10Payload(name, 8), true, nil)
	}
	docStr := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		doc.String() + `</w:body></w:document>`
	out := docxRender(t, fx.BuildDocxFull(t, docStr, rels.String(), media), "zh")
	// 前 16 个抽出名在场
	if !strings.Contains(out, "📎 doc-01.html") || !strings.Contains(out, "📎 doc-16.html") {
		t.Fatalf("first %d embeds must restore names:\n%s", docxEmbedNameMax, out)
	}
	// 超限的回落条目名（.bin 直供名 + ProgID 身份回归）
	for i := docxEmbedNameMax + 1; i <= total; i++ {
		want := fmt.Sprintf("📎 oleObject%d.bin", i)
		if !strings.Contains(out, want) {
			t.Fatalf("bounded embed #%d must fall back to entry name:\n%s", i, out)
		}
		gone := fmt.Sprintf("📎 doc-%02d.html", i)
		if strings.Contains(out, gone) {
			t.Fatalf("bounded embed #%d must not restore a name:\n%s", i, out)
		}
	}
}

func TestEmbedPreviewFor(t *testing.T) {
	// 命中：html/pdf/图型/text 族/md（显式白名单）
	for _, ext := range []string{"html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp",
		"md", "markdown", "txt", "log", "json", "xml", "yaml", "yml", "ini", "conf", "csv", "tsv"} {
		if _, _, ok := EmbedPreviewFor("file." + ext); !ok {
			t.Errorf("ext %q must be previewable", ext)
		}
	}
	// 排除（必改①回落语义）：svg 可携脚本/图元/压缩包/可执行/未知/抽名失败回落名
	for _, name := range []string{
		"proto.svg", "icon.emf", "meta.wmf", "scan.tif", "scan.tiff",
		"bundle.zip", "pack.7z", "arch.tar", "app.exe", "oleObject2.bin",
		"noext", "unknown.xyz", "makefile", "",
	} {
		if _, _, ok := EmbedPreviewFor(name); ok {
			t.Errorf("name %q must NOT be previewable", name)
		}
	}
	// 大小写不敏感（path.Ext 原样小写化）
	if _, ext, ok := EmbedPreviewFor("REPORT.HTML"); !ok || ext != "html" {
		t.Fatalf("case-insensitive ext = %q ok=%v", ext, ok)
	}
}

// TestEmbedSandboxCSP 8 组合表驱动（复审建议②：scripts×forms×popups 全
// 2^3 直连 URL 态）——token 组合逐级正确 + 硬红线：任何组合 CSP 恒不含
// allow-same-origin / allow-top-navigation（构造性保证的双保险断言）
func TestEmbedSandboxCSP(t *testing.T) {
	cases := []struct{ scripts, forms, popups, want string }{
		{"0", "0", "0", "sandbox"},
		{"1", "0", "0", "sandbox allow-scripts allow-fullscreen"},
		{"0", "1", "0", "sandbox allow-forms allow-modals"},
		{"0", "0", "1", "sandbox allow-popups"},
		{"1", "1", "0", "sandbox allow-scripts allow-fullscreen allow-forms allow-modals"},
		{"1", "0", "1", "sandbox allow-scripts allow-fullscreen allow-popups"},
		{"0", "1", "1", "sandbox allow-forms allow-modals allow-popups"},
		{"1", "1", "1", "sandbox allow-scripts allow-fullscreen allow-forms allow-modals allow-popups"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/s/t/docx-embed?preview=1&scripts="+c.scripts+
			"&forms="+c.forms+"&popups="+c.popups, nil)
		got := EmbedSandboxCSP(r)
		if got != c.want {
			t.Errorf("scripts=%s forms=%s popups=%s:\n got %q\nwant %q", c.scripts, c.forms, c.popups, got, c.want)
		}
		if strings.Contains(got, "allow-same-origin") || strings.Contains(got, "allow-top-navigation") {
			t.Errorf("hard red line violated: %q", got)
		}
	}
	// 参数值非 "1" 视为未开（opt-in 语义）
	r := httptest.NewRequest("GET", "/s/t/docx-embed?preview=1&scripts=true&forms=yes", nil)
	if got := EmbedSandboxCSP(r); got != "sandbox" {
		t.Errorf("non-1 param values must stay sandbox-only, got %q", got)
	}
}
