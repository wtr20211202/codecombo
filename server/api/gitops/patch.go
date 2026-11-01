package gitops

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// patchSensitiveBlocked 补丁导出族的出域敏感闸（P-20261004-97）：内容组装后
// 对涉及文件清单跑 share 同源扫描（MatchSensitivePaths，模式表与分享侧单一
// 事实源），命中且未确认（GET confirm=1 / POST {"confirm":true} 缺席）时回
// 200 JSON {warnings}（terminal 导出 / dir-archive 出域闸同契约——blob 链靠
// Content-Type 分流，agent 侧 warnings 键可编程感知），不出补丁本体。
// 确认为提示性闸门（分享/替换同哲学：误报宁多勿漏，确认即放行）；
// 放行路径返回命中清单供响应回告（sensitiveHits 观测留痕）
func patchSensitiveBlocked(c *gin.Context, confirmed bool, content string) (hits []string, blocked bool) {
	hits = share.MatchSensitivePaths(git.PatchHeaderPaths(content))
	if len(hits) == 0 || confirmed {
		return hits, false
	}
	slog.Info("patch export blocked by sensitive scan", "path", c.Request.URL.Path,
		"hits", len(hits))
	c.JSON(http.StatusOK, gin.H{"warnings": hits})
	return hits, true
}

// patchAuditScope 请求形态归一为语言中立 scope 摘要（P-20261005-186 审计
// Detail 用；与 GET 下载端点的 scope=worktree|staged|head 同词汇对账）：
// 显式提交清单 > 区间 > 工作区两态，四选一互斥（与 handler 分支序一致）
func patchAuditScope(commits int, from, to string, staged bool) string {
	switch {
	case from != "" && to != "":
		return "range=" + from + ".." + to
	case commits > 0:
		return fmt.Sprintf("commits=%d", commits)
	case staged:
		return "scope=staged"
	default:
		return "scope=worktree"
	}
}

// ExportPatch 导出 patch
func ExportPatch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Commits []string `json:"commits"`
		From    string   `json:"from"`
		To      string   `json:"to"`
		Staged  bool     `json:"staged"`
		// Confirm 敏感命中二次确认（P-20261004-97）：首请求不带则命中回
		// warnings 清单，显式 true 才真出内容（dir-archive override 同流）
		Confirm bool `json:"confirm"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Patch operation failed", err)
		return
	}

	var content string
	var err error

	if req.From != "" && req.To != "" {
		content, err = git.FormatPatchRange(p.Path, req.From, req.To)
	} else if len(req.Commits) > 0 {
		content, err = git.FormatPatch(p.Path, req.Commits)
	} else {
		content, err = git.ExportDiffAsPatch(p.Path, req.Staged)
	}

	if err != nil {
		respondGitError(c, "Patch operation failed", err)
		return
	}

	hits, blocked := patchSensitiveBlocked(c, req.Confirm, content)
	if blocked {
		return
	}

	// 审计入账（P-20261005-186，patch.export）：补丁 = 提交/未提交变更全量内容
	// 出域，与 GET .patch 下载同账（出域动作记账对称，导出族清单见 auditlog.go
	// 常量块尾注）。只记项目名/scope 元数据，patch 内容与提交清单原文不入账；
	// 敏感闸 warnings 分支不入账（未出内容不算出域，terminal 导出闸同口径）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditPatchExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: p.Name + ": " + patchAuditScope(len(req.Commits), req.From, req.To, req.Staged),
	})

	// 命中清单随放行响应回告（确认出域的观测留痕）；无命中时键缺席，
	// 既有消费方拿到的响应形态与闸门前逐字节同形
	resp := gin.H{"data": content}
	if len(hits) > 0 {
		resp["sensitiveHits"] = hits
	}
	c.JSON(http.StatusOK, resp)
}

// ImportPatch 导入 patch
func ImportPatch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Content string `json:"content" binding:"required"`
		Apply   bool   `json:"apply"` // true=直接应用, false=使用git am
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Patch operation failed", err)
		return
	}

	var err error
	// CRLF 归一：Windows 浏览器 textarea 提交 \r\n，直接喂给 git apply/am
	// 会报 corrupt patch / does not apply（hook 写入已有同款归一）
	content := strings.ReplaceAll(req.Content, "\r\n", "\n")
	if req.Apply {
		err = git.ApplyPatch(p.Path, content, false)
	} else {
		err = git.ApplyMailboxPatch(p.Path, content)
	}

	if err != nil {
		respondGitError(c, "Patch operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "patch applied successfully"})
}

// CheckPatch 检查 patch 是否能干净应用
func CheckPatch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Content string `json:"content" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Patch operation failed", err)
		return
	}

	// CRLF 归一（同 ImportPatch）：check 与 apply 必须吃同一形态的内容
	content := strings.ReplaceAll(req.Content, "\r\n", "\n")
	err := git.ApplyPatch(p.Path, content, true)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"canApply": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"canApply": true})
}

