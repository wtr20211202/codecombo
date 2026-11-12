// Package tools 本机工具集成（P6）：dsh（DeepSeek Harness）Web UI 嵌入支持。
//
// 嵌入通道为「SC 单层反代」：代理监听 <DshProxyPort 默认 3081>，转发到上游
// <DshWebBase 默认 http://127.0.0.1:3080>。反代是唯一与 dsh 版本耦合的适配层
// （吸收自独立 dsh-web 转发器的全部增强能力，该脚本已退役出服务链路）：
//   - 帧嵌入保证：剥 X-Frame-Options / CSP（iframe 可用不依赖 dsh 帧策略）
//   - fence 回环断言：dsh 的服务端 fence 按回环 Host 放行（settings.* 通道只认
//     回环 Host，--trusted-host 不覆盖；task-board 等插件更严，无标记的 /api
//     读取直接 403）——统一由本代理以回环授权转发并补同源标记
//   - token 自动签发：无 dsh-auth- cookie 的首页首访自动 302 携带当前 token
//     （dsh 换 30 天 HttpOnly cookie），浏览器侧 token 零管理
//   - Secure-Context 降级：非回环浏览器访问时（明文 HTTP 非安全上下文）注入
//     randomUUID/clipboard polyfill，并对 settings 页 isLoopback 客户端门禁做
//     源码改写；回环浏览器是安全上下文，零改写零缓冲快路径
//   - 协议跟随：SC 以 TLS 服务时反代同为 https（iframe 与顶层页面 schemeful
//     同站，dsh 会话 cookie 才能携带）；dsh 观感由用户在 dsh 设置自选主题，
//     与 SC 主题解耦（反色暗化滤镜已移除——对原生深色页面会洗白发灰）
//
// 多目标：除本机 dsh（DshWebBase）外可添加外部 dsh 目标（DshTargets，跨机场景），
// 单端口反代按 cookie 路由区分目标（scDshTarget 查询参数落 cookie，iframe 内部
// 后续请求自动携带，根路径原样转发——dsh 绝对路径资源/客户端路由/WS 全部原样工作）。
//
// 暴露策略：默认仅绑 127.0.0.1（嵌入通道只在 SC 本机浏览器可用，受系统锁保护）；
// DshExposeAll 开放后绑定 0.0.0.0 供 LAN 浏览器直接访问，切换即时重绑定监听。
//
// 文件布局（P-20261003-314 按子域拆分，纯搬运零逻辑改动）：
//   - dsh.go       本文件——共享配置/类型/目标解析/通用原语
//   - dsh_status.go   状态探测与 /url 端点、令牌状态判定
//   - dsh_proxy.go    回环反代生命周期与多目标 cookie 路由
//   - dsh_rewrite.go  Secure-Context 降级改写、HTML 模板与独立访问守卫
//   - dsh_targets.go  外部 dsh 目标 CRUD
//   - dsh_launch.go   一键启动/重启、launch token 捕获与子进程环境
//   - dsh_upgrade.go  npm 版本/升级/回退与版本 changelog
//   - dsh_spawn_*.go  平台子进程属性（构建标签隔离）
package tools

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// dshDefaults 配置缺省值
const (
	dshDefaultBase  = "http://127.0.0.1:3080"
	dshDefaultProxy = 3081
	probeTimeout    = 1500 * time.Millisecond
	// launchReadyTimeout 冷启动就绪上限：装新插件后的首次启动要加载整棵插件树，
	// 实测可超 30s（dsh-web 脚本同款教训），给足 60s
	launchReadyTimeout = 60 * time.Second
	// scTargetQuery / scTargetCookie 多目标路由：查询参数落 cookie（Path=/ 全站
	// 生效），iframe 内部后续导航/WS 升级自动携带
	scTargetQuery  = "scDshTarget"
	scTargetCookie = "sc_dsh_target"
	// localTargetID 本机目标保留键（DshTargets 列表之外，/dsh/url?target= 显式
	// 指定或缺省时走 DshWebBase 默认链路）
	localTargetID = "local"
)

// dshConfig 当前生效配置（base 规整 + 上游解析结果 + token + 代理端口）
type dshConfig struct {
	Base          string             // 规整后的本机目标上游（scheme://host[:port]，无尾斜杠）
	Token         string             // 本机目标令牌（空 = 未配置）
	ProxyPort     int                // 反代监听端口
	ProxyEnabled  bool               // 反代是否启用（端口 > 0）
	ExposeAll     bool               // 反代绑定所有网卡（默认仅 127.0.0.1）
	LaunchCommand string             // 一键启动命令
	Targets       []config.DshTarget // 外部 dsh 目标
	// AllowStandalone 独立标签页访问开关（默认关——未配置视为关闭，见
	// DshAllowStandaloneOrDefault；关闭时顶层导航返回引导页）
	AllowStandalone bool
}

func readConfig() dshConfig {
	// AllowStandalone 默认关（嵌入专用）：设置存储存在时由 OrDefault 覆盖
	cfg := dshConfig{Base: dshDefaultBase, ProxyPort: dshDefaultProxy}
	if sc := store.Get().Settings.Get(); sc != nil {
		if v := strings.TrimSpace(sc.Server.DshWebBase); v != "" {
			cfg.Base = v
		}
		cfg.Token = strings.TrimSpace(sc.Server.DshWebToken)
		if sc.Server.DshProxyPort != 0 {
			cfg.ProxyPort = sc.Server.DshProxyPort
		}
		if sc.Server.DshProxyPort < 0 {
			cfg.ProxyPort = 0 // 显式 0/负数 = 关闭反代
		}
		cfg.ExposeAll = sc.Server.DshExposeAll
		cfg.AllowStandalone = sc.Server.DshAllowStandaloneOrDefault()
		cfg.LaunchCommand = strings.TrimSpace(sc.Server.DshLaunchCommand)
		cfg.Targets = sc.Server.DshTargets
	}
	cfg.Base = normalizeDshBase(cfg.Base)
	cfg.ProxyEnabled = cfg.ProxyPort > 0
	return cfg
}

