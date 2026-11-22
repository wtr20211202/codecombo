package share

// ── 嵌入端点端到端测试（P-20261119-4 自 extract_test.go 尾段迁回 share——
// 字节层测试随渲染面下沉 filepreview，端点级测试（handleDocxEmbed
// preview=1/ui=1 全链）留驻端点所属包；夹具经 docxfixture_test.go 短名
// 别名消费 filepreview 导出构造器，断言面零改动迁移。P-20261120-2 循
// P-20261119-1 既定收紧方向再迁 TestDocxEmbedPreviewNameSource 整函数
// 入本文件「嵌入端点测试集中地」——service_test.go 增全幅断言加深体量
// 守卫欠账，断言面零改动仅迁址+全幅断言组随迁）──

import (
	"bytes"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	preview "codecombo/server/filepreview"
)

func TestDocxEmbedPreviewRealLayoutAndPdf(t *testing.T) {
	root := fixture(t)
	htmlBody := []byte("<!doctype html><html><body><p>真实布局正文</p></body></html>")
	pdfBody := []byte("%PDF-1.7\n%fake minimal body\n%%EOF\n")
	cfbReal := buildCFB(t, 512, ole10RealLayoutPayload(gbkSampleName, "D:\\xls\\", nil, gbkRealTempPath, htmlBody), true, nil)
	cfbPdf := buildCFB(t, 512, ole10RealLayoutPayload("doc.pdf", "D:\\src\\", nil, gbkRealTempPath, pdfBody), true, nil)
	rels := relsShell +
		embedRel("rReal", "oleObject", "embeddings/real1.bin") +
		embedRel("rPdf", "oleObject", "embeddings/realpdf.bin")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		objectXML("", "rReal", "Package") + objectXML("", "rPdf", "Package") + `</w:body></w:document>`
	pkg := buildDocxFull(t, doc, rels, map[string][]byte{
		"word/embeddings/real1.bin":   cfbReal,
		"word/embeddings/realpdf.bin": cfbPdf,
	})
	if err := os.WriteFile(filepath.Join(root, "docs", "real.docx"), pkg, 0o644); err != nil {
		t.Fatal(err)
	}
	srv, token := newDocxShareServer(t, root, false)

	// 真实布局 html：preview=1 抽出正文按 text/html 供给（旧解析形态全灭）
	resp := get(t, srv.URL+docxEmbedURLFor(token, "real.docx", "word/embeddings/real1.bin")+"&preview=1")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("real-layout container must preview as extracted html, got %d %q",
			resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if !bytes.Equal(b, htmlBody) {
		t.Fatalf("real-layout preview body must be the extracted html verbatim, got %.120q", b)
	}
	// CFB 包裹 pdf：preview=1 供给抽取出的 %PDF 正文（application/pdf inline
	// 的不再是容器原始字节）
	respF := get(t, srv.URL+docxEmbedURLFor(token, "real.docx", "word/embeddings/realpdf.bin")+"&preview=1")
	fb, _ := io.ReadAll(respF.Body)
	respF.Body.Close()
	if respF.StatusCode != 200 {
		t.Fatalf("pdf preview status = %d", respF.StatusCode)
	}
	if respF.Header.Get("Content-Type") != "application/pdf" {
		t.Fatalf("CFB-wrapped pdf must preview as application/pdf with extracted body, got %q",
			respF.Header.Get("Content-Type"))
	}
	if !bytes.HasPrefix(fb, []byte("%PDF")) || bytes.HasPrefix(fb, preview.CFBMagic) {
		t.Fatalf("pdf preview body must be extracted %%PDF bytes, got container/head %.24q", fb)
	}
}

// TestDocxEmbedRealFixtureEndpoint 真实捕获容器端到端（P-20261118-10 硬
// 验收）：testdata 双容器（真实 Word docx 字节级捕获，SHA 双锚见
// office_test TestDocxEmbedRealFixtureBytes）经 handleDocxEmbed 全链——
// preview=1 出 text/html 净本（<!DOCTYPE 起 </html> 尾、诊断头缺席）、
// ui=1 出壳页**预览器模式**（iframe+开关在场，非诚实回落态）。P-7 复刻
// 夹具与线上字节不一致（测试绿生产红第四次盲区）的根治验收面：合成
// builder 全绿之外，真实字节也必须在端点上直览
func TestDocxEmbedRealFixtureEndpoint(t *testing.T) {
	root := fixture(t)
	rels := relsShell +
		embedRel("rE1", "oleObject", "embeddings/oleobject1-real-layout.bin") +
		embedRel("rE2", "oleObject", "embeddings/oleobject2-real-layout.bin")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		objectXML("", "rE1", "Package") + objectXML("", "rE2", "Package") + `</w:body></w:document>`
	embeds := map[string][]byte{}
	for _, f := range []string{"oleobject1-real-layout.bin", "oleobject2-real-layout.bin"} {
		b, err := os.ReadFile(filepath.Join("..", "filepreview", "testdata", f))
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		embeds["word/embeddings/"+f] = b
	}
	pkg := buildDocxFull(t, doc, rels, embeds)
	if err := os.WriteFile(filepath.Join(root, "docs", "real.docx"), pkg, 0o644); err != nil {
		t.Fatal(err)
	}
	srv, token := newDocxShareServer(t, root, false)

	for _, tc := range []struct {
		entry string
		title string // 还原名（驱动 preview 白名单）与正文标题各取所需
	}{
		{"word/embeddings/oleobject1-real-layout.bin", "分级授权管理 - 界面原型"},
		{"word/embeddings/oleobject2-real-layout.bin", "根据IP关联组织"},
	} {
		// preview=1：真实容器抽出正文按 text/html 直览（修前 binary-guard
		// 回落 attachment——本断言即「点预览弹下载框」主诉的反向钉死）
		resp := get(t, srv.URL+docxEmbedURLFor(token, "real.docx", tc.entry)+"&preview=1")
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/html; charset=utf-8" {
			t.Fatalf("%s: preview must serve extracted html, got %d %q",
				tc.entry, resp.StatusCode, resp.Header.Get("Content-Type"))
		}
		if h := resp.Header.Get(preview.EmbedDiagHeader); h != "" {
			t.Fatalf("%s: preview must not carry diag header, got %q", tc.entry, h)
		}
		if !utf8.Valid(b) || !bytes.HasPrefix(b, []byte("<!DOCTYPE")) || !bytes.HasSuffix(b, []byte("</html>\n")) {
			t.Fatalf("%s: preview body must be clean html, got head %.24q tail %.24q",
				tc.entry, b[:min(len(b), 24)], b[max(0, len(b)-24):])
		}
		if !bytes.Contains(b, []byte(tc.title)) {
			t.Fatalf("%s: preview body must contain readable title %q", tc.entry, tc.title)
		}
		// ui=1：壳页预览器模式（iframe+开关在场）——诚实回落态（「暂不
		// 支持自动预览」注记）不得出现
		respUI := get(t, srv.URL+docxEmbedURLFor(token, "real.docx", tc.entry)+"&ui=1")
		page, _ := io.ReadAll(respUI.Body)
		respUI.Body.Close()
		if respUI.StatusCode != 200 {
			t.Fatalf("%s: ui=1 status = %d", tc.entry, respUI.StatusCode)
		}
		if !bytes.Contains(page, []byte(`class="shell-frame"`)) {
			t.Fatalf("%s: ui=1 must render previewer shell with iframe, got %.200q", tc.entry, page)
		}
		if bytes.Contains(page, []byte("暂不支持自动预览")) {
			t.Fatalf("%s: ui=1 must not render honest-fallback note on real capture", tc.entry)
		}
	}
}

