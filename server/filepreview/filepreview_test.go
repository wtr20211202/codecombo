package filepreview

import "testing"

func TestForFileBuiltin(t *testing.T) {
	cases := []struct {
		name  string
		kind  Kind
		mime  string
		known bool
	}{
		{"readme.md", KindMarkdown, "text/markdown", false},
		{"README.MD", KindMarkdown, "text/markdown", false},
		{"doc.pdf", KindPDF, "application/pdf", false},
		{"photo.PNG", KindImage, "image/png", false},
		{"icon.svg", KindImage, "image/svg+xml", false},
		{"main.go", KindText, "text/plain", false},
		{"data.json", KindText, "application/json", false},
		// HTML 预览子资源（P-20261020-4）：css/js 必须按浏览器可消费的 MIME
		// 响应（nosniff 下 text/plain 会被拒绝）；源文件类后缀仍是纯文本
		{"style.css", KindText, "text/css", false},
		{"app.js", KindText, "text/javascript", false},
		{"app.mjs", KindText, "text/javascript", false},
		{"app.cjs", KindText, "text/javascript", false},
		{"theme.scss", KindText, "text/plain", false},
		{"module.ts", KindText, "text/plain", false},
		// 字体：HTML 预览的 @font-face 资源，MIME 必须可辨识（/f/ 另加 CORS）；
		// 已注册 KindInfo=已知格式，进显性化面（known）
		{"font.woff", KindInfo, "font/woff", true},
		{"font.woff2", KindInfo, "font/woff2", true},
		{"font.ttf", KindInfo, "font/ttf", true},
		{"font.otf", KindInfo, "font/otf", true},
		{"clip.mp4", KindVideo, "video/mp4", false},
		{"clip.mov", KindVideo, "video/quicktime", false},
		{"song.mp3", KindAudio, "audio/mpeg", false},
		{"song.ogg", KindAudio, "audio/ogg", false}, // ogg 容器主流是音频
		{"voice.opus", KindAudio, "audio/ogg", false},
		{"media.ogv", KindVideo, "video/ogg", false},
		// csv/tsv：服务端表格渲染
		{"table.csv", KindCSV, "text/csv", false},
		{"data.tsv", KindCSV, "text/tab-separated-values", false},
		{"sub.srt", KindText, "text/plain", false},
		// 办公文档：docx/doc 服务端抽文本预览；xlsx 首表表格预览（P-20261116-5）；
		// xls/ppt/pptx 等已注册信息卡格式进显性化面（P-20261116-5-S2 known）
		{"report.docx", KindDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false},
		{"legacy.doc", KindDocx, "application/msword", false},
		{"data.xlsx", KindSheet, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false},
		{"legacy.xls", KindInfo, "application/vnd.ms-excel", true},
		{"deck.ppt", KindInfo, "application/vnd.ms-powerpoint", true},
		{"deck.pptx", KindInfo, "application/vnd.openxmlformats-officedocument.presentationml.presentation", true},
		// OpenDocument 家族与 epub（P-20261116-5-S2 补注册）：已知格式面，
		// 与未注册后缀的中性兜底区分开
		{"paper.odt", KindInfo, "application/vnd.oasis.opendocument.text", true},
		{"sheet.ods", KindInfo, "application/vnd.oasis.opendocument.spreadsheet", true},
		{"slides.odp", KindInfo, "application/vnd.oasis.opendocument.presentation", true},
		{"book.epub", KindInfo, "application/epub+zip", true},
		{"page.html", KindHTML, "text/html", false},
		{"page.htm", KindHTML, "text/html", false},
		// 未注册后缀/无后缀：信息卡兜底——kind 同为 info 但 known=false
		//（中性卡，不出显性提示）
		{"archive.7z", KindInfo, "application/octet-stream", false},
		{"Makefile", KindText, "text/plain", false},
		{"noext", KindInfo, "application/octet-stream", false},
		// 点开头文件：先整名（.gitignore），再真实后缀——隐藏标记不吞类型
		{".gitignore", KindText, "text/plain", false},
		{".probe-sample.docx", KindDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false},
		{".hidden-unknown", KindInfo, "application/octet-stream", false},
	}
	for _, c := range cases {
		got := ForFile(c.name)
		if got.Kind != c.kind || got.MIME != c.mime || got.Known != c.known {
			t.Errorf("ForFile(%q) = %+v, want kind=%s mime=%s known=%v", c.name, got, c.kind, c.mime, c.known)
		}
	}
}

func TestRegisterExtends(t *testing.T) {
	Register("xyz", Descriptor{Kind: KindText, MIME: "text/plain"})
	if d := ForFile("a.xyz"); d.Kind != KindText {
		t.Fatalf("registered ext not picked up: %+v", d)
	}
	// 运行期覆盖注册：扩展点的升级路径（如 xlsx 接入转换器）
	Register("xlsx", Descriptor{Kind: KindMarkdown, MIME: "text/markdown"})
	if d := ForFile("b.xlsx"); d.Kind != KindMarkdown {
		t.Fatalf("override registration failed: %+v", d)
	}
	t.Cleanup(func() {
		Register("xlsx", Descriptor{Kind: KindSheet, MIME: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})
	})
}

// TestKnownInfoMarking 显性化判定源（P-20261116-5-S2）：Known 只在「已注册
// 且 Kind==KindInfo」时置位——运行期 Register 的 KindInfo 自动进显性化面，
// 同后缀改注册为可预览 Kind 后 Known 收回（升级路径不残留旧标志）
func TestKnownInfoMarking(t *testing.T) {
	const ext = "zz-knowninfo-probe"
	t.Cleanup(func() { Register(ext, Descriptor{Kind: KindInfo, MIME: "application/octet-stream"}) })

	Register(ext, Descriptor{Kind: KindInfo, MIME: "application/octet-stream"})
	if d := ForFile("f." + ext); !d.Known || d.Kind != KindInfo {
		t.Fatalf("registered KindInfo must be Known: %+v", d)
	}
	// 覆盖注册为可预览 Kind：Known 必须收回（判定源是 registry 现值，
	// 不做逐条目标志维护）
	Register(ext, Descriptor{Kind: KindText, MIME: "text/plain"})
	if d := ForFile("f." + ext); d.Known || d.Kind != KindText {
		t.Fatalf("Known must follow registry re-registration: %+v", d)
	}
}
