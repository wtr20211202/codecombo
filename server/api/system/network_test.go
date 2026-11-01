package system

import (
	"encoding/json"
	"net"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func ipNet(ip string) net.Addr {
	return &net.IPNet{IP: net.ParseIP(ip), Mask: net.CIDRMask(24, 32)}
}

func TestCollectNetworkAddresses_FiltersAndClassifies(t *testing.T) {
	seen := map[string]bool{}
	addrs := []net.Addr{
		ipNet("127.0.0.1"),       // 回环
		ipNet("0.0.0.0"),         // 未指定
		ipNet("169.254.10.20"),   // IPv4 链路本地
		ipNet("224.0.0.1"),       // 组播
		ipNet("fe80::1"),         // IPv6 链路本地
		ipNet("::1"),             // IPv6 回环
		ipNet("192.168.1.5"),     // LAN
		ipNet("10.1.2.3"),        // LAN
		ipNet("100.101.102.103"), // Tailscale CGNAT
		ipNet("8.8.8.8"),         // 公网
		ipNet("fd00::10"),        // IPv6 ULA
	}
	got := collectNetworkAddresses("eth0", addrs, seen)

	byIP := map[string]NetworkAddress{}
	for _, a := range got {
		byIP[a.IP] = a
	}
	for _, excluded := range []string{"127.0.0.1", "0.0.0.0", "169.254.10.20", "224.0.0.1", "fe80::1", "::1"} {
		if _, ok := byIP[excluded]; ok {
			t.Errorf("address %s should be filtered out", excluded)
		}
	}
	checks := []struct {
		ip      string
		family  string
		private bool
	}{
		{"192.168.1.5", "v4", true},
		{"10.1.2.3", "v4", true},
		{"100.101.102.103", "v4", true},
		{"8.8.8.8", "v4", false},
		{"fd00::10", "v6", true},
	}
	if len(got) != len(checks) {
		t.Fatalf("got %d addresses, want %d: %+v", len(got), len(checks), got)
	}
	for _, c := range checks {
		a, ok := byIP[c.ip]
		if !ok {
			t.Errorf("missing %s", c.ip)
			continue
		}
		if a.Family != c.family || a.Private != c.private || a.Iface != "eth0" {
			t.Errorf("%s = %+v, want family=%s private=%v iface=eth0", c.ip, a, c.family, c.private)
		}
	}
}

func TestCollectNetworkAddresses_DedupesSameIPAcrossInterfaces(t *testing.T) {
	seen := map[string]bool{}
	first := collectNetworkAddresses("eth0", []net.Addr{ipNet("192.168.1.5")}, seen)
	second := collectNetworkAddresses("eth1", []net.Addr{ipNet("192.168.1.5")}, seen)
	if len(first) != 1 || len(second) != 0 {
		t.Fatalf("expected first interface to win, got first=%+v second=%+v", first, second)
	}
}

func TestNetworkAddresses_ResponseShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/system/network", NetworkAddresses)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/system/network", nil)
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	// 隐私边界：只出选址字段，不扩散 MAC/主机名
	for _, forbidden := range []string{`"mac"`, `"hardwareAddr"`, `"hostname"`} {
		if strings.Contains(body, forbidden) {
			t.Errorf("response must not contain %s: %s", forbidden, body)
		}
	}
	var resp struct {
		Data []NetworkAddress `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not json: %v body=%s", err, body)
	}
	if resp.Data == nil {
		t.Fatalf("data must be an array (not null): %s", body)
	}
	for _, a := range resp.Data {
		if a.IP == "" || a.Iface == "" || (a.Family != "v4" && a.Family != "v6") {
			t.Errorf("invalid address entry: %+v", a)
		}
		if ip := net.ParseIP(a.IP); ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			t.Errorf("entry must be a usable non-loopback address: %+v", a)
		}
	}
	// 排序：v4 全部在 v6 之前（前端默认取第一项）
	seenV6 := false
	for _, a := range resp.Data {
		if a.Family == "v6" {
			seenV6 = true
		} else if seenV6 {
			t.Errorf("v4 address %s appeared after v6; ordering must be v4 first", a.IP)
		}
	}
}