// ── 壳页 form GET 交互测试（P-20261119-1 体量守卫随迁：自 service_test.go
// 整函数迁入，断言面零改动——本文件=嵌入端点测试集中地，循 P-20261118-10
// 「嵌入端点测试与字节层同文件集中」先例，service_test.go 回基线下）──

// TestDocxEmbedShellFormGET 壳页 form GET 零 JS 开关（评审必改⑤两段式 +
// 建议f 新形态）：带参重渲染的 iframe src/sandbox attr/二级 checkbox 可见性
// 随参数联动，硬红线在渲染面构造性成立
func TestDocxEmbedShellFormGET(t *testing.T) {
	root := fixture(t)
	htmlBody := []byte("<!doctype html><html><body><button id=\"go\">ok</button></body></html>")
	cfbFull := buildCFB(t, 512, ole10FullPayload(gbkSampleName, "D:/xls/", "C:/tmp/", htmlBody), true, nil)
	rels := relsShell + embedRel("rF", "oleObject", "embeddings/full.bin")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		objectXML("", "rF", "Package") + `</w:body></w:document>`
	pkg := buildDocxFull(t, doc, rels, map[string][]byte{"word/embeddings/full.bin": cfbFull})
	if err := os.WriteFile(filepath.Join(root, "docs", "sh.docx"), pkg, 0o644); err != nil {
		t.Fatal(err)
	}
	srv, token := newDocxShareServer(t, root, false)
	shell := func(extra string) string {
		resp := get(t, srv.URL+docxEmbedURLFor(token, "sh.docx", "word/embeddings/full.bin")+"&ui=1"+extra)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("shell status = %d", resp.StatusCode)
		}
		return string(b)
	}

	// 静态档：sandbox 空、iframe src 无脚本参数、二级 checkbox 不渲染
	s0 := shell("")
	if !strings.Contains(s0, `sandbox=""`) || strings.Contains(s0, "scripts=1") {
		t.Fatalf("static shell must have empty sandbox and no script params:\n%.600s", s0)
	}
	if strings.Contains(s0, `name="forms"`) {
		t.Fatalf("forms checkbox must stay hidden while scripts off:\n%.600s", s0)
	}
	// 风险确认 checkbox（两段式语义）+ 应用按钮在场（零 JS 确认形态）
	if !strings.Contains(s0, `name="scripts"`) || !strings.Contains(s0, "type=\"submit\"") {
		t.Fatalf("risk-confirm checkbox + apply button missing:\n%.600s", s0)
	}
	// 开关区折叠（P-20261119-1）：details 精确形态（无 open 属性=默认收起，
	// 精确形态断言兼作 open 缺席守卫——未来模板若加属性此形态即不匹配，
	// 禁裸 "open" 子串否定断言防误伤）+ summary 常驻徽标行（收起态唯一
	// 告知面）静态档文案在场
	if !strings.Contains(s0, `<details class="shell-ctl">`) {
		t.Fatalf("static shell must render collapsed details exact form (no open attr):\n%.600s", s0)
	}
	if !strings.Contains(s0, "Scripts &amp; popups:") || !strings.Contains(s0, "blocked · default") {
		t.Fatalf("collapsed summary badge (off state) missing:\n%.600s", s0)
	}
	// scripts=1：iframe src 换脚本参数（属性 & 经 html/template 转义）、
	// sandbox allow-scripts(+fullscreen)、二级 checkbox 出现
	s1 := shell("&scripts=1")
	if !strings.Contains(s1, "preview=1&amp;scripts=1") || strings.Contains(s1, "forms=1") {
		t.Fatalf("scripts shell iframe src mismatch:\n%.600s", s1)
	}
	if !strings.Contains(s1, `sandbox="allow-scripts allow-fullscreen"`) || !strings.Contains(s1, `name="forms"`) {
		t.Fatalf("scripts shell sandbox/forms toggle mismatch:\n%.600s", s1)
	}
	// 收起态徽标随级切换（P-20261119-1）：scripts 档徽标文案
	if !strings.Contains(s1, "scripts enabled") {
		t.Fatalf("collapsed summary badge (scripts state) missing:\n%.600s", s1)
	}
	// scripts=1&forms=1：popups 随表单档联动、sandbox 全 token、注记条末态
	// （常驻风险提示「请勿输入真实凭据」）
	s2 := shell("&scripts=1&forms=1")
	if !strings.Contains(s2, "preview=1&amp;scripts=1&amp;forms=1&amp;popups=1") ||
		!strings.Contains(s2, `sandbox="allow-scripts allow-fullscreen allow-forms allow-modals allow-popups"`) {
		t.Fatalf("full shell src/sandbox mismatch:\n%.600s", s2)
	}
	if !strings.Contains(s2, "never enter real credentials") {
		t.Fatalf("persistent risk hint missing at full level:\n%.600s", s2)
	}
	// full 档收起态徽标（P-20261119-1 必改1）：summary 常驻行必须自带凭据
	// 警示要点（收起态唯一告知面落空=修订三语义在最危险一档失守）。徽标句
	// 断言用 html/template 保守转义形态（+→&#43;，浏览器 textContent 解码
	// 回 "+"）——该转义串只在徽标在场（note 注记句是 scripts/forms/popups
	// 无加号写法），顺带把「徽标行在场」与「注记在场」两个面分开钉
	if !strings.Contains(s2, "scripts &#43; forms/popups enabled") || !strings.Contains(s2, "never enter real credentials") {
		t.Fatalf("collapsed summary badge (full state) must carry credential warning:\n%.600s", s2)
	}
	// 全幅模式组合态（P-20261120-2 评审建议7 落既有 shell() 组合 helper）：
	// scripts=1&forms=1&full=1 三态并存——克隆式互转 URL（必改2）的保真面
	// 在最复杂组合下钉死：header 整体缺席（details/入口链接结构性不渲染），
	// iframe src/sandbox 与 s2 完全一致（full 不进 iframe src 不进 sandbox
	// 词表——pvParams 原样携带），浮动退出钮 href 保留 scripts/forms 态且
	// 不含 full=1
	s3 := shell("&scripts=1&forms=1&full=1")
	if !strings.Contains(s3, "preview=1&amp;scripts=1&amp;forms=1&amp;popups=1") ||
		!strings.Contains(s3, `sandbox="allow-scripts allow-fullscreen allow-forms allow-modals allow-popups"`) {
		t.Fatalf("full-preview combo shell src/sandbox must match s2 verbatim:\n%.600s", s3)
	}
	for _, notWant := range []string{"<header", "<details", `class="shell-full"`} {
		if strings.Contains(s3, notWant) {
			t.Fatalf("full-preview combo shell must not render header faces (%q):\n%.600s", notWant, s3)
		}
	}
	exitAt := strings.Index(s3, `class="shell-full-exit" href="`)
	if exitAt < 0 {
		t.Fatalf("full-preview combo shell missing floating exit button:\n%.600s", s3)
	}
	exitHref := s3[exitAt+len(`class="shell-full-exit" href="`):]
	exitHref = exitHref[:strings.Index(exitHref, `"`)]
	if strings.Contains(exitHref, "full=1") ||
		!strings.Contains(exitHref, "scripts=1") || !strings.Contains(exitHref, "forms=1") {
		t.Fatalf("exit href must del full and keep scripts/forms state (query clone), got %q", exitHref)
	}
	// 常规态入口链接同法保真（克隆 set full）：scripts=1 态的入口 href 必
	// 同时携带 scripts=1 与 full=1——「点全幅丢脚本态」的回归钉
	entryAt := strings.Index(s1, `class="shell-full" href="`)
	if entryAt < 0 {
		t.Fatalf("scripts shell missing full-preview entry link:\n%.600s", s1)
	}
	entryHref := s1[entryAt+len(`class="shell-full" href="`):]
	entryHref = entryHref[:strings.Index(entryHref, `"`)]
	if !strings.Contains(entryHref, "full=1") || !strings.Contains(entryHref, "scripts=1") {
		t.Fatalf("entry href must carry full=1 and keep scripts state (query clone), got %q", entryHref)
	}
	// 硬红线（渲染面）：任何参数组合壳页 sandbox attr 恒不含同源/顶层导航
	for _, s := range []string{s0, s1, s2, s3} {
		if strings.Contains(s, "allow-same-origin") || strings.Contains(s, "allow-top-navigation") {
			t.Fatalf("hard red line violated in shell render:\n%.600s", s)
		}
	}
	// form action 是裸端点路径，path/e/ui 以 hidden 域携带——form GET 提交
	// 序列化会用表单字段整体替换 action URL 的 query string（action 带全参
	// query 时提交后 path/e 丢失 → resolve 落分享根目录 not_renderable，
	// 实测踩坑），hidden 域是参数存活的唯一通道；勾掉再提交即表达「关回」
	if !strings.Contains(s2, `action="/s/`+token+`/docx-embed"`) ||
		!strings.Contains(s2, `name="path" value="sh.docx"`) ||
		!strings.Contains(s2, `name="e" value="word/embeddings/full.bin"`) ||
		!strings.Contains(s2, `name="ui" value="1"`) {
		t.Fatalf("form action/hidden fields mismatch:\n%.600s", s2)
	}
}

