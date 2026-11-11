// 系统代理探测（P-20261110-1 S5，能力层）：只读地取当前用户的桌面系统静态代理，
// 归一为更新链出站可直接使用的代理 URL——补「系统开着代理（本机 Clash 类）但既没
// 设 env 也没填设置项，更新链照走直连失败」的探测档。本层只交付探测能力，对外唯一
// 入口 DetectSystemProxy；开关、出站档序接入、探测挂点与原子快照、NO_PROXY 语义、
// 状态端点属后续步骤（S6）。
//
// 分层：平台分支（sysproxy_{windows,darwin,linux}.go）只负责只读地取原始配置——
// Windows 读 HKCU Internet Settings 注册表（QUERY_VALUE）、macOS 执行
// scutil --proxy、Linux 执行 gsettings（GNOME，尽力而为）；三种原始形态的解析、
// 档位选择、scheme 归一与校验全在本文件平台无关实现，任一平台单测都跑全三套夹具
// （注册表值 / scutil 输出 / gsettings 输出文本），不依赖开发机真实代理状态。
//
// 定案：
//   - 无 scheme 的 host:port（注册表常态）补 http:// 而非 https://——本机 Clash 类
//     代理端口是明文 HTTP CONNECT、不做 TLS，补 https 则代理握手必败；分协议键
//     https= 表示「哪类目标走它」而非代理自身协议，同样补 http://；
//   - socks 档（注册表 socks=、scutil SOCKS*、gsettings socks）归 socks5——Go
//     net/http 只会 SOCKS5，Clash 类混合端口同时接受；
//   - 档序（更新链目标全是 https）：全协议档（Windows 无键裸串）> https 档 >
//     http 档 > socks 档。http 档兜底是刻意的务实取舍：系统原生语义下 https 目标
//     缺 https 档会落 socks/直连，但用户既配了 HTTP 代理，CONNECT 隧道是 https 过
//     HTTP 代理的通用路径；socks 垫底因 WinINet 的 socks= 历史上指 SOCKS4，映射
//     socks5 是最不确定的一档；
//   - 只认静态代理：PAC/WPAD（注册表 AutoConfigURL、scutil ProxyAutoConfig*、
//     GNOME mode 'auto'）需脚本求值，视为未配置；系统层绕行清单（ProxyOverride /
//     ExceptionsList / ignore-hosts）不读，NO_PROXY 语义归选路层；GNOME 代理认证
//     字段不读（认证代理请用显式设置项）。
//
// 降级语义（硬约束）：探测失败 / 超时（2s 短超时）/ 配置值畸形 / 校验不过一律
// 「本档无代理」，调用方静默落下一档；err 仅供诊断（日志/状态端点），不作为更新
// 失败冒泡；错误文本刻意不回显原始配置值（ProxyServer 串可能内嵌凭据，gsettings
// 输出含认证字段）。
package update

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 探测来源标识（稳定机读值：状态端点/日志据此区分探测机制，前端映射文案）
const (
	SystemProxySourceWindowsRegistry = "windows-registry"
	SystemProxySourceMacOSScutil     = "macos-scutil"
	SystemProxySourceGnomeGsettings  = "gnome-gsettings"
)

// sysProxyDetectTimeout 探测短超时：探测是出站前的辅助判断，不能拖住更新检查——
// 子进程挂住（无会话总线、家目录 dconf 读卡顿等）时到点放弃，落下一档
const sysProxyDetectTimeout = 2 * time.Second

// probeCommandWaitDelay 子进程被 ctx 杀掉后等 stdout 管道关闭的上限：孙进程继承
// 管道会让 Wait 迟迟不返回（exec.Cmd.WaitDelay 语义）
const probeCommandWaitDelay = 500 * time.Millisecond

// gnomeProxySchema GNOME 系统代理 schema（子 schema .http/.https/.socks 随
// list-recursively 一并列出）
const gnomeProxySchema = "org.gnome.system.proxy"

var (
	// ErrSystemProxyUnsupported 当前平台无探测实现（产品承诺 win/mac/linux 之外的 GOOS）
	ErrSystemProxyUnsupported = errors.New("system proxy detection unsupported on this platform")
	// ErrSystemProxyMalformed 系统代理配置值畸形或未过代理地址同规校验
	ErrSystemProxyMalformed = errors.New("system proxy setting is malformed")
)

