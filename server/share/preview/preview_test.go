package preview

import "testing"

func TestForFileBuiltin(t *testing.T) {
	cases := []struct {
		name string
		kind Kind
		mime string
	}{
		{"readme.md", KindMarkdown, "text/markdown"},
		{"README.MD", KindMarkdown, "text/markdown"},
		{"doc.pdf", KindPDF, "application/pdf"},
		{"photo.PNG", KindImage, "image/png"},
		{"icon.svg", KindImage, "image/svg+xml"},
		{"main.go", KindText, "text/plain"},
		{"data.json", KindText, "application/json"},
		// HTML 预览子资源（P-20261020-4）：css/js 必须按浏览器可消费的 MIME
		// 响应（nosniff 下 text/plain 会被拒绝）；源文件类后缀仍是纯文本
		{"style.css", KindText, "text/css"},
		{"app.js", KindText, "text/javascript"},
		{"app.mjs", KindText, "text/javascript"},
		{"app.cjs", KindText, "text/javascript"},
		{"theme.scss", KindText, "text/plain"},
		{"module.ts", KindText, "text/plain"},
		// 字体：HTML 预览的 @font-face 资源，MIME 必须可辨识（/f/ 另加 CORS）
		{"font.woff", KindInfo, "font/woff"},
		{"font.woff2", KindInfo, "font/woff2"},
		{"font.ttf", KindInfo, "font/ttf"},
		{"font.otf", KindInfo, "font/otf"},
		{"clip.mp4", KindVideo, "video/mp4"},
		{"clip.mov", KindVideo, "video/quicktime"},
		{"song.mp3", KindAudio, "audio/mpeg"},
		{"song.ogg", KindAudio, "audio/ogg"}, // ogg 容器主流是音频
		{"voice.opus", KindAudio, "audio/ogg"},
		{"media.ogv", KindVideo, "video/ogg"},
		// csv/tsv：服务端表格渲染
		{"table.csv", KindCSV, "text/csv"},
		{"data.tsv", KindCSV, "text/tab-separated-values"},
		{"sub.srt", KindText, "text/plain"},
		// 办公文档：docx/doc 服务端抽文本预览；表格类仍信息卡
		{"report.docx", KindDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"legacy.doc", KindDocx, "application/msword"},
		{"page.html", KindHTML, "text/html"},
		{"page.htm", KindHTML, "text/html"},
		// 未注册后缀/无后缀：信息卡兜底
		{"archive.7z", KindInfo, "application/octet-stream"},
		{"Makefile", KindText, "text/plain"},
		{"noext", KindInfo, "application/octet-stream"},
		// 点开头文件：先整名（.gitignore），再真实后缀——隐藏标记不吞类型
		{".gitignore", KindText, "text/plain"},
		{".probe-sample.docx", KindDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{".hidden-unknown", KindInfo, "application/octet-stream"},
	}
	for _, c := range cases {
		got := ForFile(c.name)
		if got.Kind != c.kind || got.MIME != c.mime {
			t.Errorf("ForFile(%q) = %+v, want kind=%s mime=%s", c.name, got, c.kind, c.mime)
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
		Register("xlsx", Descriptor{Kind: KindInfo, MIME: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"})
	})
}
