package share

// 访客页链接元信息（P-20261020-11）：服务端直出 title/description/OG，
// 聊天工具/邮件网关不执行 JS 也能看到文件名与说明；口令/一次性分享
// 必须泛化——任何记录字段都不进入未解锁前的元信息面。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func renderMetaPage(t *testing.T, lang string, meta pageMeta) string {
	t.Helper()
	var b strings.Builder
	if err := renderSharePage(&b, fixedToken("metatok"), lang, "", false, time.Time{}, time.Time{}, meta, false); err != nil {
		t.Fatalf("render share page: %v", err)
	}
	return b.String()
}

func assertContainsAll(t *testing.T, out string, wants []string) {
	t.Helper()
	for _, want := range wants {
		if !strings.Contains(out, want) {
			t.Fatalf("page missing %q\n%s", want, out)
		}
	}
}

// 普通文件/目录/片段：title 直出文件名，description/OG 带项目与类型
func TestSharePageLinkMeta(t *testing.T) {
	file := renderMetaPage(t, "zh", pageMeta{
		Name: "readme.md", ProjectName: "proj", URL: "https://share.example/s/metatok",
	})
	assertContainsAll(t, file, []string{
		`<title>readme.md · 文件分享</title>`,
		`<meta name="description" content="readme.md · 来自项目 proj 的文件分享">`,
		`<meta property="og:title" content="readme.md · 文件分享">`,
		`<meta property="og:description" content="readme.md · 来自项目 proj 的文件分享">`,
		`<meta property="og:type" content="website">`,
		`<meta property="og:site_name" content="Codecombo">`,
		`<meta property="og:url" content="https://share.example/s/metatok">`,
		`<meta name="twitter:card" content="summary">`,
		`<meta name="robots" content="noindex">`,
	})

	dir := renderMetaPage(t, "zh", pageMeta{Name: "docs", ProjectName: "proj", IsDir: true})
	assertContainsAll(t, dir, []string{
		`<title>docs · 文件分享</title>`,
		`docs · 来自项目 proj 的文件夹分享`,
	})

	snippet := renderMetaPage(t, "zh", pageMeta{Name: "panic: quota", Snippet: true})
	assertContainsAll(t, snippet, []string{
		`<title>panic: quota · 文件分享</title>`,
		`文本片段 · panic: quota`,
	})

	en := renderMetaPage(t, "en", pageMeta{Name: "readme.md", ProjectName: "proj"})
	assertContainsAll(t, en, []string{
		`<title>readme.md · File Share</title>`,
		`readme.md · a file shared from project proj`,
	})
}

// 口令/一次性分享：title/description/OG 全部泛化，文件名与项目名零出现
func TestSharePageLinkMetaGenericForProtectedShares(t *testing.T) {
	for _, meta := range []pageMeta{
		{Name: "secret-plan.md", ProjectName: "secret-proj", Sensitive: true},
		{Name: "secret-snippet", Snippet: true, Sensitive: true},
	} {
		out := renderMetaPage(t, "zh", meta)
		if strings.Contains(out, "secret-plan.md") || strings.Contains(out, "secret-proj") ||
			strings.Contains(out, "secret-snippet") {
			t.Fatalf("protected share metadata leaked record fields\n%s", out)
		}
		assertContainsAll(t, out, []string{
			`<title>Codecombo 文件分享</title>`,
			`<meta property="og:title" content="Codecombo 文件分享">`,
			`<meta name="description" content="通过 Codecombo 分享的内容，打开链接查看。">`,
		})
	}
}

// 元信息单行化：控制字符折叠、空白压缩、rune 截断（防超长/多行头）
func TestMetaLine(t *testing.T) {
	if got := metaLine(" a\n\tb  c ", 3); got != "a b…" {
		t.Fatalf("metaLine collapse/truncate = %q, want %q", got, "a b…")
	}
	if got := metaLine("  name  ", 0); got != "name" {
		t.Fatalf("metaLine trim = %q", got)
	}
}

// handler 接线：handlePage 把记录名/项目/og:url 传进模板（渲染层单测之外
// 防「忘传字段」）；口令记录未解锁时仍只出口令页，文件名零出现
func TestSharePageLinkMetaWiring(t *testing.T) {
	tok := fixedToken("meta")
	passTok := fixedToken("pass")
	svc := NewService(fakeShares{
		tok: {
			Token: tok, ProjectID: "p1", ProjectName: "proj",
			Name: "readme.md", Path: "docs/readme.md",
		},
		passTok: {
			Token: passTok, ProjectID: "p1", ProjectName: "proj",
			Name: "secret.md", Path: "docs/secret.md", PassphraseHash: "bcrypt-hash",
		},
	}, fakeRoots{byID: map[string]string{"p1": fixture(t)}}, nil)
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	get := func(path string) string {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("Accept-Language", "zh-CN")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return string(body)
	}

	body := get("/s/" + tok)
	assertContainsAll(t, body, []string{
		`<title>readme.md · 文件分享</title>`,
		`og:url" content="` + srv.URL + `/s/` + tok + `"`,
	})

	// 口令记录未解锁：只出口令页（P-20261006-25 的既有语义），且无文件名
	gate := get("/s/" + passTok)
	if strings.Contains(gate, "secret.md") || strings.Contains(gate, "proj") {
		t.Fatalf("gate page leaked record fields\n%s", gate)
	}
	if strings.Contains(gate, `property="og:title"`) {
		t.Fatalf("gate page must not carry share OG metadata\n%s", gate)
	}
}
