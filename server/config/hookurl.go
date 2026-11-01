package config

import (
	"fmt"
	"net/url"
	"strings"
)

// 入站 Hook 的 URL 动作允许域（P-20261003-164）。
//
// 背景：入站 Hook（P-20261003-23）的通知动作此前仅接受 panel: 前缀（防任意
// 路由）；CI 失败「打开 CI 页面」类外链跳转是自然需求。开放 url: 动作 = 通知
// 面板可跳站外页面，边界即本清单——只有 host 命中清单的 http(s) 链接才放行。
// 空清单（默认）= url 动作整体关闭，仅 panel: 现状零变化。

const (
	// MaxHookURLAllowHosts 清单条目上限：低频配置项，上限只为防误配/恶意
	// 膨胀撑大匹配循环（TrustedProxies 同款理由）
	MaxHookURLAllowHosts = 64
	// MaxHookURLAllowHostLength 单条目长度上限：DNS 域名单段理论 253 字节，
	// 加「:端口」与 IPv6 括号形态留余量
	MaxHookURLAllowHostLength = 300
)

// NormalizeHookURLAllowHosts 校验并归一 URL 动作允许域清单（设置写路径与
// 入站判定共用同一口径）：
//   - 去首尾空白、丢空条目、去重、条数与长度上限
//   - 条目必须是纯 host（可带端口）：借 url.Parse 以 "http://" 前缀按权威
//     解析口径复核——userinfo/路径/query/fragment 任何一类在场都说明条目
//     不是纯 host（"ci.example.com/a"、"user@ci.example.com" 一律拒绝）
//   - 归一落盘为小写 hostname（剥端口）：清单语义是「信任哪些主机」，端口
//     属于同一主机的部署细节，入站匹配按 hostname 不限端口——两端同用
//     url.Hostname() 口径，形态漂移不可能单侧发生
//
// 显式拒绝通配符（*.example.com）：后缀模糊匹配把 evil-example.com 一并放行
// 是经典绕过面；MVP 只做精确主机匹配，粒度由用户逐域声明。空列表返回非 nil
// 空切片（显式空 = url 动作关闭，与缺省同义但可覆盖 config.json 旧值）。
func NormalizeHookURLAllowHosts(entries []string) ([]string, error) {
	out := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, raw := range entries {
		v := strings.TrimSpace(raw)
		if v == "" {
			continue
		}
		if len(v) > MaxHookURLAllowHostLength {
			return nil, fmt.Errorf("hook url allow host entry too long (max %d bytes): %q", MaxHookURLAllowHostLength, v)
		}
		u, err := url.Parse("http://" + v)
		if err != nil {
			return nil, fmt.Errorf("invalid hook url allow host %q: %w", v, err)
		}
		if u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("invalid hook url allow host %q: host name only (no scheme/path/credentials)", v)
		}
		host := strings.ToLower(u.Hostname())
		if host == "" || strings.Contains(host, "*") {
			return nil, fmt.Errorf("invalid hook url allow host %q: wildcard not supported", v)
		}
		if _, ok := seen[host]; ok {
			continue
		}
		seen[host] = struct{}{}
		out = append(out, host)
		if len(out) > MaxHookURLAllowHosts {
			return nil, fmt.Errorf("too many hook url allow hosts (max %d)", MaxHookURLAllowHosts)
		}
	}
	return out, nil
}
