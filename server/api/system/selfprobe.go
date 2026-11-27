package system

import (
	"net"
	"strconv"
	"strings"
	"time"
)

// 自连接探测（P-20261124-1 S3③）：state/self-probe.json 回答「实例绑定的
// 地址本机连得上吗」——反代/防火墙/端口漂移类故障里，服务端能自证监听面。
//
// 纪律（评审②⑦）：
//   - 复用 /api/system/network 的地址清单（enumerateNetworkAddresses），不重造
//     枚举逻辑；
//   - 只做 1s TCP 握手：不校验证书、不暗示外部路由可达——标签
//     tcpReachabilityOnly 写进每个结果；
//   - IPv6 link-local（fe80::/10）跳过：带 zone 的地址跨进程 connect 语义
//     不稳定，连不上也不构成故障；
//   - 只在 deep 模式跑（?deep=1）：单次探测最坏 ~1s × N 地址，默认包零回归。

const (
	// selfProbeTimeout 单地址 TCP 探测超时
	selfProbeTimeout = 1 * time.Second
	// selfProbeLabel 结果标签（禁止被读成「证书/外部路由已验证」）
	selfProbeLabel = "tcpReachabilityOnly"
)

// SelfProbeResult 单地址探测结果
type SelfProbeResult struct {
	Address string `json:"address"`
	Label   string `json:"label"`
	// Status ok | failed | skipped
	Status string `json:"status"`
	RTTms  int64  `json:"rttMs,omitempty"`
	Error  string `json:"error,omitempty"`
}

// SelfProbeDoc state/self-probe.json 的结构
type SelfProbeDoc struct {
	GeneratedAt string            `json:"generatedAt"`
	Status      string            `json:"status"`
	Reason      string            `json:"reason,omitempty"`
	BindHost    string            `json:"bindHost,omitempty"`
	Port        int               `json:"port,omitempty"`
	TLSEnabled  bool              `json:"tlsEnabled"`
	Label       string            `json:"label"`
	Results     []SelfProbeResult `json:"results"`
	Note        string            `json:"note"`
}

// runSelfProbe 对实例绑定面做 TCP 可达性探测（host 为监听 host，port 为主端口）
func runSelfProbe(bindHost string, port int, tlsOn bool) any {
	doc := SelfProbeDoc{
		GeneratedAt: time.Now().Format(time.RFC3339),
		Status:      "ok",
		BindHost:    bindHost,
		Port:        port,
		TLSEnabled:  tlsOn,
		Label:       selfProbeLabel,
		Results:     []SelfProbeResult{},
		Note:        "TCP connect only (1s): proves a listener accepts connections. It does NOT validate certificates, TLS versions, DNS, or external routing.",
	}
	if port <= 0 {
		doc.Status = "skipped"
		doc.Reason = "listening port unknown to the diagnostics bridge"
		return doc
	}
	addresses := selfProbeAddresses(bindHost, port)
	if len(addresses) == 0 {
		doc.Status = "skipped"
		doc.Reason = "no probeable address (wildcard bind with no non-loopback interface?)"
		return doc
	}
	for _, addr := range addresses {
		res := SelfProbeResult{Address: addr, Label: selfProbeLabel}
		start := time.Now()
		conn, err := net.DialTimeout("tcp", addr, selfProbeTimeout)
		if err != nil {
			res.Status = "failed"
			res.Error = classifyDialError(err)
		} else {
			_ = conn.Close()
			res.Status = "ok"
			res.RTTms = time.Since(start).Milliseconds()
		}
		doc.Results = append(doc.Results, res)
	}
	return doc
}

// selfProbeAddresses 探测清单：回环（127.0.0.1 / ::1）+ 绑定通配时的非回环地址；
// 显式绑定单地址时只探测该地址。IPv6 link-local 一律跳过。
func selfProbeAddresses(bindHost string, port int) []string {
	portStr := strconv.Itoa(port)
	seen := map[string]bool{}
	var out []string
	add := func(ip string) {
		parsed := net.ParseIP(ip)
		if parsed == nil || parsed.IsLinkLocalUnicast() || seen[ip] {
			return
		}
		seen[ip] = true
		out = append(out, net.JoinHostPort(ip, portStr))
	}
	add("127.0.0.1")
	add("::1")
	host := strings.ToLower(strings.TrimSpace(bindHost))
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" || host == "localhost" {
		if addresses, err := enumerateNetworkAddresses(); err == nil {
			for _, a := range addresses {
				add(a.IP)
			}
		}
		return out
	}
	add(strings.Trim(host, "[]"))
	return out
}

// classifyDialError 连接错误分类（不带远端原文——地址已在结果里，错误只留类别）
func classifyDialError(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "connection refused"):
		return "connection refused"
	case strings.Contains(msg, "timeout") || strings.Contains(msg, "timed out"):
		return "timeout"
	case strings.Contains(msg, "no route to host"):
		return "no route to host"
	case strings.Contains(msg, "network is unreachable"):
		return "network unreachable"
	default:
		return "dial error"
	}
}
