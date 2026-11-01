package sshclient

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"codecombo/server/errmarkers"

	"golang.org/x/crypto/ssh"
)

// 反向隧道预检（P-20261019-11）：把 VPS 侧配置门槛变成可行动错误。
//
// 测试连接按序校验：本机主端口 → SSH 可达 → 主机密钥 TOFU → 认证 →
// 远端端口占用 → tcpip-forward 绑定 → GatewayPorts/防火墙可达性。
// 每一步独立给出原因与修复建议（VPS sshd、防火墙、端口占用），失败不
// 阻断后续无意义步骤。预检用临时监听，结束即释放；Start 不复用预检结果
// （配置可能在测试与启用之间变化），只复用同一拨号/绑定原语。

// ReverseProbeStepIds 预检步骤（稳定 id，前端/agent 可程序化分支）
const (
	ReverseProbeLocalTarget = "local-target"
	ReverseProbeSSH         = "ssh-reachable"
	ReverseProbeHostKey     = "host-key"
	ReverseProbeAuth        = "auth"
	ReverseProbePortFree    = "port-free"
	ReverseProbeForward     = "tcp-forward"
	ReverseProbeGateway     = "gateway-ports"
)

// ReverseProbeOptions 预检参数（与 ReverseSpec 同源字段 + 认证）
type ReverseProbeOptions struct {
	Host            string
	Port            int
	User            string
	Auth            AuthMethod
	SkipHostKeyTOFU bool
	RemoteBindHost  string
	RemotePort      int
	LocalAddr       string
	// Timeout 单步网络超时（<=0 取 5s）
	Timeout time.Duration
}

// ReverseProbeStep 单个预检步骤结果
type ReverseProbeStep struct {
	Step    string `json:"step"`
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
	Hint    string `json:"hint,omitempty"`
}

// ReverseProbeResult 预检总结果
type ReverseProbeResult struct {
	OK                 bool               `json:"ok"`
	Steps              []ReverseProbeStep `json:"steps"`
	HostKeyFingerprint string             `json:"hostKeyFingerprint,omitempty"`
}

func probeStep(id string, ok bool, msg, hint string) ReverseProbeStep {
	return ReverseProbeStep{Step: id, OK: ok, Message: msg, Hint: hint}
}