// TestDocxEmbedPreviewNameSource GBK 名驱动的白名单端到端证据。P-20261118-3
// 断言反转（评审必改3）：旧断言「CFB→text/html」固化的恰是本案乱码坏行为
// ——还原名 ext=.html 命中白名单但字节仍是 OLE 容器，容器整体按 text/html
// 供给即乱码根因。现名-only 容器（正文抽不出）被容器魔数守卫拦回 attachment
// （必改1b 诚实下载下限）；完整布局容器（正文在场）preview=1 供给抽取出的
// html 正文（乱码根除主刀①端到端）。P-20261118-2：改喂真实 Word 有标志布局
func TestDocxEmbedPreviewNameSource(t *testing.T) {
	root := fixture(t)
	cfbNameOnly := buildCFB(t, 512, ole10FlaggedPayload(gbkSampleName, 600), true, nil)
	htmlBody := []byte("<!doctype html><html><head><meta charset=\"UTF-8\"><title>根据IP关联组织</title></head><body><p>原型正文</p></body></html>")
	cfbFull := buildCFB(t, 512, ole10FullPayload(gbkSampleName, "D:/xls/", "C:/tmp/", htmlBody), true, nil)
	rels := relsShell +
		embedRel("rName", "oleObject", "embeddings/nameonly.bin") +
		embedRel("rFull", "oleObject", "embeddings/full.bin")
	doc := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		objectXML("", "rName", "Package") + objectXML("", "rFull", "Package") + `</w:body></w:document>`
	pkg := buildDocxFull(t, doc, rels, map[string][]byte{
		"word/embeddings/nameonly.bin": cfbNameOnly,
		"word/embeddings/full.bin":     cfbFull,
	})
	if err := os.WriteFile(filepath.Join(root, "docs", "cn.docx"), pkg, 0o644); err != nil {
		t.Fatal(err)
	}
	srv, token := newDocxShareServer(t, root, false)

	// 名-only 容器 + preview=1：容器魔数守卫回落 attachment（断言反转锚——
	// 旧「CFB→text/html」坏行为在此钉死为拒绝）
	resp := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/nameonly.bin")+"&preview=1")
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/octet-stream" ||
		!strings.Contains(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("name-only container must fall back to attachment, got %d %q %q",
			resp.StatusCode, resp.Header.Get("Content-Type"), resp.Header.Get("Content-Disposition"))
	}
	if !bytes.Equal(b, cfbNameOnly) {
		t.Fatalf("fallback body must be the untouched container, got %d bytes", len(b))
	}

	// 完整布局容器 + preview=1：抽出 html 正文按 text/html 供给（字节等值）
	respF := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/full.bin")+"&preview=1")
	fb, _ := io.ReadAll(respF.Body)
	respF.Body.Close()
	if respF.StatusCode != 200 || respF.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("full-layout container must preview as extracted text/html, got %d %q",
			respF.StatusCode, respF.Header.Get("Content-Type"))
	}
	if respF.Header.Get("Content-Security-Policy") != "sandbox" || respF.Header.Get("X-Frame-Options") != "SAMEORIGIN" {
		t.Fatalf("extracted html preview CSP/XFO = %q / %q",
			respF.Header.Get("Content-Security-Policy"), respF.Header.Get("X-Frame-Options"))
	}
	if !bytes.Equal(fb, htmlBody) {
		t.Fatalf("preview body must be the extracted html verbatim, got %.120q", fb)
	}

	// 同一条目下载形态：Content-Disposition 带还原名（RFC 2231），字节=容器本体
	respD := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/full.bin"))
	defer respD.Body.Close()
	if cd := respD.Header.Get("Content-Disposition"); !strings.Contains(cd, "attachment") ||
		!strings.Contains(cd, url.QueryEscape("根据IP关联组织.html")) {
		t.Fatalf("download disposition should carry the GBK-decoded name, got %q", cd)
	}

	// ui=1 壳页分型：完整布局 → 预览器壳页（标题=还原名+注记条+form GET
	// 开关+全幅 iframe 指向 preview=1）；名-only → 面一致性守卫回落 attachment
	respS := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/full.bin")+"&ui=1")
	sb, _ := io.ReadAll(respS.Body)
	respS.Body.Close()
	if respS.StatusCode != 200 || respS.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("ui=1 must render the previewer shell, got %d %q", respS.StatusCode, respS.Header.Get("Content-Type"))
	}
	if csp := respS.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "form-action 'self'") ||
		!strings.Contains(csp, "frame-src 'self'") {
		t.Fatalf("shell CSP must lock form+frame to self, got %q", csp)
	}
	if xfo := respS.Header.Get("X-Frame-Options"); xfo != "DENY" {
		t.Fatalf("shell is a top-level doc, must keep global XFO DENY (no overwrite), got %q", xfo)
	}
	ss := string(sb)
	for _, want := range []string{
		"<title>根据IP关联组织.html</title>",
		"shell-frame",
		"&amp;preview=1", // iframe src 指向 preview 字节面（属性 & 经转义）
		"shell-note",     // 注记条（默认无 Accept-Language → en 文案，下断言）
		"Scripts are disabled",
		`method="get"`,
		`name="scripts"`,
		"Apply",
		// P-20261119-1 开关区折叠：details 精确形态在场（无 open 属性=默认
		// 收起；精确形态断言兼作 open 缺席守卫——未来模板若加属性，此形态
		// 即不匹配，禁裸 "open" 子串否定断言防词条误伤）
		`<details class="shell-ctl">`,
		// summary 常驻徽标行（收起态唯一告知面）三段在场
		"Scripts &amp; popups:",
		"blocked · default",
		// P-20261120-2 全幅模式常规态：标题行「全幅预览 ⤢」入口链接
		//（精确形态 `class="shell-full"` 含闭引号，与 shell-full-exit 区分）
		`class="shell-full"`,
	} {
		if !strings.Contains(ss, want) {
			t.Fatalf("shell page missing %q:\n%.600s", want, ss)
		}
	}
	if strings.Contains(ss, "allow-same-origin") || strings.Contains(ss, "allow-top-navigation") {
		t.Fatalf("shell iframe sandbox must never carry hard red-line tokens:\n%.600s", ss)
	}
	// 入口链接 href 带 full=1（query 克隆 set full——评审必改2）；常规态无
	// 浮动退出钮（全幅态独有面）
	fullEntry := ss[strings.Index(ss, `class="shell-full" href="`)+len(`class="shell-full" href="`):]
	fullEntry = fullEntry[:strings.Index(fullEntry, `"`)]
	if !strings.Contains(fullEntry, "full=1") {
		t.Fatalf("regular shell full-preview entry href must carry full=1, got %q", fullEntry)
	}
	if strings.Contains(ss, `class="shell-full-exit"`) {
		t.Fatalf("regular shell must not render the floating exit button:\n%.600s", ss)
	}
	// ui=1&full=1 全幅预览模式（P-20261120-2）：header 整体条件不渲染
	//（服务端条件渲染零死 DOM——<details>/开关表单/入口链接结构性缺席）、
	// iframe 仍在场、右下浮动退出钮在场且 href 已 del full（不含 full=1）；
	// 整页无 full=1 即同时钉死「full 不进 iframe src」（sandbox 词表
	// allow-fullscreen 含 full 但不含 full=1，子串不误伤）
	respFull := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/full.bin")+"&ui=1&full=1")
	fbFull, _ := io.ReadAll(respFull.Body)
	respFull.Body.Close()
	if respFull.StatusCode != 200 || respFull.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("ui=1&full=1 must render full previewer shell, got %d %q",
			respFull.StatusCode, respFull.Header.Get("Content-Type"))
	}
	fs := string(fbFull)
	for _, want := range []string{
		"shell-frame",             // iframe 仍在场（唯一流内子元素占满视口）
		`class="shell-full-exit"`, // 浮动退出钮（title 双语「显示标题栏」）
		"Show header",
	} {
		if !strings.Contains(fs, want) {
			t.Fatalf("full shell page missing %q:\n%.600s", want, fs)
		}
	}
	if strings.Contains(fs, "full=1") {
		t.Fatalf("full shell must not carry full=1 anywhere (exit href del'd, iframe src untouched):\n%.600s", fs)
	}
	for _, notWant := range []string{"<header", "<details", `class="shell-full"`, `name="scripts"`} {
		if strings.Contains(fs, notWant) {
			t.Fatalf("full shell must not render header faces (%q):\n%.600s", notWant, fs)
		}
	}
	// ui=1 壳页诚实回落模式（P-20261118-7 ④，用户实测主诉「点预览弹下载
	// 框」的体验修复）：名-only 容器抽取失败 → 不再整页回落 attachment
	// 静默下载，改渲染壳页（标题=还原名+暂不支持提示+下载按钮，无 iframe
	// 无开关）；诊断枚举码在响应头（评审建议b 粗粒度面）
	respG := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/nameonly.bin")+"&ui=1")
	gb, _ := io.ReadAll(respG.Body)
	respG.Body.Close()
	if respG.StatusCode != 200 || respG.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("ui=1 on un-extractable container must render the honest fallback shell, got %d %q",
			respG.StatusCode, respG.Header.Get("Content-Type"))
	}
	if diag := respG.Header.Get("X-Embed-Extract-Diag"); diag != string(preview.EmbedDiagAnchorMiss) {
		t.Fatalf("fallback shell must carry coarse diag enum, got %q", diag)
	}
	gs := string(gb)
	for _, want := range []string{
		"<title>根据IP关联组织.html</title>",
		"shell-note",
		"can&#39;t be auto-previewed yet", // en 文案（无 Accept-Language 默认 en）+ template 转义
		`class="shell-dl"`,
	} {
		if !strings.Contains(gs, want) {
			t.Fatalf("fallback shell page missing %q:\n%.600s", want, gs)
		}
	}
	// "<details"（P-20261119-1）：诚实回落无折叠——无开关可折，details
	// 整体缺席守卫一行防漂移
	for _, notWant := range []string{"<iframe", `name="scripts"`, "preview=1", "<details"} {
		if strings.Contains(gs, notWant) {
			t.Fatalf("fallback shell must not carry iframe/switches/preview link (%q):\n%.600s", notWant, gs)
		}
	}
	// 守卫一致性（评审必改2）：同一容器 preview=1 与 ui=1 的诊断枚举同源
	//——preview=1 attachment 回落带同值诊断头
	respP2 := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/nameonly.bin")+"&preview=1")
	_, _ = io.Copy(io.Discard, respP2.Body)
	respP2.Body.Close()
	if diag := respP2.Header.Get("X-Embed-Extract-Diag"); diag != string(preview.EmbedDiagAnchorMiss) {
		t.Fatalf("preview fallback must carry the same diag enum as shell, got %q", diag)
	}
	// 回落态 full=1 直接忽略按常规渲染（P-20261120-2 评审必改1：全幅分支
	// 以预览器模式为前提——回落态页面唯一内容就是 header，无门禁则全幅=
	// 无 header 无 iframe 空白页只剩浮动钮）：header 仍在、无浮动退出钮、
	// 无入口链接（整页无 full=1 字样）
	respGF := get(t, srv.URL+docxEmbedURLFor(token, "cn.docx", "word/embeddings/nameonly.bin")+"&ui=1&full=1")
	gfb, _ := io.ReadAll(respGF.Body)
	respGF.Body.Close()
	if respGF.StatusCode != 200 || respGF.Header.Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("fallback with full=1 must still render honest fallback shell, got %d %q",
			respGF.StatusCode, respGF.Header.Get("Content-Type"))
	}
	gfs := string(gfb)
	if !strings.Contains(gfs, "<header") || !strings.Contains(gfs, "can&#39;t be auto-previewed yet") {
		t.Fatalf("fallback with full=1 must render header+note unchanged:\n%.600s", gfs)
	}
	for _, notWant := range []string{`class="shell-full-exit"`, `class="shell-full"`, "full=1", "<iframe"} {
		if strings.Contains(gfs, notWant) {
			t.Fatalf("fallback must ignore full=1 (no full-mode faces %q):\n%.600s", notWant, gfs)
		}
	}
}