// patchDownloadName 下载文件名：<分支>-<yyyymmdd>.patch（P-20261003-72）。
// 分支名做跨平台文件名安全化：路径分隔符与 Windows 保留字符折叠为 '-'
// （'/' 不折叠会被浏览器当目录分隔，下载名被拆级）；detached HEAD 无分支名回落 HEAD
func patchDownloadName(repoPath string, now time.Time) string {
	branch, err := git.GetCurrentBranch(repoPath)
	if err != nil || branch == "" {
		branch = "HEAD"
	}
	var b strings.Builder
	for _, r := range branch {
		if r > 0x20 && !strings.ContainsRune(`\/:*?"<>|`, r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return b.String() + "-" + now.Format("20060102") + ".patch"
}

// DownloadPatch GET /api/projects/:id/patch?scope=worktree|staged|head[&confirm=1]
// 未提交变更导出为 .patch 附件下载（P-20261003-72）：Content-Disposition 带
// 日期+分支名，二进制变更随 --binary 入补丁；worktree/head 两态自
// P-20261004-56 起追补 untracked 新文件段（纯 untracked 现场亦可导出），
// staged 语义不变。scope 缺省 head（最全集，端点可直链）；非法值 400。
// 空 diff（该 scope 无可导出变更）400 明确报错——前端按 scope 禁用下拉项，
// 此为 API 层兜底契约。内容走 execGit 内存缓冲直出（不落盘），与既有
// POST /patch/export 同模式。
// 出域敏感闸（P-20261004-97）：涉及文件命中 share 模式表且未带 confirm=1
// 时回 200 JSON {warnings}（不出附件头，terminal 导出闸同契约），确认后
// 带 confirm=1 重放才出 .patch——分享有闸导出不裸奔
func DownloadPatch(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	scope := strings.TrimSpace(c.Query("scope"))
	if scope == "" {
		scope = "head" // 缺省/空值同语义：head 最全集
	}
	var content string
	var err error
	switch scope {
	case "worktree":
		content, err = git.ExportDiffAsPatch(p.Path, false)
	case "staged":
		content, err = git.ExportDiffAsPatch(p.Path, true)
	case "head":
		content, err = git.DiffHeadPatch(p.Path)
	default:
		shared.Error(c, http.StatusBadRequest, "invalid scope (worktree|staged|head)", nil)
		return
	}
	if err != nil {
		respondGitError(c, "Patch operation failed", err)
		return
	}
	if strings.TrimSpace(content) == "" {
		shared.Error(c, http.StatusBadRequest, "no changes to export for scope "+scope, nil)
		return
	}

	if _, blocked := patchSensitiveBlocked(c, c.Query("confirm") == "1", content); blocked {
		return
	}

	// 审计入账（P-20261005-186，patch.export）：附件直出补丁内容，与 POST
	// patch/export 同账（Detail 同 scope 词汇对账；warnings 分支不入账同口径）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditPatchExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: p.Name + ": scope=" + scope,
	})

	name := patchDownloadName(p.Path, time.Now())
	c.Header("Content-Type", "text/x-patch; charset=utf-8")
	// 下载头统一净化 helper（P-20261003-109）：patchDownloadName 已折叠路径
	// 分隔符，头形态（ASCII 兜底 + RFC 5987）由 helper 统一产出
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	c.Data(http.StatusOK, "text/x-patch; charset=utf-8", []byte(content))
}
