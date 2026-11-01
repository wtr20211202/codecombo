package share

// 分享预览增强的回归测试：md 相对资源重写、CSV 表格渲染、html base 注入

import (
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRewriteRelativeAssets(t *testing.T) {
	in := `<p><img src="./img/a.png" alt="x"/></p>` +
		`<p><img src="https://cdn.example.com/x.png"/></p>` +
		`<p><img src="data:image/png;base64,AAA"/></p>` +
		// ../ 在分享根内（docs/ 的上一级 = 根）：合法解析并重写
		`<p><img src="../outside.png"/></p>` +
		// 真正越出分享根：解析失败，原样保留（raw 端 404），绝不放宽边界
		`<p><img src="../../evil.png"/></p>` +
		`<p><a href="other.md" target="_blank" rel="nofollow">doc</a></p>` +
		`<p><a href="#sec-1">jump</a></p>` +
		`<p><a href="sub/data.csv">csv</a></p>` +
		`<p><a href="https://example.com/x" target="_blank" rel="nofollow noopener">ext</a></p>`
	out := rewriteRelativeAssets("tok", "docs", in)
	for _, want := range []string{
		`src="/s/tok/raw?path=docs%2Fimg%2Fa.png"`,
		`src="https://cdn.example.com/x.png"`,
		`src="data:image/png;base64,AAA"`,
		`src="/s/tok/raw?path=outside.png"`,
		`src="../../evil.png"`,
		`href="/s/tok?path=docs%2Fother.md"`,
		`href="#sec-1"`,
		`href="/s/tok?path=docs%2Fsub%2Fdata.csv"`,
		// 外链保持原样（含 target）
		`href="https://example.com/x" target="_blank"`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("rewrite output missing %q\nout: %s", want, out)
		}
	}
	// 相对链接重写后不再开新标签（页内导航）；外链 target 不受影响
	if strings.Contains(out, `href="/s/tok?path=docs%2Fother.md" target="_blank"`) {
		t.Fatalf("rewritten nav link should drop target=_blank: %s", out)
	}
}

func TestRenderCSVHTML(t *testing.T) {
	csvData := "name,note\na,\"x,y\"\nb,<script>alert(1)</script>\n"
	out := renderCSVHTML([]byte(csvData), ',')
	for _, want := range []string{
		"<thead><tr><th>name</th><th>note</th></tr></thead>",
		"<td>a</td>", "<td>x,y</td>", // 引号是 CSV 语法，值本身不含引号
		"&lt;script&gt;", // 单元格必须转义
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("csv render missing %q\nout: %s", want, out)
		}
	}
	if strings.Contains(out, "<script>") {
		t.Fatalf("csv cell must not contain raw script: %s", out)
	}
	// 超行数截断：落 data-rows 标记，文案由前端字典补
	var b strings.Builder
	b.WriteString("h\n")
	for i := 0; i < csvMaxDataRows+100; i++ {
		b.WriteString("row\n")
	}
	trunc := renderCSVHTML([]byte(b.String()), ',')
	if !strings.Contains(trunc, `class="doc-note sc-csv-trunc" data-rows="`) {
		t.Fatalf("truncated csv should carry marker: %s", trunc[len(trunc)-200:])
	}
}

func TestInjectHTMLBase(t *testing.T) {
	in := []byte("<!doctype html><HTML><HEAD><title>t</title></HEAD><body></body></html>")
	out := string(injectHTMLBase(in, "/s/tok/f/docs/"))
	if !strings.Contains(out, `<base href="/s/tok/f/docs/">`) {
		t.Fatalf("base not injected: %s", out)
	}
	if strings.Index(out, "<base ") < strings.Index(out, "<title>") {
		// base 必须在其它资源引用之前（head 最前）
	} else {
		t.Fatalf("base should come before head content: %s", out)
	}
	// 无 head：前置注入
	out2 := string(injectHTMLBase([]byte("<p>no head</p>"), "/s/tok/f/"))
	if !strings.HasPrefix(out2, `<base href="/s/tok/f/">`) {
		t.Fatalf("no-head injection broken: %s", out2)
	}
}