// sysProxyProbe 单平台探测器：source 为探测机制标识；probe 取原始配置并解析出
// 候选代理串（未校验；"" = 未配置静态代理）。生产实例由平台分支
// platformSysProxyProbe 装配，测试以夹具读取器装配同一组合
type sysProxyProbe struct {
	source string
	probe  func(ctx context.Context) (candidate string, err error)
}

// DetectSystemProxy 探测当前用户的系统代理（只读，不改任何系统设置）。返回：
//   - proxyURL 非空：已启用静态代理，值为 NormalizeProxyURL 归一形态（可直接交
//     SetOutbound 同款解析；可能含 userinfo，入日志前须脱敏）；
//   - proxyURL 空且 err == nil：系统未启用静态代理（含 ProxyEnable=0、PAC-only）；
//   - err != nil：探测失败 / 超时（errors.Is context.DeadlineExceeded）/ 配置畸形
//     （ErrSystemProxyMalformed）/ 平台不支持（ErrSystemProxyUnsupported）——调用方
//     一律按「本档无代理」静默落下一档，不得冒泡为更新失败。
//
// source 恒为本平台探测机制标识（SystemProxySource*；不支持的平台为空串）。
// 每次调用都是一次真实探测（注册表读 / 子进程），2s 内必返回，并发安全；不要在
// 请求热路径逐请求调用——由挂点探测后快照复用
func DetectSystemProxy(ctx context.Context) (proxyURL, source string, err error) {
	return detectSystemProxyWith(ctx, platformSysProxyProbe(), sysProxyDetectTimeout)
}

// detectSystemProxyWith 探测编排（超时 / 故障隔离 / 归一校验单点）：读取器在独立
// goroutine 跑，到点即返回——不依赖读取器自身尊重 ctx（注册表读这类同步调用无
// 取消点）；读取器 panic 被收住转错误，畸形配置值触发的解析缺陷不传染主进程
func detectSystemProxyWith(ctx context.Context, p sysProxyProbe, timeout time.Duration) (string, string, error) {
	if p.probe == nil {
		return "", p.source, ErrSystemProxyUnsupported
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	type outcome struct {
		candidate string
		err       error
	}
	// 缓冲 1：超时先返回后，迟到的读取器结果写入即弃，goroutine 不因无人接收而泄漏
	done := make(chan outcome, 1)
	go func() {
		var o outcome
		defer func() {
			if r := recover(); r != nil {
				o = outcome{err: fmt.Errorf("system proxy detection: internal error: %v", r)}
			}
			done <- o
		}()
		o.candidate, o.err = p.probe(ctx)
	}()

	select {
	case o := <-done:
		if o.err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				// 读取器因 ctx 到期而失败（子进程被杀）：与超时同口径，诊断一致
				return "", p.source, fmt.Errorf("system proxy detection: %w", ctxErr)
			}
			return "", p.source, o.err
		}
		if o.candidate == "" {
			return "", p.source, nil
		}
		u, err := normalizeSystemProxy(o.candidate)
		if err != nil {
			return "", p.source, err
		}
		return u, p.source, nil
	case <-ctx.Done():
		return "", p.source, fmt.Errorf("system proxy detection: %w", ctx.Err())
	}
}

// normalizeSystemProxy 候选串 → 出站可用代理 URL：socks scheme 归 socks5、容忍
// 结尾单斜杠，再过 NormalizeProxyURL 同规校验（scheme 白名单 / 无路径 / 端口范围 /
// 缺端口补默认）。错误不回显原值（可能内嵌凭据），只带 scheme 供诊断
func normalizeSystemProxy(candidate string) (string, error) {
	u, err := url.Parse(candidate)
	if err != nil {
		return "", fmt.Errorf("%w: unparsable proxy address", ErrSystemProxyMalformed)
	}
	if u.Scheme == "socks" {
		u.Scheme = "socks5"
	}
	if u.Path == "/" {
		u.Path = ""
	}
	norm, err := NormalizeProxyURL(u.String())
	if err != nil {
		return "", fmt.Errorf("%w: %s proxy address rejected by validation", ErrSystemProxyMalformed, u.Scheme)
	}
	return norm, nil
}

// withDefaultScheme 值无 scheme 时补默认 scheme（先补再归一是必须步骤：
// NormalizeProxyURL 不收无 scheme 形态）
func withDefaultScheme(v, scheme string) string {
	if strings.Contains(v, "://") {
		return v
	}
	return scheme + "://" + v
}

