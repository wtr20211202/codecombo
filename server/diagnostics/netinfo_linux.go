//go:build linux

package diagnostics

import (
	"strconv"
	"strings"
)

// Linux /proc/net 摘要（CONFIG 缺项逐字段缺席，不整段失败）
func collectProcNet(info *NetInfo) {
	if text, err := readFileBounded("/proc/net/dev"); err == nil {
		info.Interfaces = parseProcNetDev(text)
	}
	if text, err := readFileBounded("/proc/net/snmp"); err == nil {
		info.TCP = parseProcNetSnmp(text)
	}
	states := map[string]int{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if text, err := readFileBounded(path); err == nil {
			mergeTCPStates(states, parseProcNetTCPStates(text))
		}
	}
	if len(states) > 0 {
		info.TCPStates = states
	}
	if text, err := readFileBounded("/proc/net/route"); err == nil {
		info.DefaultRoute = parseProcNetRoute(text)
	}
}

// parseProcNetDev /proc/net/dev：两列头部 + iface: rx... tx...
func parseProcNetDev(text string) map[string]IfaceCounters {
	out := map[string]IfaceCounters{}
	for _, line := range strings.Split(text, "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		name := strings.TrimSpace(line[:i])
		f := strings.Fields(line[i+1:])
		if len(f) < 16 {
			continue
		}
		v := make([]int64, 16)
		ok := true
		for j := 0; j < 16; j++ {
			n, err := strconv.ParseInt(f[j], 10, 64)
			if err != nil {
				ok = false
				break
			}
			v[j] = n
		}
		if !ok {
			continue
		}
		out[name] = IfaceCounters{
			RxBytes: v[0], RxErrors: v[2], RxDropped: v[3],
			TxBytes: v[8], TxErrors: v[10], TxDropped: v[11],
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseProcNetSnmp Tcp 段：RetransSegs/InErrs/OutRsts/CurrEstab
func parseProcNetSnmp(text string) map[string]int64 {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	out := map[string]int64{}
	for i := 0; i+1 < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "Tcp:") {
			continue
		}
		headers := strings.Fields(strings.TrimPrefix(lines[i], "Tcp:"))
		values := strings.Fields(strings.TrimPrefix(lines[i+1], "Tcp:"))
		if len(headers) != len(values) {
			break
		}
		for j, h := range headers {
			switch h {
			case "RetransSegs", "InErrs", "OutRsts", "CurrEstab", "InSegs", "OutSegs":
				n, _ := strconv.ParseInt(values[j], 10, 64)
				out[h] = n
			}
		}
		break
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// tcpStateNames /proc/net/tcp 的 st 十六进制码（内核 include/net/tcp_states.h）
var tcpStateNames = map[string]string{
	"01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV", "04": "FIN_WAIT1",
	"05": "FIN_WAIT2", "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT",
	"09": "LAST_ACK", "0A": "LISTEN", "0B": "CLOSING", "0C": "NEW_SYN_RECV",
}

// parseProcNetTCPStates 统计 /proc/net/tcp{,6} 的连接状态（只计数）
func parseProcNetTCPStates(text string) map[string]int {
	out := map[string]int{}
	for i, line := range strings.Split(text, "\n") {
		if i == 0 {
			continue // 表头
		}
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		name := tcpStateNames[strings.ToUpper(f[3])]
		if name == "" {
			name = "UNKNOWN"
		}
		out[name]++
	}
	return out
}

func mergeTCPStates(dst, src map[string]int) {
	for k, v := range src {
		dst[k] += v
	}
}

// parseProcNetRoute 默认路由（Destination=00000000 的最高优先级行）
func parseProcNetRoute(text string) string {
	for i, line := range strings.Split(text, "\n") {
		if i == 0 {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 8 || f[1] != "00000000" {
			continue
		}
		gw := hexLEToIP(f[2])
		if gw == "" {
			return "dev " + f[0]
		}
		return "via " + gw + " dev " + f[0]
	}
	return ""
}

// hexLEToIP /proc/net/route 的网关是小端 8 位十六进制
func hexLEToIP(h string) string {
	if len(h) != 8 {
		return ""
	}
	b := make([]string, 0, 4)
	for i := 6; i >= 0; i -= 2 {
		b = append(b, h[i:i+2])
	}
	octets := make([]int, 4)
	for i, s := range b {
		n, err := strconv.ParseInt(s, 16, 32)
		if err != nil {
			return ""
		}
		octets[i] = int(n)
	}
	return strconv.Itoa(octets[0]) + "." + strconv.Itoa(octets[1]) + "." + strconv.Itoa(octets[2]) + "." + strconv.Itoa(octets[3])
}
