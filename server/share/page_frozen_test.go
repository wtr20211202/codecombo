package share

// 冻结分享访客页的快照时点横幅（P-20261005-168）：frozen 与 live 访客页
// 视觉无差别会让观看者把定格副本当现状用——横幅把「内容快照于创建时刻」
// 诚实声明在分享的唯一消费面。锚点：frozen 渲染含创建时刻的横幅、live 零
// 横幅（含 frozen 标记但时刻异常的防御分支）、双语字典拼装、handler 把
// 记录的 Frozen/CreatedAt 接进模板参数。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func renderFrozenPage(t *testing.T, lang string, frozen bool, at time.Time) string {
	t.Helper()
	var b strings.Builder
	if err := renderSharePage(&b, fixedToken("frozentok"), lang, "", frozen, at, time.Time{}, pageMeta{}, false); err != nil {
		t.Fatalf("render share page: %v", err)
	}
	return b.String()
}

// frozen 记录：横幅出现且携带创建时刻（服务端拼装，不依赖页面 JS 就位）
func TestSharePageFrozenBanner(t *testing.T) {
	at := time.Date(2026, 10, 15, 8, 30, 0, 0, time.Local)
	out := renderFrozenPage(t, "zh", true, at)
	if !strings.Contains(out, `<div class="snap-banner" id="snap-banner">`) {
		t.Fatalf("frozen page must render the snapshot banner element\n%s", out)
	}
	for _, want := range []string{"内容快照于 2026-10-15 08:30", "此后的源项目改动不影响本页"} {
		if !strings.Contains(out, want) {
			t.Fatalf("frozen banner must carry %q\n%s", want, out)
		}
	}
	// 横幅在页面壳内（#app）：JS 重建骨架时会把它插回 header 之下
	appIdx := strings.Index(out, `<div id="app" class="wrap">`)
	bannerIdx := strings.Index(out, `id="snap-banner"`)
	if appIdx < 0 || bannerIdx < appIdx {
		t.Fatalf("banner must live inside #app shell")
	}
}

// live 记录：零横幅（视觉零变化）；frozen 标记但时刻为零值的防御分支同样
// 不出横幅——宁可无声明也不落「快照于 0001-01-01」的破碎文案。断言锚在
// 横幅元素/页面标记而非裸文案：双语字典随 boot 全量下发（live 页也带全键），
// 裸文案会在 JSON 里误中
func TestSharePageLiveNoBanner(t *testing.T) {
	at := time.Date(2026, 10, 15, 8, 30, 0, 0, time.Local)
	for _, tc := range []struct {
		name   string
		frozen bool
		at     time.Time
	}{
		{"live-with-createdAt", false, at},
		{"live-zero", false, time.Time{}},
		{"frozen-flag-zero-time", true, time.Time{}},
	} {
		out := renderFrozenPage(t, "zh", tc.frozen, tc.at)
		if strings.Contains(out, `<div class="snap-banner"`) || strings.Contains(out, ">内容快照于") {
			t.Fatalf("%s: must not render snapshot banner", tc.name)
		}
	}
}

// 双语：横幅文案走 lang 字典（zh/en 各自拼装，时刻占位同格式）
func TestSharePageFrozenBannerBilingual(t *testing.T) {
	at := time.Date(2026, 10, 15, 8, 30, 0, 0, time.Local)
	if out := renderFrozenPage(t, "en", true, at); !strings.Contains(out, "Content snapshot from 2026-10-15 08:30") {
		t.Fatalf("en banner missing\n%s", out)
	}
	if out := renderFrozenPage(t, "zh", true, at); !strings.Contains(out, "内容快照于 2026-10-15 08:30") {
		t.Fatalf("zh banner missing\n%s", out)
	}
}

// handler 接线：handlePage 把记录的 Frozen/CreatedAt 传进模板参数——
// 渲染层单测锚在 renderSharePage，这里防「handler 忘传字段」的静默回退
// （frozen 记录横幅在 / live 记录横幅不在）。Accept-Language 显式钉 zh
// （缺省头会落 en，文案断言跟语言走）
func TestSharePageFrozenBannerWiring(t *testing.T) {
	createdAt := time.Date(2026, 10, 15, 8, 30, 0, 0, time.Local)
	mk := func(frozen bool, token string) *httptest.Server {
		svc := NewService(fakeShares{token: {
			Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
			Path: "docs", IsDir: true, Frozen: frozen, CreatedAt: createdAt,
		}}, fakeRoots{byID: map[string]string{"p1": fixture(t)}}, nil)
		srv := httptest.NewServer(svc.Handler())
		t.Cleanup(srv.Close)
		return srv
	}
	frozenTok, liveTok := fixedToken("fz"), fixedToken("lv")
	get := func(url string) string {
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("Accept-Language", "zh-CN")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", url, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return string(body)
	}

	if body := get(mk(true, frozenTok).URL + "/s/" + frozenTok); !strings.Contains(body, "内容快照于 2026-10-15 08:30") {
		t.Fatalf("frozen record page must carry the snapshot banner\n%s", body)
	}
	if body := get(mk(false, liveTok).URL + "/s/" + liveTok); strings.Contains(body, ">内容快照于") {
		t.Fatalf("live record page must not carry the snapshot banner\n%s", body)
	}
}
