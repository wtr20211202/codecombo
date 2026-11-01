package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// MaxExternalAccessURLLength 外部访问地址长度上限：该值只用于二维码/剪贴板，
// 超长串没有实际入口价值，提前拒绝防脏配置污染设置面。
const MaxExternalAccessURLLength = 2048

// NormalizeExternalAccessURL 校验并归一「外部访问地址」（P-20261019-10）。
//
// 语义：用户以 Tailscale / Cloudflare Tunnel / 公网反代接入本实例时，桌面端
// 往往仍从 localhost 打开——二维码接力需要一条手机可达的 origin。该设置只
// 接受 http/https 的 origin（scheme + host + 可选 port）：
//   - 拒绝 userinfo（http://user:pass@host 会泄露凭据且不是合法入口形态）；
//   - 拒绝 query/fragment/path（地址只作二维码/复制内容，不参与重定向；
//     带路径的入口由前端按当前路由另行拼接，避免双重路径）；
//   - 尾斜杠归一为无斜杠 origin（存盘形态稳定，前端拼接只需补 "/"）。
//
// 空串 = 不启用（存量配置缺字段即此形态，升级零迁移）。默认端口（http:80/
// https:443）一并归一掉，保证「保存后再读」的展示值稳定（前端 URL API 同口径）。
func NormalizeExternalAccessURL(raw string) (string, error) {
	v, err := normalizeOriginURL(raw)
	if err != nil {
		return "", fmt.Errorf("invalid externalAccessUrl: %w", err)
	}
	return v, nil
}

// NormalizeSharePublicBaseURL 校验并归一分享链接外发基址（P-20261020-2）。
// 与 externalAccessUrl 同一套 origin 规则（仅 http/https、无凭据/路径/query/
// fragment，尾斜杠与默认端口归一）——分享链接只做拼接内容，不做任何重定向；
// 空串 = 不启用（回落当前地址/局域网候选/分享子服务端口，存量形态零变化）。
func NormalizeSharePublicBaseURL(raw string) (string, error) {
	v, err := normalizeOriginURL(raw)
	if err != nil {
		return "", fmt.Errorf("invalid sharePublicBaseUrl: %w", err)
	}
	return v, nil
}

// normalizeOriginURL 两个外发基址设置的共同解析核。错误文案保持中性——
// 调用方包上各自的设置名（externalAccessUrl / sharePublicBaseUrl），
// 避免两处规则复制后漂移。
func normalizeOriginURL(raw string) (string, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", nil
	}
	if len(v) > MaxExternalAccessURLLength {
		return "", fmt.Errorf("value too long (max %d): %d", MaxExternalAccessURLLength, len(v))
	}
	// 空白会经 URL 解析成被编码的路径/主机，语义含糊；设置项是人工入口，直接拒绝
	if strings.ContainsAny(v, " \t\r\n") {
		return "", fmt.Errorf("must not contain whitespace")
	}
	u, err := url.Parse(v)
	if err != nil {
		return "", fmt.Errorf("not a valid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("must use http or https, got %q", u.Scheme)
	}
	if u.User != nil {
		return "", fmt.Errorf("must not contain credentials")
	}
	if u.Host == "" || u.Hostname() == "" {
		return "", fmt.Errorf("missing host")
	}
	if u.Opaque != "" {
		return "", fmt.Errorf("must be an origin URL")
	}
	if u.Path != "" && u.Path != "/" {
		return "", fmt.Errorf("must not contain a path: %q", u.Path)
	}
	if u.RawQuery != "" || u.ForceQuery {
		return "", fmt.Errorf("must not contain a query")
	}
	if u.Fragment != "" {
		return "", fmt.Errorf("must not contain a fragment")
	}

	// 默认端口归一：http:80 / https:443 显式写出时从存盘形态移除；
	// 主机名大小写不敏感，统一小写（前端 URL.host 同口径，展示值稳定）
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	hostPort := host
	if port != "" {
		hostPort = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		// IPv6 字面量必须带方括号才能拼回 origin
		hostPort = "[" + host + "]"
	}
	return u.Scheme + "://" + hostPort, nil
}
