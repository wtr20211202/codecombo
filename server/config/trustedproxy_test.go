package config

import (
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"testing"
)

func TestNormalizeTrustedProxies(t *testing.T) {
	got, err := NormalizeTrustedProxies([]string{" 127.0.0.1 ", "", "::1", "127.0.0.1", "10.0.0.0/8"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"127.0.0.1", "::1", "10.0.0.0/8"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("normalized = %v, want %v", got, want)
	}
}

func TestNormalizeTrustedProxies_RejectsInvalid(t *testing.T) {
	for _, in := range [][]string{
		{"not-an-ip"},
		{"127.0.0.1/99"},
		{"10.0.0.0/not-a-mask"},
		{strings.Repeat("a", MaxTrustedProxyEntryLength+1)},
	} {
		if _, err := NormalizeTrustedProxies(in); err == nil {
			t.Fatalf("entries %v: expected validation error", in)
		}
	}
	tooMany := make([]string, 0, MaxTrustedProxies+1)
	for i := 0; i <= MaxTrustedProxies; i++ {
		tooMany = append(tooMany, "10.0."+strconv.Itoa(i)+".1")
	}
	if _, err := NormalizeTrustedProxies(tooMany); err == nil {
		t.Fatalf("expected too-many error for %d entries", len(tooMany))
	}
}

func TestParseTrustedProxies_Trusts(t *testing.T) {
	set, err := ParseTrustedProxies([]string{"127.0.0.1", "::1", "192.0.2.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		ip   string
		want bool
	}{
		{"127.0.0.1", true},
		{"::1", true},
		{"192.0.2.55", true},
		{"192.0.3.1", false},
		{"203.0.113.9", false},
		{"::ffff:127.0.0.1", true}, // IPv4-mapped IPv6 按 IPv4 处理
	}
	for _, tc := range cases {
		if got := set.Trusts(net.ParseIP(tc.ip)); got != tc.want {
			t.Fatalf("Trusts(%s) = %v, want %v", tc.ip, got, tc.want)
		}
	}
	if set.Len() != 3 {
		t.Fatalf("Len() = %d, want 3", set.Len())
	}
}

func TestTrustedProxySet_EmptyAndNil(t *testing.T) {
	if (*TrustedProxySet)(nil).Trusts(net.ParseIP("127.0.0.1")) {
		t.Fatal("nil set must not trust anything")
	}
	set, err := ParseTrustedProxies(nil)
	if err != nil {
		t.Fatal(err)
	}
	if set.Trusts(net.ParseIP("127.0.0.1")) || set.Len() != 0 {
		t.Fatal("empty set must not trust anything")
	}
}

// TestServerConfig_TrustedProxiesJSONRoundTrip 盘面三态契约（P-20261020-1）：
// 缺键 → nil（回落 config.json）；显式 [] → 非 nil 空切片（显式不信任，
// 优先级高于 config.json）；有值 → 原样读回。字段刻意无 omitempty，
// 否则显式清空会在保存时被省略、重启后又被 config.json 旧值顶回来
func TestServerConfig_TrustedProxiesJSONRoundTrip(t *testing.T) {
	var missing ServerConfig
	if err := json.Unmarshal([]byte(`{}`), &missing); err != nil {
		t.Fatal(err)
	}
	if missing.TrustedProxies != nil {
		t.Fatalf("missing key should unmarshal to nil, got %#v", missing.TrustedProxies)
	}

	var empty ServerConfig
	if err := json.Unmarshal([]byte(`{"trustedProxies":[]}`), &empty); err != nil {
		t.Fatal(err)
	}
	if empty.TrustedProxies == nil || len(empty.TrustedProxies) != 0 {
		t.Fatalf("explicit [] should unmarshal to non-nil empty, got %#v", empty.TrustedProxies)
	}
	raw, err := json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"trustedProxies":[]`) {
		t.Fatalf("explicit empty must persist as [], got %s", raw)
	}

	var value ServerConfig
	if err := json.Unmarshal([]byte(`{"trustedProxies":["127.0.0.1","::1"]}`), &value); err != nil {
		t.Fatal(err)
	}
	if strings.Join(value.TrustedProxies, "|") != "127.0.0.1|::1" {
		t.Fatalf("value round-trip = %v", value.TrustedProxies)
	}
}