// html 预览保真 + 脚本隔离（P-20261020-4）：
//   - /f/ 的 css/js/字体按浏览器可消费的 MIME 响应（nosniff 下 text/plain
//     会让 <link>/<script>/@font-face 全部失效）；字体补 ACAO、其余不放宽
//   - /html 默认 CSP sandbox（脚本全禁），?scripts=1 只加 allow-scripts，
//     绝不出现 allow-same-origin
//   - 单文件 html 分享的边界就是文件本身：meta.share.isDir=false（访客页
//     据此出「外部资源不会随文件生效」提示），同目录子资源 404
func TestHTMLPreviewFidelityMIMEAndScripts(t *testing.T) {
	root := t.TempDir()
	must := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("site/index.html", "<!doctype html><html><head><link rel=stylesheet href=style.css></head><body>hi</body></html>")
	must("site/style.css", "body{color:rgb(12,34,56)}")
	must("site/app.js", "window.__ran=1")
	must("site/font.woff2", "FONTDATA")
	must("site/pic.png", "PNGDATA")

	dirToken := fixedToken("dirtok")
	fileToken := fixedToken("filetok")
	shares := fakeShares{
		dirToken: {Token: dirToken, ProjectID: "p1", ProjectName: "proj", Name: "site", Path: "site", IsDir: true},
		fileToken: {Token: fileToken, ProjectID: "p1", ProjectName: "proj", Name: "index.html",
			Path: "site/index.html", IsDir: false},
	}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	// 外链 CSS / JS：浏览器可消费的 MIME（含 charset），且不放宽 CORS
	// （目录分享的访客路径相对分享根：分享根 = 项目内 site/）
	for _, c := range []struct {
		path, wantCT string
	}{
		{"/f/style.css", "text/css; charset=utf-8"},
		{"/f/app.js", "text/javascript; charset=utf-8"},
		{"/f/pic.png", "image/png"},
	} {
		resp := get(t, srv.URL+"/s/"+dirToken+c.path)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("%s status = %d, body=%s", c.path, resp.StatusCode, body)
		}
		if ct := resp.Header.Get("Content-Type"); ct != c.wantCT {
			t.Errorf("%s Content-Type = %q, want %q", c.path, ct, c.wantCT)
		}
		if acao := resp.Header.Get("Access-Control-Allow-Origin"); acao != "" {
			t.Errorf("%s must not relax CORS (got %q)", c.path, acao)
		}
	}

	// 字体：正确 MIME（不挂 charset）+ ACAO——不透明源下 @font-face 需 CORS
	font := get(t, srv.URL+"/s/"+dirToken+"/f/font.woff2")
	fontBody, _ := io.ReadAll(font.Body)
	font.Body.Close()
	if ct := font.Header.Get("Content-Type"); ct != "font/woff2" {
		t.Errorf("font Content-Type = %q, want font/woff2", ct)
	}
	if acao := font.Header.Get("Access-Control-Allow-Origin"); acao != "*" {
		t.Errorf("font ACAO = %q, want *", acao)
	}
	if !strings.Contains(string(fontBody), "FONTDATA") {
		t.Errorf("font body wrong: %s", fontBody)
	}

	// /html：默认脚本全禁；scripts=1 仅加 allow-scripts（绝不 allow-same-origin）
	def := get(t, srv.URL+"/s/"+dirToken+"/html?path=index.html")
	defBody, _ := io.ReadAll(def.Body)
	def.Body.Close()
	if csp := def.Header.Get("Content-Security-Policy"); csp != "sandbox" {
		t.Errorf("default html CSP = %q, want sandbox", csp)
	}
	if !strings.Contains(string(defBody), `<base href="/s/`+dirToken+`/f/">`) {
		t.Errorf("html base missing: %s", defBody)
	}
	run := get(t, srv.URL+"/s/"+dirToken+"/html?path=index.html&scripts=1")
	_, _ = io.Copy(io.Discard, run.Body)
	run.Body.Close()
	if csp := run.Header.Get("Content-Security-Policy"); csp != "sandbox allow-scripts" {
		t.Errorf("scripts=1 html CSP = %q, want sandbox allow-scripts", csp)
	}

	// 单文件 html：meta 必须表明 isDir=false（访客页据此出单文件提示），
	// 同目录子资源不在分享边界内 → 404
	meta := get(t, srv.URL+"/s/"+fileToken+"/meta")
	metaBody, _ := io.ReadAll(meta.Body)
	meta.Body.Close()
	if !strings.Contains(string(metaBody), `"isDir":false`) {
		t.Errorf("single-file meta must report isDir=false: %s", metaBody)
	}
	if !strings.Contains(string(metaBody), `"kind":"html"`) {
		t.Errorf("single-file meta kind = html: %s", metaBody)
	}
	sibling := get(t, srv.URL+"/s/"+fileToken+"/f/style.css")
	_, _ = io.Copy(io.Discard, sibling.Body)
	sibling.Body.Close()
	if sibling.StatusCode != 404 {
		t.Errorf("single-file sibling asset status = %d, want 404 (boundary = the file)", sibling.StatusCode)
	}
}

