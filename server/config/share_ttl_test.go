package config

// 分享有效期档位表（P-20261020-5）：单次创建可选 1h/1d/7d/30d，全局默认档
// 只收 permanent/1d/7d/30d；读取端对未配置与脏值（含绕过 PUT 白名单的 1h）
// 一律回落 permanent——存量行为零变化。

import (
	"testing"
	"time"
)

func TestShareTTLDuration(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want time.Duration
		ok   bool
	}{
		{"1h", time.Hour, true},
		{"1d", 24 * time.Hour, true},
		{"7d", 7 * 24 * time.Hour, true},
		{"30d", 30 * 24 * time.Hour, true},
		{" 1d ", 24 * time.Hour, true},
		{"permanent", 0, false},
		{"", 0, false},
		{"2d", 0, false},
	} {
		got, ok := ShareTTLDuration(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Fatalf("ShareTTLDuration(%q) = (%v, %v), want (%v, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestValidShareDefaultTTL(t *testing.T) {
	for _, v := range []string{"", "permanent", "1d", "7d", "30d"} {
		if !ValidShareDefaultTTL(v) {
			t.Fatalf("ValidShareDefaultTTL(%q) = false, want true", v)
		}
	}
	// 1h 只允许单次创建选择；未知值拒绝
	for _, v := range []string{"1h", "2d", "forever"} {
		if ValidShareDefaultTTL(v) {
			t.Fatalf("ValidShareDefaultTTL(%q) = true, want false", v)
		}
	}
}

func TestShareDefaultTTLOrDefault(t *testing.T) {
	for _, tc := range []struct {
		stored string
		want   string
	}{
		{"", "permanent"},
		{"permanent", "permanent"},
		{"1d", "1d"},
		{"7d", "7d"},
		{"30d", "30d"},
		// 手工改配置绕过 PUT 白名单：读取端仍按白名单收敛，1h 不会成为全局默认
		{"1h", "permanent"},
		{"bogus", "permanent"},
	} {
		sc := &ServerConfig{ShareDefaultTTL: tc.stored}
		if got := sc.ShareDefaultTTLOrDefault(); got != tc.want {
			t.Fatalf("ShareDefaultTTLOrDefault(%q) = %q, want %q", tc.stored, got, tc.want)
		}
	}
}
