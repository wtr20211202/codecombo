package share

// 冻结分享访客页的快照时点声明（P-20261005-168；P-20261111-5 起与有效期
// 声明合并为单行紧凑状态条）：frozen 与 live 访客页视觉无差别会让观看者把
// 定格副本当现状用——状态条把「内容快照于创建时刻」诚实声明在分享的唯一
// 消费面（条上紧凑短文案 + 悬停 title 全句）。锚点：frozen 渲染含创建时刻
// 的紧凑段与全句 title、live 零渲染（含 frozen 标记但时刻异常的防御分支）、
// 快照×过期双段拼装、双语字典拼装、handler 把记录的 Frozen/CreatedAt 接进
// 模板参数。

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

// frozen 记录：状态条出现且条上带创建时刻短文案、悬停 title 带完整长句
// （服务端拼装，不依赖页面 JS 就位）
func TestSharePageFrozenBanner(t *testing.T) {
	at := time.Date(2026, 10, 15, 8, 30, 0, 0, time.Local)
	out := renderFrozenPage(t, "zh", true, at)
	if !strings.Contains(out, `<div class="status-banner" id="status-banner" title="`) {
		t.Fatalf("frozen page must render the compact status bar element\n%s", out)
	}
	for _, want := range []string{"快照 2026-10-15 08:30", "此后的源项目改动不影响本页"} {
		if !strings.Contains(out, want) {
			t.Fatalf("status bar must carry %q\n%s", want, out)
		}
	}
	// 状态条在页面壳内（#app）：JS 重建骨架时会把它插回 header 之下
	appIdx := strings.Index(out, `<div id="app" class="wrap">`)
	barIdx := strings.Index(out, `id="status-banner"`)
	if appIdx < 0 || barIdx < appIdx {
		t.Fatalf("status bar must live inside #app shell")
	}
}

// 快照×过期双段都在（frozen 记录带 30 天默认档的常规形态）：单行拼装为
// 「快照 {t} · {t} 过期」，悬停 title 两句全句齐备；永久 frozen（无过期）
// 只显快照段不出「 · 」过期尾巴
func TestSharePageFrozenCompactBarJoinedSegments(t *testing.T) {
	at := time.Date(2026, 10, 15, 8, 30, 0, 0, time.Local)
	exp := time.Date(2026, 12, 11, 18, 6, 0, 0, time.Local)
	var b strings.Builder
	if err := renderSharePage(&b, fixedToken("joinedtok"), "zh", "", true, at, exp, pageMeta{}, false); err != nil {
		t.Fatalf("render share page: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		">快照 2026-10-15 08:30 · 2026-12-11 18:06 过期</span>",
		`title="内容快照于 2026-10-15 08:30——此后的源项目改动不影响本页；此链接将于 2026-12-11 18:06 过期"`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("joined status bar must carry %q\n%s", want, out)
		}
	}
	// 永久 frozen：条上只有快照段，无「 · 」过期尾巴
	if out := renderFrozenPage(t, "zh", true, at); strings.Contains(out, " · 2026-") || strings.Contains(out, "过期</span>") {
		t.Fatalf("permanent frozen bar must show only the snapshot segment\n%s", out)
	}
}

// live 记录：零状态条（视觉零变化）；frozen 标记但时刻为零值的防御分支同样
// 不出条——宁可无声明也不落「快照于 0001-01-01」的破碎文案。断言锚在状态条
// 元素/页面标记而非裸文案：双语字典随 boot 全量下发（live 页也带全键），
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
		if strings.Contains(out, `<div class="status-banner"`) || strings.Contains(out, `title="内容快照于`) {
			t.Fatalf("%s: must not render snapshot status bar", tc.name)
		}
	}
}

// 双语：状态条文案走 lang 字典（zh/en 各自拼装，时刻占位同格式）；条上
// 短文案与悬停 title 全句分层断言
func TestSharePageFrozenBannerBilingual(t *testing.T) {
	at := time.Date(2026, 10, 15, 8, 30, 0, 0, time.Local)
	if out := renderFrozenPage(t, "en", true, at); !strings.Contains(out, "Snapshot 2026-10-15 08:30") ||
		!strings.Contains(out, `title="Content snapshot from 2026-10-15 08:30`) {
		t.Fatalf("en status bar missing\n%s", out)
	}
	if out := renderFrozenPage(t, "zh", true, at); !strings.Contains(out, "快照 2026-10-15 08:30") ||
		!strings.Contains(out, `title="内容快照于 2026-10-15 08:30`) {
		t.Fatalf("zh status bar missing\n%s", out)
	}
}

// handler 接线：handlePage 把记录的 Frozen/CreatedAt 传进模板参数——
// 渲染层单测锚在 renderSharePage，这里防「handler 忘传字段」的静默回退
// （frozen 记录状态条在 / live 记录状态条不在）。Accept-Language 显式钉 zh
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

	if body := get(mk(true, frozenTok).URL + "/s/" + frozenTok); !strings.Contains(body, "快照 2026-10-15 08:30") {
		t.Fatalf("frozen record page must carry the snapshot status bar\n%s", body)
	}
	if body := get(mk(false, liveTok).URL + "/s/" + liveTok); strings.Contains(body, `title="内容快照于`) {
		t.Fatalf("live record page must not carry the snapshot status bar\n%s", body)
	}
}
