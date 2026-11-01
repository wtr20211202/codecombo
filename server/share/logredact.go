package share

import (
	"regexp"
	"strings"
)

// ── 日志敏感字段脱敏（P-20261002-95）──
//
// 分享短链是直达分享内容的鉴权钥匙：完整值进日志等于把分享鉴权面平移给
// 任何能读日志的人——排障粘贴、崩溃报告、日志聚合都是把日志外发的常见
// 路径。摘要形态 = 前 8 位 + 省略号（16 字符 token 取一半）：人工可对账、
// 不可重放。同一规则服务两类日志面：
//  1. 结构化 slog 字段（管理面 handlers 打 token 字段）→ TokenSummary
//  2. 主服务 gin 访问日志整行（经 app 层 slogWriter 桥进 slog）→
//     RedactLogLine——路径段 /api/share/:token（撤销/轮换/有效期，后两者
//     携活跃 token）、/s/:token（P-20261020-2 同源访客面挂上主引擎后，
//     访客短链本身也是可直达内容的凭据）、/api/hooks/:token（入站 Hook
//     凭据，P-20261003-23）与 OAuth device_code query 值（gin 默认把
//     RawQuery 拼进日志行）。
//     独立端口的访客子服务仍是纯 net/http mux 无请求日志，不经此面

// tokenSummaryLen 摘要保留的前缀位数。 DeriveShareToken 恒产 16 字符
// base36，取一半保留辨识度——对账（哪条链被撤销/轮换）够用，重放不够
const tokenSummaryLen = 8

// TokenSummary 返回日志用 token 摘要：前 tokenSummaryLen 位 + 省略号。
// 短于前缀长度的值（正常派生不会出现，纯防御）整段以 *** 代替——摘要的
// 底线是绝不还原完整值；空串原样返回（调用方少一层判空）
func TokenSummary(token string) string {
	switch {
	case token == "":
		return ""
	case len(token) <= tokenSummaryLen:
		return "***"
	default:
		return token[:tokenSummaryLen] + "…"
	}
}

// sharePathTokenRe 主服务管理路由的 token 路径段（base36 小写、现长 16）。
// {10,} 下限把静态段（snippet/status）排除在命中外——那是路由词不是
// 凭据，误改会让访问日志失去语义；上限放宽到 64 容未来长度调整
var sharePathTokenRe = regexp.MustCompile(`(/api/share/)([0-9a-z]{10,64})`)

// visitorPathTokenRe 同源访客面路径段（P-20261020-2）：/s/<token> 的 token
// 与 /api/share 下的同值同权（都能直达分享内容），主引擎访问日志同样打码。
// token 字符集与 validToken 一致（base36 大小写不敏感的超集），下限同 10
// 防把未来静态路径词当 token 误遮
var visitorPathTokenRe = regexp.MustCompile(`(/s/)([0-9A-Za-z]{10,64})`)

// hookPathTokenRe 入站 Hook 凭据的 URL 段载体（sch_ + 32 hex，P-20261003-23）。
// 凭据直接出现在公开端点路径里，访问日志必须与分享短链同级打码；{4,128}
// 让残缺/未来加长的值同样被遮（宁可多遮，不可漏出完整凭据）
var hookPathTokenRe = regexp.MustCompile(`(/api/hooks/)([A-Za-z0-9_-]{4,128})`)

// deviceCodeRe OAuth device flow 轮询凭据——device_code 可换取访问令牌，
// 与 token 同级敏感
var deviceCodeRe = regexp.MustCompile(`(device_code=)([^&\s"]+)`)

// subsummary 正则整段 → 捕获组 1 原样 + 捕获组 2 摘要（ReplaceAllStringFunc
// 里重跑 FindStringSubmatch 是正则子串替换的标准形态，避免手写下标切割）
func subsummary(re *regexp.Regexp) func(string) string {
	return func(m string) string {
		parts := re.FindStringSubmatch(m)
		if len(parts) < 3 {
			return m
		}
		return parts[1] + TokenSummary(parts[2])
	}
}

// RedactLogLine 把一行日志里的 share 管理 token、入站 Hook 凭据与 OAuth
// device_code 值替换为前缀摘要。整行级入口——gin 访问日志到 slogWriter 桥时
// 已是拼好的行，逐字段脱敏不可行；正则限死上述三类面，其余路径零触碰。
// 热路径量级：每请求一次、行长约百字节，且先行 strings.Contains 快速判空
// （不含锚点词的行零正则开销）
func RedactLogLine(line string) string {
	if !strings.Contains(line, "/api/share/") && !strings.Contains(line, "/s/") &&
		!strings.Contains(line, "/api/hooks/") && !strings.Contains(line, "device_code=") {
		return line
	}
	out := sharePathTokenRe.ReplaceAllStringFunc(line, subsummary(sharePathTokenRe))
	out = visitorPathTokenRe.ReplaceAllStringFunc(out, subsummary(visitorPathTokenRe))
	out = hookPathTokenRe.ReplaceAllStringFunc(out, subsummary(hookPathTokenRe))
	out = deviceCodeRe.ReplaceAllStringFunc(out, subsummary(deviceCodeRe))
	return out
}
