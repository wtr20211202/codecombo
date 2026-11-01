package git

import (
	"regexp"
	"strings"
)

// ── git 错误信息凭据脱敏 ──
//
// push/fetch 失败时 git 把 remote URL 原样写进 stderr（如
// `fatal: unable to access 'https://user:token@host/repo/': ...`）。
// 当凭据经 URL 内嵌（credential helper 缺失、历史遗留 remote 配置）时，
// 该错误串会经广播（git.command WS 消息）与错误返回透出到前端。
// 本脱敏在错误串进入广播/返回前抹掉 URL 中的用户信息段。

// urlCredsPattern 匹配 http(s) URL 里的 userinfo 段（user:pass@ 或
// user@——后者常见于 token 即用户名的形态，如 x-access-token）。
// scp-like（git@host:path）不在匹配范围：其用户名是固定字面量 git，
// 无凭据泄漏面
var urlCredsPattern = regexp.MustCompile(`(?i)(https?://)([^/@\s]+?)@`)

// RedactCredentials 抹掉文本中 http(s) URL 的 userinfo 段（保留协议与 host）。
// 用于 git stderr 进入广播/错误返回前的统一脱敏
func RedactCredentials(s string) string {
	if s == "" {
		return s
	}
	return urlCredsPattern.ReplaceAllString(s, "${1}***@")
}

// redactArgs 拼接并脱敏命令参数串：URL 内嵌凭据不只出现在 stderr——
// 远端不可达时 git 直接报 "not a git repository"，错误消息前缀
//（`git fetch <url>`）里的 args 同样携带原始 URL
func redactArgs(args []string) string {
	return RedactCredentials(strings.Join(args, " "))
}
