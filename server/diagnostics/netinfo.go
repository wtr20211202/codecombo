package diagnostics

import (
	"encoding/json"
	"net"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// 网络摘要（P-20261124-1 S3③）：state/net.json 回答「这台机器现在有几个地址、
// 默认路由/ DNS 是谁、TCP 有没有重传/错误堆积、代理环境变量是否把请求带偏」。
//
// 数据源：net.Interfaces（跨平台、无命令）+ Linux /proc/net/{dev,snmp,tcp,tcp6,route}
// （netinfo_linux.go）+ /etc/resolv.conf；非 Linux 只保留接口清单与代理面，
// status 仍为 ok（字段级缺席用 notes 说明，不整段 skipped——补充评审⑪ 的
// 字段级粒度）。代理 URL 只出「scheme://host:port」，userinfo（user:pass）永不入包。

// NetAddress 单个接口地址
type NetAddress struct {
	Iface   string `json:"iface"`
	IP      string `json:"ip"`
	Family  string `json:"family"`
	MTU     int    `json:"mtu,omitempty"`
	Virtual bool   `json:"virtualHint,omitempty"`
}

// IfaceCounters /proc/net/dev 单接口计数（rx 在左、tx 在右）
type IfaceCounters struct {
	RxBytes   int64 `json:"rxBytes"`
	RxErrors  int64 `json:"rxErrors"`
	RxDropped int64 `json:"rxDropped"`
	TxBytes   int64 `json:"txBytes"`
	TxErrors  int64 `json:"txErrors"`
	TxDropped int64 `json:"txDropped"`
}

// NetInfo state/net.json 的结构
type NetInfo struct {
	GeneratedAt  string                   `json:"generatedAt"`
	GOOS         string                   `json:"goos"`
	Status       string                   `json:"status"`
	Reason       string                   `json:"reason,omitempty"`
	Addresses    []NetAddress             `json:"addresses"`
	DefaultRoute string                   `json:"defaultRoute,omitempty"`
	DNS          []string                 `json:"dns,omitempty"`
	TCPStates    map[string]int           `json:"tcpStates,omitempty"`
	TCP          map[string]int64         `json:"tcpCounters,omitempty"`
	Interfaces   map[string]IfaceCounters `json:"interfaces,omitempty"`
	ProxyEnv     map[string]string        `json:"proxyEnv,omitempty"`
	Notes        []string                 `json:"notes,omitempty"`
}

// virtualIfaceHints 虚拟/内部网卡名模式（与 api/system/network.go 同表；
// 只作提示不剔除——vEthernet 可能正是用户可达入口）
var virtualIfaceHints = []string{"vethernet", "wsl", "docker", "virbr", "vmnet", "vmware", "virtualbox"}

// collectNetInfo 采集网络摘要
func collectNetInfo(goos, dataDir string, red *Redactor, now time.Time) NetInfo {
	info := NetInfo{
		GeneratedAt: now.Format(time.RFC3339),
		GOOS:        goos,
		Status:      "ok",
		Addresses:   []NetAddress{},
		ProxyEnv:    map[string]string{},
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		info.Status = "skipped"
		info.Reason = "net.Interfaces failed"
		info.Notes = append(info.Notes, red.Line(err.Error()))
	} else {
		for _, iface := range ifaces {
			if iface.Flags&net.FlagUp == 0 {
				continue
			}
			lower := strings.ToLower(iface.Name)
			virtual := false
			for _, hint := range virtualIfaceHints {
				if strings.Contains(lower, hint) {
					virtual = true
					break
				}
			}
			addrs, aerr := iface.Addrs()
			if aerr != nil {
				continue
			}
			for _, a := range addrs {
				ip, _, perr := net.ParseCIDR(a.String())
				if perr != nil {
					continue
				}
				info.Addresses = append(info.Addresses, NetAddress{
					Iface: iface.Name, IP: ip.String(), Family: familyOf(ip),
					MTU: iface.MTU, Virtual: virtual,
				})
			}
		}
		sort.Slice(info.Addresses, func(i, j int) bool {
			if info.Addresses[i].Iface != info.Addresses[j].Iface {
				return info.Addresses[i].Iface < info.Addresses[j].Iface
			}
			return info.Addresses[i].IP < info.Addresses[j].IP
		})
	}
	if goos == "linux" {
		collectProcNet(&info)
	} else {
		info.Notes = append(info.Notes, "TCP counters / default route / per-interface counters come from /proc/net on Linux only")
	}
	info.DNS = readResolvConf(red)
	info.ProxyEnv = proxyEnvSummary(red)
	if info.ProxyEnv == nil {
		info.ProxyEnv = map[string]string{}
	}
	return info
}

// readResolvConf /etc/resolv.conf 的 nameserver 行（非 Linux/mac 也可能有）
func readResolvConf(red *Redactor) []string {
	text, err := readFileBounded("/etc/resolv.conf")
	if err != nil {
		return nil
	}
	var out []string
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == "nameserver" {
			out = append(out, red.Line(f[1]))
		}
		if len(out) >= 8 {
			break
		}
	}
	return out
}

// proxyEnvSummary 代理环境变量存在性 + 脱敏 host（userinfo 永不入包）
func proxyEnvSummary(red *Redactor) map[string]string {
	keys := []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"}
	out := map[string]string{}
	for _, k := range keys {
		v, ok := os.LookupEnv(k)
		if !ok || strings.TrimSpace(v) == "" {
			continue
		}
		if k == "NO_PROXY" || k == "no_proxy" {
			// NO_PROXY 是域名清单，不含凭据——原样（限长）保留，排障必需
			out[k] = red.Line(truncate(v, 300))
			continue
		}
		u, err := url.Parse(v)
		if err != nil || u.Host == "" {
			out[k] = "(unparsable value — host hidden)"
			continue
		}
		out[k] = u.Scheme + "://" + u.Host
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// familyOf v4/v6
func familyOf(ip net.IP) string {
	if ip.To4() != nil {
		return "v4"
	}
	return "v6"
}

// renderNetJSON state/net.json
func renderNetJSON(n NetInfo) string {
	buf, err := json.MarshalIndent(n, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}
