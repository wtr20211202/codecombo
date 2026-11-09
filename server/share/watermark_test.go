package share

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// 溯源水印文案构造回归（P-20261005-193）：名称 + token 尾号 + 日期为常态；
// 名称缺省取 token 前 6 位 + 日期；敏感名称（与分享创建扫描同表）降级纯
// token 尾号——名称不进会随截图二次外传的水印
func TestWatermarkLabel(t *testing.T) {
	now := time.Date(2026, 10, 13, 10, 30, 0, 0, time.Local)
	const token = "abcdef0123456789"

	t.Run("常态：分享名+token尾号+日期", func(t *testing.T) {
		got := WatermarkLabel(&store.Share{Name: "readme.md", Token: token}, now)
		want := "readme.md · …6789 · 2026-10-13"
		if got != want {
			t.Fatalf("WatermarkLabel = %q, want %q", got, want)
		}
	})

	t.Run("名称缺省：token 前 6 位+日期", func(t *testing.T) {
		got := WatermarkLabel(&store.Share{Name: "", Token: token}, now)
		want := "abcdef · 2026-10-13"
		if got != want {
			t.Fatalf("WatermarkLabel = %q, want %q", got, want)
		}
	})

	t.Run("敏感名称降级：纯 token 尾号+日期", func(t *testing.T) {
		want := "…6789 · 2026-10-13"
		if got := WatermarkLabel(&store.Share{Name: ".env.production", Token: token}, now); got != want {
			t.Fatalf("WatermarkLabel = %q, want %q (sensitive name must not enter the watermark)", got, want)
		}
		// 大小写不敏感（IsSensitiveName 同语义）
		if got := WatermarkLabel(&store.Share{Name: "CREDENTIALS.JSON", Token: token}, now); got != want {
			t.Fatalf("WatermarkLabel(case-insensitive) = %q, want %q", got, want)
		}
	})

	t.Run("长名称按 rune 截断", func(t *testing.T) {
		long := strings.Repeat("名", watermarkNameMax+10)
		got := WatermarkLabel(&store.Share{Name: long, Token: token}, now)
		want := strings.Repeat("名", watermarkNameMax) + " · …6789 · 2026-10-13"
		if got != want {
			t.Fatalf("WatermarkLabel = %d runes, want truncated to %d",
				len([]rune(got)), watermarkNameMax)
		}
	})
}

// 三访客页水印接线回归：页面恒携带水印挂载器（脚本/样式）；boot 载荷按
// 开关携带 wm 字段（空串经 omitempty 不落 JSON——未开水印零水印层）
func TestWatermarkBootPayload(t *testing.T) {
	withWm := "名字 · …6789 · 2026-10-13"
	const token = "abcdef0123456789"
	renderShare := func(wm string) string {
		var b strings.Builder
		if err := renderSharePage(&b, token, "zh", wm, false, time.Time{}, time.Time{}, pageMeta{}, false); err != nil {
			t.Fatalf("render share page: %v", err)
		}
		return b.String()
	}

	pages := map[string]struct{ on, off string }{
		"sharePage": {renderShare(withWm), renderShare("")},
		"termPage": func() (p struct{ on, off string }) {
			var a, b strings.Builder
			if err := renderTermPage(&a, token, "zh", "sess", withWm, false, false, false, false); err != nil {
				t.Fatalf("render term page: %v", err)
			}
			if err := renderTermPage(&b, token, "zh", "sess", "", false, false, false, false); err != nil {
				t.Fatalf("render term page: %v", err)
			}
			return struct{ on, off string }{a.String(), b.String()}
		}(),
		"termFrozenPage": func() (p struct{ on, off string }) {
			var a, b strings.Builder
			if err := renderTermFrozenPage(&a, token, "zh", "sess", withWm, false, false); err != nil {
				t.Fatalf("render term frozen page: %v", err)
			}
			if err := renderTermFrozenPage(&b, token, "zh", "sess", "", false, false); err != nil {
				t.Fatalf("render term frozen page: %v", err)
			}
			return struct{ on, off string }{a.String(), b.String()}
		}(),
	}
	for name, page := range pages {
		if !strings.Contains(page.on, `"wm":`) || !strings.Contains(page.on, "名字 · …6789") {
			t.Fatalf("%s: boot payload must carry wm when enabled", name)
		}
		if !strings.Contains(page.on, "sc-wm") {
			t.Fatalf("%s: page must contain watermark mount styles", name)
		}
		if strings.Contains(page.off, `"wm":`) {
			t.Fatalf("%s: boot payload must omit wm when disabled", name)
		}
	}
}
