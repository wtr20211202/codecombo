package system

import (
	"net"
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"
)

// NetworkAddress 单条本机网络地址（GET /api/system/network 出参）。
// 只暴露二维码接力选址所需的最小字段：不返回 MAC/主机名等额外标识
// （单用户自托管形态可接受暴露局域网 IP，但不扩散机器指纹）。
type NetworkAddress struct {
	IP      string `json:"ip"`
	Family  string `json:"family"` // v4 / v6
	Iface   string `json:"iface"`
	Private bool   `json:"private"`
}

// NetworkAddresses GET /api/system/network —— 本机非回环地址清单
// （P-20261019-10，只读，管理面鉴权由全局 api 组中间件承担）。
//
// 动机：二维码接力此前直接编码 window.location.href——桌面端以 localhost
// 打开时，手机扫码指向手机自己的回环地址，必然失败且无提示。前端据本清单
// 在回环入口下自动改用局域网地址；配置了外部访问地址（Tailscale/反代）时
// 以外部地址优先。过滤回环/链路本地/未启用接口，避免给出手机不可达的候选；
// agent 亦可据此自诊断「本实例对局域网/外网暴露哪些地址」。
func NetworkAddresses(c *gin.Context) {
	addresses, err := enumerateNetworkAddresses()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": "network enumeration failed"})
		return
	}
	// 地址随网卡/网络切换变化，禁止中间层缓存（前端每次打开弹窗现读）
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"data": addresses})
}

// enumerateNetworkAddresses 枚举非回环接口地址；非 nil 初值保证空清单序列化
// 为 [] 而非 null（前端免判 null，scheduler 同款惯例）
func enumerateNetworkAddresses() ([]NetworkAddress, error) {
	out := []NetworkAddress{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	for _, iface := range ifaces {
		// 未启用/回环接口整体跳过：docker0/vEthernet 等虚拟网卡若处于 up 态
		// 仍保留其地址（可能正是用户可达入口），不做接口名启发式过滤
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue // 单接口读失败不影响其余候选（权限/瞬态接口错误降级）
		}
		out = append(out, collectNetworkAddresses(iface.Name, addrs, seen)...)
	}
	// 稳定序：v4 优先（手机/局域网最常见），再按接口名与地址字典序——
	// 前端默认取第一项，顺序不可随 net.Interfaces 返回顺序漂移
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Family != out[j].Family {
			return out[i].Family == "v4"
		}
		if out[i].Iface != out[j].Iface {
			return out[i].Iface < out[j].Iface
		}
		return out[i].IP < out[j].IP
	})
	return out, nil
}

// collectNetworkAddresses 单接口地址过滤（纯函数，单测注入伪 net.Addr 用）：
// 跳过手机不可达地址（回环/未指定/链路本地/组播），按 IP 去重跨接口别名。
func collectNetworkAddresses(ifaceName string, addrs []net.Addr, seen map[string]bool) []NetworkAddress {
	out := make([]NetworkAddress, 0, len(addrs))
	for _, addr := range addrs {
		ip := addrIP(addr)
		if ip == nil || !isRelayCandidateIP(ip) {
			continue
		}
		key := ip.String()
		if seen[key] {
			continue // 同一地址挂多接口（tun/bond 别名）只保留首个
		}
		seen[key] = true
		family := "v4"
		if ip.To4() == nil {
			family = "v6"
		}
		out = append(out, NetworkAddress{
			IP:      key,
			Family:  family,
			Iface:   ifaceName,
			Private: isPrivateNetworkIP(ip),
		})
	}
	return out
}

// addrIP 从 net.Addr 取 IP；*net.IPNet（Interface.Addrs 常见形态）与
// *net.IPAddr 都覆盖，未知形态返回 nil
func addrIP(addr net.Addr) net.IP {
	switch a := addr.(type) {
	case *net.IPNet:
		return a.IP
	case *net.IPAddr:
		return a.IP
	default:
		ip := net.ParseIP(addr.String())
		return ip
	}
}

// isRelayCandidateIP 二维码候选过滤：回环/未指定/链路本地/组播都不是
// 手机可达入口；链路本地（169.254/fe80::）与组播尤其会让扫码静默失败
func isRelayCandidateIP(ip net.IP) bool {
	return !ip.IsLoopback() && !ip.IsUnspecified() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast()
}

// isPrivateNetworkIP private 口径：RFC1918 / IPv6 ULA（net.IP.IsPrivate）
// 加上 CGNAT 100.64.0.0/10——Tailscale 等 overlay 网段在此区间，不是公网
// 可路由地址；前端据此把候选徽标标为局域网而非「任意网络可访问」
func isPrivateNetworkIP(ip net.IP) bool {
	if ip.IsPrivate() {
		return true
	}
	v4 := ip.To4()
	return v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
}
