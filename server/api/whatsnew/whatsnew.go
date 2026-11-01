// Package whatsnew 应用内 What's New：版本更新内容的单一事实源（P-20261007-17）。
//
// docs/whatsnew.md 经 main 的 go:embed 注入（与 web/dist 同模式——离线自含，
// 内容随构建冻结），本包切分出 per-version 段落服务两端：
//   - 前端：GET /api/whats-new（token 门只读）——升级后首启 delta 弹层的
//     「只显新版段落」判定面；帮助中心「更新内容」节（help.Get 请求时并入，
//     历史版本可回看）
//   - 智能体：同端点（远程管理的版本确认原语，与 /api/meta 互补：meta 答
//     「有没有/什么版本」，本端点答「这版新加了什么」）+ agentops 手册分节
//
// 内容缺失时全链静默降级（漏写一版不炸只缺段）：SetContent("") 后端点返回
// 空 sections，帮助中心不出现该节。
package whatsnew

import (
	"net/http"
	"regexp"
	"strings"

	"codecombo/server/agentops"
	"codecombo/server/api/system"

	"github.com/gin-gonic/gin"
)

// Section 单版本段落（`## vX.Y.Z 标题` 开一段，标题行以下到下一个 `## ` 为要点体）
type Section struct {
	// Version 版本号（剥 v 前缀，如 "0.0.1"；标题首段非 semver 形态时为空串——
	// 前端 delta 判定跳过无版本号段落，只作展示）
	Version string `json:"version"`
	Title   string `json:"title"`
	// Body 要点 markdown（保留原始换行，含 `### ` 子标题；供 marked 渲染）
	Body string `json:"body"`
}

// content 嵌入文档原文；sections 解析结果。写入发生在 app.Run 装配期（先于
// HTTP 受理），此后只读——无锁（与 system.SetBuildInfo 装配期注入同纪律）
var (
	content  string
	sections []Section
)

// SetContent 注入嵌入文档并解析。app.Run 装配期调用一次；可重复调用覆盖
// （测试重置用）。
func SetContent(md string) {
	content = md
	sections = ParseSections(md)
}

// Sections 解析出的段落（新版本在前，即文档书写顺序）
func Sections() []Section { return sections }

// Content 嵌入文档全文
func Content() string { return content }

// versionRe semver 形态首段（剥 v/V 前缀后）：主.次[.补丁]，允许 -预发布/+元数据后缀
var versionRe = regexp.MustCompile(`^v?[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+][0-9A-Za-z.-]+)?$`)

// ParseSections 切分段落：`## vX.Y.Z 标题` 开一段，标题行以下到下一个 `## `
// 归入要点体（首尾空白收敛，段内空行/缩进原样保留）。文档头（`# ` 与前置
// 说明）与 `### ` 子标题不构成段落边界；按行处理并剥离行尾 \r（Windows 检出
// CRLF / 构建机 autocrlf 下 embed 内容仍可正确切分）。无任何 `## ` 段时返回
// 空切片（非 nil，JSON 序列化为 []）
func ParseSections(md string) []Section {
	out := []Section{}
	cur := -1 // 当前段落下标；-1 = 文档头区（未入段）
	for _, line := range strings.Split(md, "\n") {
		line = strings.TrimRight(line, "\r")
		if v, title, ok := parseHeading(line); ok {
			out = append(out, Section{Version: v, Title: title})
			cur = len(out) - 1
			continue
		}
		if cur >= 0 {
			out[cur].Body += line + "\n"
		}
	}
	for i := range out {
		out[i].Body = strings.TrimSpace(out[i].Body)
	}
	return out
}

// parseHeading 识别 `## ` 段落标题行：首段是 semver 形态时剥 v 前缀取版本号、
// 余下为标题；否则版本号空串、整行（去掉 ## 前缀）为标题
func parseHeading(line string) (version, title string, ok bool) {
	s := strings.TrimSpace(line)
	if !strings.HasPrefix(s, "## ") {
		return "", "", false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(s, "## "))
	head := rest
	if i := strings.IndexAny(rest, " \t"); i >= 0 {
		head = rest[:i]
	}
	if versionRe.MatchString(head) {
		return strings.TrimPrefix(strings.TrimPrefix(head, "v"), "V"), strings.TrimSpace(rest[len(head):]), true
	}
	return "", rest, true
}

// HandleWhatsNew GET /api/whats-new —— 全文 + 当前 buildVersion + 按版本切分段落。
// 只读文档面（token 门承担鉴权，内容为构建期冻结的非敏感静态文档）
func HandleWhatsNew(c *gin.Context) {
	v, _, _ := system.BuildInfo()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"version":  v,
		"content":  content,
		"sections": sections,
	}})
}

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "whatsnew", Title: "版本更新内容（What's New）", Order: 96,
		Summary: "当前/历史版本新增了什么——用户问「这版更新了什么/新功能在哪」或远程确认对端版本能力时查本接口",
		Body: `- GET /api/whats-new   全文 + 当前 buildVersion + 按版本切分段落（sections：version/title/body，新版本在前）
  与 /api/meta 互补：meta 答「有没有/什么版本」，本接口答「这版新加了什么」。`,
	})
}