// ProbeReverseRelay 执行一次完整预检（无副作用：临时监听/连接在返回前释放）
func ProbeReverseRelay(opts ReverseProbeOptions) ReverseProbeResult {
	if opts.Timeout <= 0 {
		opts.Timeout = 5 * time.Second
	}
	res := ReverseProbeResult{Steps: make([]ReverseProbeStep, 0, 7)}
	add := func(s ReverseProbeStep) { res.Steps = append(res.Steps, s) }

	// 1) 本机主端口：隧道最终要落到这里，先排除端口配错/服务未起
	if opts.LocalAddr != "" {
		conn, err := net.DialTimeout("tcp", opts.LocalAddr, 2*time.Second)
		if err != nil {
			add(probeStep(ReverseProbeLocalTarget, false,
				fmt.Sprintf("local service %s is unreachable: %v", opts.LocalAddr, err),
				"确认主服务端口（设置里的服务端口）与本机地址；隧道只转发到本机回环主端口"))
			res.OK = false
			return res
		}
		_ = conn.Close()
		add(probeStep(ReverseProbeLocalTarget, true, "local service reachable: "+opts.LocalAddr, ""))
	}

	addr := net.JoinHostPort(opts.Host, strconv.Itoa(opts.Port))
	// 2) TCP 可达（不认证，避免错误凭据反复撞 sshd fail2ban）
	raw, err := net.DialTimeout("tcp", addr, opts.Timeout)
	if err != nil {
		add(probeStep(ReverseProbeSSH, false,
			fmt.Sprintf("SSH %s is unreachable: %v", addr, err),
			"检查 VPS 地址/SSH 端口、云安全组与防火墙是否放行该端口"))
		res.OK = false
		return res
	}
	_ = raw.Close()
	add(probeStep(ReverseProbeSSH, true, "SSH endpoint reachable: "+addr, ""))

	// 3)+4) 握手：主机密钥 TOFU 与认证在同一次拨号中完成（按错误特征归因）
	var fingerprint string
	hostKeyCB := func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fingerprint = fingerprintOf(key)
		if opts.SkipHostKeyTOFU {
			return nil
		}
		return checkOrPinHostKey(opts.Host, opts.Port, key)
	}
	client, err := Dial(ConnectOptions{
		Host: opts.Host, Port: opts.Port, User: opts.User,
		Auth:            opts.Auth,
		HostKeyCallback: hostKeyCB,
		Timeout:         opts.Timeout,
	})
	if err != nil {
		msg := err.Error()
		switch {
		case strings.Contains(msg, errmarkers.HostKeyChanged):
			add(probeStep(ReverseProbeHostKey, false, msg,
				"VPS 主机密钥已变更（重装/换钥/或中间人）。确认是合法迁移后点「重置主机指纹」，下次连接重新 TOFU；否则不要继续"))
			add(probeStep(ReverseProbeAuth, false, "handshake aborted before authentication", ""))
		case strings.Contains(msg, errmarkers.AuthRejectedPrefix):
			add(probeStep(ReverseProbeHostKey, true, "host key accepted: "+fingerprint, ""))
			add(probeStep(ReverseProbeAuth, false, msg,
				"认证失败：核对用户名、密码/私钥，以及 VPS sshd 是否允许该用户与认证方式（Ubuntu root 默认禁密码登录）"))
		default:
			add(probeStep(ReverseProbeHostKey, false, msg, "SSH 握手失败：检查 VPS sshd 是否正常、协议版本与网络中间设备"))
			add(probeStep(ReverseProbeAuth, false, "handshake failed", ""))
		}
		res.HostKeyFingerprint = fingerprint
		res.OK = false
		return res
	}
	defer client.Close()
	res.HostKeyFingerprint = fingerprint
	add(probeStep(ReverseProbeHostKey, true, "host key accepted: "+fingerprint, ""))
	add(probeStep(ReverseProbeAuth, true, fmt.Sprintf("authenticated as %s", opts.User), ""))

	// 5) 端口占用预检（公网绑定形态才有意义：回环绑定无法从本机远探）。
	// 探测成功即说明已有服务占用该口（或上一轮隧道未释放）——直接报占用；
	// 探测失败不证明端口空闲（可能被防火墙拦截），仅作信息项放行。
	if opts.RemoteBindHost == "" || opts.RemoteBindHost == "0.0.0.0" {
		probeAddr := net.JoinHostPort(opts.Host, strconv.Itoa(opts.RemotePort))
		if c, derr := net.DialTimeout("tcp", probeAddr, 900*time.Millisecond); derr == nil {
			_ = c.Close()
			add(probeStep(ReverseProbePortFree, false,
				fmt.Sprintf("%s already accepts TCP connections", probeAddr),
				"该端口已有服务在监听（可能是上一次隧道未释放或别的程序）：换一个远端端口，或在 VPS 上停掉占用者"))
			res.OK = false
			return res
		}
		add(probeStep(ReverseProbePortFree, true, "no listener answered on the target port (not conclusive)", ""))
	}

	// 6) tcpip-forward 绑定（AllowTcpForwarding / 端口占用都会在这里被拒）
	remoteAddr := net.JoinHostPort(opts.RemoteBindHost, strconv.Itoa(opts.RemotePort))
	ln, err := client.UnderlyingClient().Listen("tcp", remoteAddr)
	if err != nil {
		hint := "sshd 拒绝了远端转发请求：在 VPS /etc/ssh/sshd_config 确认 AllowTcpForwarding yes（改后 systemctl reload sshd），并确认端口未被占用"
		if opts.RemoteBindHost == "0.0.0.0" {
			hint += "；公网绑定还需 GatewayPorts clientspecified（否则只绑回环），或改绑 127.0.0.1 由 nginx 反代"
		}
		add(probeStep(ReverseProbeForward, false, err.Error(), hint))
		res.OK = false
		return res
	}
	add(probeStep(ReverseProbeForward, true, "remote listener established: "+remoteAddr, ""))
	defer func() { _ = ln.Close() }()

	// 7) 公网可达性：0.0.0.0 绑定下从本实例回拨 host:remotePort——能连通
	// 说明 GatewayPorts clientspecified 生效且防火墙放行；失败可能是
	// GatewayPorts=no（绑回环）、云安全组/防火墙拦截，或 VPS 公网 IP 不支持
	// hairpin NAT。全部建议都写进 hint，由用户按 VPS 实际形态处置。
	if opts.RemoteBindHost == "0.0.0.0" {
		probeAddr := net.JoinHostPort(opts.Host, strconv.Itoa(opts.RemotePort))
		// 新监听口到公网可达可能有秒级延迟（WSL 端口转发/云网络），重试 3 次
		var derr error
		for attempt := 0; attempt < 3; attempt++ {
			var c net.Conn
			c, derr = net.DialTimeout("tcp", probeAddr, 2*time.Second)
			if derr == nil {
				_ = c.Close()
				break
			}
			if attempt < 2 {
				time.Sleep(time.Second)
			}
		}
		if derr != nil {
			add(probeStep(ReverseProbeGateway, false,
				fmt.Sprintf("bound, but %s is not reachable from this instance: %v", probeAddr, derr),
				"公网绑定未生效的常见原因：VPS sshd 需 GatewayPorts clientspecified（或改绑 127.0.0.1 + nginx 反代）；云安全组/防火墙需放行该端口；部分 VPS 公网 IP 不支持 hairpin NAT（手机侧仍可能可达，可跳过此项继续）"))
			res.OK = false
			return res
		}
		add(probeStep(ReverseProbeGateway, true, "public bind reachable from this instance", ""))
	} else {
		add(probeStep(ReverseProbeGateway, true, "loopback bind (reverse-proxy mode): public probe skipped", ""))
	}

	res.OK = true
	return res
}