// e2e：md 相对图片重写、html base 注入 + /f/ 子资源回源、csv 端到端
func TestPreviewEnhancementsEndToEnd(t *testing.T) {
	root := t.TempDir()
	must := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("docs/readme.md", "# T\n\n![pic](img/a.png)\n\n[data](data.csv)\n")
	must("docs/img/a.png", "PNGDATA")
	must("docs/data.csv", "a,b\n1,2\n")
	must("site/index.html", "<html><head><title>x</title></head><body><link rel=stylesheet href=style.css></body></html>")
	must("site/style.css", "body{color:red}")

	token := fixedToken("tok")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "all",
		Path: "", IsDir: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": root}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	// md 相对图片/链接 → raw / 页内导航
	resp := get(t, srv.URL+"/s/"+token+"/render?path=docs/readme.md")
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "/s/"+token+"/raw?path=docs%2Fimg%2Fa.png") {
		t.Fatalf("md img not rewritten: %s", body)
	}
	if !strings.Contains(string(body), "/s/"+token+"?path=docs%2Fdata.csv") {
		t.Fatalf("md link not rewritten: %s", body)
	}

	// html 预览：base 注入 + 子资源经 /f/ 回源
	resp2 := get(t, srv.URL+"/s/"+token+"/html?path=site/index.html")
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	if !strings.Contains(string(body2), `<base href="/s/`+token+`/f/site/">`) {
		t.Fatalf("html base missing: %s", body2)
	}
	resp3 := get(t, srv.URL+"/s/"+token+"/f/site/style.css")
	defer resp3.Body.Close()
	if resp3.StatusCode != 200 {
		t.Fatalf("f-route subresource status = %d", resp3.StatusCode)
	}
	css, _ := io.ReadAll(resp3.Body)
	if !strings.Contains(string(css), "color:red") {
		t.Fatalf("subresource body wrong: %s", css)
	}
	// /f/ 路由同样不得越过分享根
	esc := get(t, srv.URL+"/s/"+token+"/f/..%2f..%2fsecret.txt")
	_, _ = io.Copy(io.Discard, esc.Body)
	esc.Body.Close()
	if esc.StatusCode == 200 {
		t.Fatal("f-route traversal escaped share root")
	}

	// csv 端到端
	resp4 := get(t, srv.URL+"/s/"+token+"/render?path=docs/data.csv")
	defer resp4.Body.Close()
	body4, _ := io.ReadAll(resp4.Body)
	if !strings.Contains(string(body4), "<thead><tr><th>a</th><th>b</th></tr></thead>") {
		t.Fatalf("csv render broken: %s", body4)
	}
}
