package config

import (
	"reflect"
	"strconv"
	"testing"
)

// 入站 Hook URL 动作允许域清单（P-20261003-164）：形态校验/归一口径/上限。

func TestNormalizeHookURLAllowHosts(t *testing.T) {
	cases := []struct {
		name    string
		in      []string
		want    []string
		wantErr bool
	}{
		{"empty", nil, []string{}, false},
		{"blank entries dropped", []string{"", "  "}, []string{}, false},
		{"plain host", []string{"ci.example.com"}, []string{"ci.example.com"}, false},
		// trim + 大小写归一（匹配口径 Hostname 小写）
		{"trim and lowercase", []string{"  CI.Example.COM "}, []string{"ci.example.com"}, false},
		// 带端口条目归一为 hostname（清单语义=信任主机，端口不限）
		{"port stripped", []string{"ci.example.com:8443"}, []string{"ci.example.com"}, false},
		{"dedup after port strip", []string{"ci.example.com", "ci.example.com:8080"}, []string{"ci.example.com"}, false},
		{"ipv6 literal", []string{"[::1]:8080"}, []string{"::1"}, false},
		// 拒绝：非纯 host 形态
		{"path rejected", []string{"ci.example.com/build"}, nil, true},
		{"query rejected", []string{"ci.example.com?x=1"}, nil, true},
		{"userinfo rejected", []string{"user@ci.example.com"}, nil, true},
		{"scheme rejected", []string{"https://ci.example.com"}, nil, true},
		{"wildcard rejected", []string{"*.example.com"}, nil, true},
		{"bare port rejected", []string{":8080"}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeHookURLAllowHosts(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestNormalizeHookURLAllowHostsLimits(t *testing.T) {
	long := make([]byte, MaxHookURLAllowHostLength+1)
	for i := range long {
		long[i] = 'a'
	}
	if _, err := NormalizeHookURLAllowHosts([]string{string(long)}); err == nil {
		t.Fatal("overlong entry must be rejected")
	}

	many := make([]string, 0, MaxHookURLAllowHosts+1)
	for i := 0; i <= MaxHookURLAllowHosts; i++ {
		many = append(many, "host"+string(rune('a'+i%26))+"-"+strconv.Itoa(i)+".example.com")
	}
	if _, err := NormalizeHookURLAllowHosts(many); err == nil {
		t.Fatal("over-limit list must be rejected")
	}
}