// composeProxyURL 结构化来源（scutil / gsettings 主机与端口分字段）拼代理串：
// IPv6 字面量补方括号；端口缺省/0（GNOME 端口键未设即 0）不拼，交
// NormalizeProxyURL 按 scheme 补默认端口
func composeProxyURL(scheme, host, port string) string {
	host = strings.TrimSpace(host)
	if h := strings.Trim(host, "[]"); strings.Contains(h, ":") && net.ParseIP(h) != nil {
		host = "[" + h + "]"
	}
	if port = strings.TrimSpace(port); port != "" && port != "0" {
		host += ":" + port
	}
	return scheme + "://" + host
}

// runProbeCommand 执行只读查询子进程取 stdout（scutil --proxy / gsettings
// list-recursively）。ctx 到期即杀子进程，WaitDelay 兜住孙进程继承 stdout 管道
// 使 Wait 迟迟不返回的形态；stderr 只随 *exec.ExitError 回传，错误文本不含输出
// 内容（gsettings 输出含认证字段）
func runProbeCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = probeCommandWaitDelay
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("run %s: %w", filepath.Base(name), err)
	}
	return out, nil
}

// ── Windows：HKCU Internet Settings ──────────────────────────────────────

// winInetValues 注册表原始值（平台无关形态：Windows 读取器产出，测试夹具即此）
type winInetValues struct {
	proxyEnable uint64 // ProxyEnable（REG_DWORD；缺省 = 0）
	proxyServer string // ProxyServer（REG_SZ；缺省 = ""）
}

// winInetProbe Windows 探测器装配：read 为注册表读取（生产）或夹具（测试）
func winInetProbe(read func() (winInetValues, error)) sysProxyProbe {
	return sysProxyProbe{
		source: SystemProxySourceWindowsRegistry,
		probe: func(context.Context) (string, error) {
			v, err := read()
			if err != nil {
				return "", err
			}
			return winInetCandidate(v), nil
		},
	}
}

// winInetCandidate 解析 ProxyServer 串（WinINet 代理列表格式，; 分隔）：
//   - "host:port"（全协议）/ "scheme://host:port"（值自带 scheme 照用）；
//   - "http=h:p;https=h:p;ftp=h:p;socks=h:p"（分协议；键大小写不敏感，ftp 等与
//     更新链无关的键忽略，空值视同缺项）。
//
// ProxyEnable=0（含缺省）视为未配置——关代理后 ProxyServer 常残留旧值，不得误用。
// 档序见文件头；选中档畸形即整体判畸形（不降格取低档），由 normalizeSystemProxy 裁决
func winInetCandidate(v winInetValues) string {
	if v.proxyEnable == 0 {
		return ""
	}
	var all, httpsEntry, httpEntry, socksEntry string
	for _, part := range strings.Split(v.proxyServer, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, val, keyed := strings.Cut(part, "=")
		if !keyed || !isProxyListKey(key) {
			if all == "" {
				all = part
			}
			continue
		}
		val = strings.TrimSpace(val)
		if val == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "https":
			if httpsEntry == "" {
				httpsEntry = val
			}
		case "http":
			if httpEntry == "" {
				httpEntry = val
			}
		case "socks":
			if socksEntry == "" {
				socksEntry = val
			}
		}
	}
	switch {
	case all != "":
		return withDefaultScheme(all, "http")
	case httpsEntry != "":
		return withDefaultScheme(httpsEntry, "http")
	case httpEntry != "":
		return withDefaultScheme(httpEntry, "http")
	case socksEntry != "":
		return withDefaultScheme(socksEntry, "socks5")
	}
	return ""
}

