package config

import (
	"strings"
	"testing"
)

func TestNormalizeExternalAccessURL(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "empty disables", in: "", want: ""},
		{name: "spaces only disables", in: "   ", want: ""},
		{name: "https origin", in: "https://nas.example.com", want: "https://nas.example.com"},
		{name: "trailing slash normalized", in: "https://nas.example.com/", want: "https://nas.example.com"},
		{name: "http with port", in: "http://192.168.1.10:9999/", want: "http://192.168.1.10:9999"},
		{name: "trim outer spaces", in: "  https://nas.example.com  ", want: "https://nas.example.com"},
		{name: "ipv6 literal", in: "http://[fd00::1]:8443/", want: "http://[fd00::1]:8443"},
		{name: "default https port dropped", in: "https://nas.example.com:443/", want: "https://nas.example.com"},
		{name: "default http port dropped", in: "http://nas.example.com:80", want: "http://nas.example.com"},
		{name: "scheme and host lowercased", in: "HTTPS://NAS.Example.com/", want: "https://nas.example.com"},
		{name: "credentials rejected", in: "https://user:pass@nas.example.com", wantErr: true},
		{name: "path rejected", in: "https://nas.example.com/app", wantErr: true},
		{name: "query rejected", in: "https://nas.example.com/?token=x", wantErr: true},
		{name: "empty query rejected", in: "https://nas.example.com/?", wantErr: true},
		{name: "fragment rejected", in: "https://nas.example.com/#x", wantErr: true},
		{name: "ftp rejected", in: "ftp://nas.example.com", wantErr: true},
		{name: "missing scheme rejected", in: "nas.example.com", wantErr: true},
		{name: "missing host rejected", in: "https://", wantErr: true},
		{name: "whitespace inside rejected", in: "https://nas example.com", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeExternalAccessURL(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeExternalAccessURLLengthLimit(t *testing.T) {
	long := "https://nas.example.com/" + strings.Repeat("a", MaxExternalAccessURLLength)
	if _, err := NormalizeExternalAccessURL(long); err == nil {
		t.Fatal("expected length limit error")
	}
}

// 分享链接外发基址（P-20261020-2）与 externalAccessUrl 共用同一 origin 规则；
// 单独锁关键形态，防止两处未来分叉（如有人给分享基址放开 path）
func TestNormalizeSharePublicBaseURL(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "empty disables", in: "", want: ""},
		{name: "https origin", in: "https://share.example.com/", want: "https://share.example.com"},
		{name: "http port", in: "http://192.168.1.10:9999", want: "http://192.168.1.10:9999"},
		{name: "default port dropped", in: "https://share.example.com:443", want: "https://share.example.com"},
		{name: "credentials rejected", in: "https://u:p@share.example.com", wantErr: true},
		{name: "path rejected", in: "https://share.example.com/s", wantErr: true},
		{name: "query rejected", in: "https://share.example.com/?x=1", wantErr: true},
		{name: "ftp rejected", in: "ftp://share.example.com", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeSharePublicBaseURL(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
