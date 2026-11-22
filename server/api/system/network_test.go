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

// P-20261119-7：两种排序层各自锚定同表——模式表命中/不命中集合 + 枚举序
// 降权（用户实测：WSL 的 vEthernet 172.26.144.1 数值上小于物理网卡
// 192.168.x，纯数值序会把不可达地址排成默认首项）
func TestIsVirtualIfaceName(t *testing.T) {
	for _, name := range []string{
		"vEthernet (Default Switch)", "vEthernet (WSL)", "WSL", "docker0",
		"virbr0", "vmnet8", "VMware Network Adapter VMnet1",
		"VirtualBox Host-Only Network", "Loopback Pseudo-Interface 1",
	} {
		if !isVirtualIfaceName(name) {
			t.Errorf("%q should be treated as virtual/internal iface", name)
		}
	}
	// Tailscale CGNAT / macOS utun / OpenWrt 物理网桥 / 常规物理网卡一律不降权
	for _, name := range []string{"eth0", "wlan0", "以太网", "tailscale0", "utun3", "br-lan", "en0", "Wi-Fi"} {
		if isVirtualIfaceName(name) {
			t.Errorf("%q should NOT be treated as virtual/internal iface", name)
		}
	}
}

func TestSortNetworkAddresses_VirtualIfaceDemoted(t *testing.T) {
	addrs := []NetworkAddress{
		{IP: "172.26.144.1", Family: "v4", Iface: "vEthernet (WSL (Hyper-V firewall))", Private: true},
		{IP: "172.17.0.1", Family: "v4", Iface: "docker0", Private: true},
		{IP: "192.168.1.50", Family: "v4", Iface: "以太网", Private: true},
		{IP: "fd00::10", Family: "v6", Iface: "以太网", Private: true},
	}
	sortNetworkAddresses(addrs)
	got := make([]string, len(addrs))
	for i, a := range addrs {
		got[i] = a.IP
	}
	// 物理档（v4 先于 v6）整体在前；虚拟档内维持接口名字典序（docker0 < vEthernet）
	want := []string{"192.168.1.50", "fd00::10", "172.17.0.1", "172.26.144.1"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("sorted = %v, want %v (降权不剔除，候选须全部保留)", got, want)
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
	// 排序：虚拟/内部网卡名整体降权排后；同档内 v4 全部在 v6 之前（API 消费者
	// 参考序；分享链接首项由前端 sortRelayCandidates 全量重排决定，本清单不直接
	// 提供默认首项）。注意：虚拟 v4 排在物理 v6 之后是预期形态——降权层优先级
	// 高于族序（P-20261119-7）
	seenVirtual := false
	for _, a := range resp.Data {
		if isVirtualIfaceName(a.Iface) {
			seenVirtual = true
		} else if seenVirtual {
			t.Errorf("physical iface %q appeared after a virtual one; virtual must be demoted as a block", a.Iface)
		}
	}
	for _, virtual := range []bool{false, true} {
		seenV6 := false
		for _, a := range resp.Data {
			if isVirtualIfaceName(a.Iface) != virtual {
				continue
			}
			if a.Family == "v6" {
				seenV6 = true
			} else if seenV6 {
				t.Errorf("v4 address %s (iface %q, virtual=%v) appeared after v6; v4 must come first within each rank", a.IP, a.Iface, virtual)
			}
		}
	}
}