// normalizeDshBase 上游地址规整：scheme://host[:port]，去尾斜杠/路径
func normalizeDshBase(v string) string {
	if u, err := url.Parse(strings.TrimSpace(v)); err == nil && u.Host != "" &&
		(u.Scheme == "http" || u.Scheme == "https") {
		return u.Scheme + "://" + u.Host
	}
	return v
}

// ============== 目标解析（本机/外部目标统一寻址，状态探测与反代共用） ==============

// targetIDOrDefault 空/缺省归一为本机目标键
func targetIDOrDefault(id string) string {
	if strings.TrimSpace(id) == "" {
		return localTargetID
	}
	return id
}

// targetExists 目标是否存在于外部目标列表（本机目标恒存在于默认链路）
func targetExists(cfg dshConfig, id string) bool {
	for _, t := range cfg.Targets {
		if t.ID == id {
			return true
		}
	}
	return false
}

// tokenForTarget 目标令牌：本机目标取 DshWebToken，外部目标取其自身配置；
// 未知目标回退本机（与 baseForTarget 的回落语义一致）
func tokenForTarget(cfg dshConfig, id string) string {
	if id == localTargetID {
		return cfg.Token
	}
	for _, t := range cfg.Targets {
		if t.ID == id {
			return t.Token
		}
	}
	return cfg.Token
}

// baseForTarget 目标上游：本机目标取 DshWebBase，外部目标取其自身地址；
// 未知目标回退本机（列表变更后残留的 cookie/URL 自动回落，不 404）
func baseForTarget(cfg dshConfig, id string) string {
	if id != localTargetID {
		for _, t := range cfg.Targets {
			if t.ID == id {
				return normalizeDshBase(t.Base)
			}
		}
	}
	return cfg.Base
}

// withTokenParam 给目标 URL 追加 token 查询参数（已有 query 时用 & 连接）
func withTokenParam(target, token string) string {
	if token == "" {
		return target
	}
	sep := "?"
	if strings.Contains(target, "?") {
		sep = "&"
	}
	return target + sep + "token=" + url.QueryEscape(token)
}

// ============== 通用原语（semver 比较 / CLI 路径解析，启动与 npm 升级两域共用） ==============

type semverParts struct {
	nums [3]int
	pre  string
}

// parseSemver 解析 v?MAJOR.MINOR.PATCH[-pre]；无法解析返回 nil
func parseSemver(v string) *semverParts {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	pre := ""
	if i := strings.Index(v, "-"); i >= 0 {
		pre = v[i+1:]
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return nil
	}
	var out semverParts
	out.pre = pre
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(strings.TrimSpace(parts[i]))
		if err != nil {
			return nil
		}
		out.nums[i] = n
	}
	return &out
}

// semverLess a < b（semver 规则：有 prerelease < 无 prerelease；数值段逐级比较）
func semverLess(a, b string) bool {
	pa, pb := parseSemver(a), parseSemver(b)
	if pa == nil || pb == nil {
		return a < b
	}
	for i := 0; i < 3; i++ {
		if pa.nums[i] != pb.nums[i] {
			return pa.nums[i] < pb.nums[i]
		}
	}
	if pa.pre == "" && pb.pre != "" {
		return false
	}
	if pa.pre != "" && pb.pre == "" {
		return true
	}
	return pa.pre < pb.pre
}

// lastPathLine lastDshPathLine 的通用形：needle 过滤目标程序名（npm/dsh 各用）
func lastPathLine(out, needle string) string {
	p := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "/") && strings.Contains(line, needle) {
			if fields := strings.Fields(line); len(fields) > 0 {
				p = fields[len(fields)-1]
			}
		}
	}
	return p
}

// pickNewestNvmDsh nvm 命中里取版本最新的（…/versions/node/vX.Y.Z/bin/dsh）；
// 全部无法解析版本时返回空
func pickNewestNvmDsh(hits []string) string {
	best, bestDir := "", ""
	for _, h := range hits {
		parts := strings.Split(filepath.ToSlash(h), "/")
		if len(parts) < 3 {
			continue
		}
		dir := parts[len(parts)-3]
		if parseSemver(dir) == nil {
			continue
		}
		if best == "" || semverLess(bestDir, dir) {
			best, bestDir = h, dir
		}
	}
	return best
}

// pickNewestNvmWindows nvm-windows 多版本目录取最新（…\nvm\vX.Y.Z\npm.cmd，
// 版本目录是父目录而非 nvm 布局的祖父目录）；全部无法解析版本时返回空
func pickNewestNvmWindows(hits []string) string {
	best, bestDir := "", ""
	for _, h := range hits {
		dir := filepath.Base(filepath.Dir(h))
		if parseSemver(dir) == nil {
			continue
		}
		if best == "" || semverLess(bestDir, dir) {
			best, bestDir = h, dir
		}
	}
	return best
}

// pickExecutable 候选里第一个存在的常规文件（执行位仅 Unix 校验——
// Windows 文件系统不携带权限位）
func pickExecutable(cands []string) string {
	for _, p := range cands {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			if runtime.GOOS == "windows" || st.Mode()&0111 != 0 {
				return p
			}
		}
	}
	return ""
}