// isProxyListKey 分协议键形态（纯 ASCII 字母，如 http/https/socks）——值里的 =
// （如 URL 内嵌凭据）不被误当分协议键
func isProxyListKey(k string) bool {
	k = strings.TrimSpace(k)
	if k == "" {
		return false
	}
	for _, r := range k {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
}

// ── macOS：scutil --proxy ────────────────────────────────────────────────

// scutilProbe macOS 探测器装配：run 为 scutil --proxy 执行（生产）或夹具（测试）
func scutilProbe(run func(ctx context.Context) ([]byte, error)) sysProxyProbe {
	return sysProxyProbe{
		source: SystemProxySourceMacOSScutil,
		probe: func(ctx context.Context) (string, error) {
			out, err := run(ctx)
			if err != nil {
				return "", err
			}
			return scutilCandidate(string(out))
		},
	}
}

// scutilCandidate 解析 scutil --proxy 输出（SystemConfiguration 字典文本）。只认
// 顶层键——ExceptionsList 数组、__SCOPED__ 按网卡分作用域的嵌套字典一律跳过，防
// 嵌套同名键覆盖顶层生效值。HTTPS/HTTP/SOCKS 三档 *Enable 非零且 *Proxy 非空才算
// 启用；*Port 缺省/0 按 scheme 默认端口
func scutilCandidate(out string) (string, error) {
	top := make(map[string]string)
	depth, sawDict := 0, false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
		case line == "}":
			depth--
		case strings.HasSuffix(line, "{"):
			depth++
			sawDict = true
		case depth == 1:
			if k, v, ok := strings.Cut(line, " : "); ok {
				top[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
	}
	if !sawDict {
		return "", fmt.Errorf("%w: unexpected scutil output", ErrSystemProxyMalformed)
	}
	for _, e := range []struct{ prefix, scheme string }{
		{"HTTPS", "http"}, {"HTTP", "http"}, {"SOCKS", "socks5"},
	} {
		host := top[e.prefix+"Proxy"]
		if !scutilFlagOn(top[e.prefix+"Enable"]) || host == "" {
			continue
		}
		return composeProxyURL(e.scheme, host, top[e.prefix+"Port"]), nil
	}
	return "", nil
}

// scutilFlagOn 数值型开关（scutil *Enable 为 CFNumber 文本）：非零即开
func scutilFlagOn(v string) bool {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	return err == nil && n != 0
}

// ── Linux：GNOME gsettings ───────────────────────────────────────────────

// gsettingsProbe Linux 探测器装配：run 为 gsettings list-recursively 执行（生产）
// 或夹具（测试）
func gsettingsProbe(run func(ctx context.Context) ([]byte, error)) sysProxyProbe {
	return sysProxyProbe{
		source: SystemProxySourceGnomeGsettings,
		probe: func(ctx context.Context) (string, error) {
			out, err := run(ctx)
			if err != nil {
				return "", err
			}
			return gsettingsCandidate(string(out))
		},
	}
}

// gsettingsCandidate 解析 `gsettings list-recursively org.gnome.system.proxy` 输出
// （每行「schema 键 GVariant 文本值」）。mode 'manual' 才是静态代理（'none' 未配置、
// 'auto' 为 PAC 不求值）；host 空 = 该档未配置；port 0 = 未给端口按 scheme 默认。
// use-same-proxy 不解读（三平台统一档序；Clash 类工具三档同址，档序不影响主线场景）。
// 输出含 http 子 schema 认证字段——只留 mode/host/port 三类键，其余逐行丢弃
func gsettingsCandidate(out string) (string, error) {
	vals := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		f := strings.SplitN(strings.TrimSpace(line), " ", 3)
		if len(f) != 3 {
			continue
		}
		switch f[1] {
		case "mode", "host", "port":
			vals[f[0]+" "+f[1]] = strings.TrimSpace(f[2])
		}
	}
	mode, ok := vals[gnomeProxySchema+" mode"]
	if !ok {
		return "", fmt.Errorf("%w: gsettings output lacks %s mode", ErrSystemProxyMalformed, gnomeProxySchema)
	}
	if gvariantString(mode) != "manual" {
		return "", nil
	}
	for _, e := range []struct{ proto, scheme string }{
		{"https", "http"}, {"http", "http"}, {"socks", "socks5"},
	} {
		prefix := gnomeProxySchema + "." + e.proto + " "
		host := gvariantString(vals[prefix+"host"])
		if host == "" {
			continue
		}
		return composeProxyURL(e.scheme, host, gvariantNumber(vals[prefix+"port"])), nil
	}
	return "", nil
}

// gvariantString GVariant 文本形态字符串去引号（gsettings 以单引号打印，含单引号
// 的串改用双引号）。主机名不含转义序列，不做反转义——含反斜杠等畸形值交后续 URL
// 校验拒绝
func gvariantString(v string) string {
	v = strings.TrimSpace(v)
	if len(v) >= 2 && (v[0] == '\'' || v[0] == '"') && v[len(v)-1] == v[0] {
		return strings.TrimSpace(v[1 : len(v)-1])
	}
	return v
}

// gvariantNumber GVariant 整数文本取数值部分（端口键类型 i 无类型注解；带注解形态
// 如 "uint16 7890" 取末段）。数值合法性由 NormalizeProxyURL 端口范围校验裁决
func gvariantNumber(v string) string {
	f := strings.Fields(v)
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}
