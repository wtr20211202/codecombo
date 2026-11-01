package gitops

import (
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"
	"unicode"

	"codecombo/server/api/shared"
	"codecombo/server/errmarkers"
	"codecombo/server/git"

	"github.com/gin-gonic/gin"
)

// errCloneURLInvalid 克隆 URL 形态预检失败的稳定错误原文（P-20261003-70）。
// 视为对外契约：前端按该原文匹配（web/src/api/http.ts CLONE_URL_INVALID_RE +
// KNOWN_ERROR_I18N），与 errCloneDestExists 同族双保险——前端两个克隆入口
// 行内即时拦截（web/src/utils/cloneUrl.ts 同规则），此处拦直达 API 的调用方。
// 文本唯一事实源在 errmarkers 注册表（P-20261004-29）
var errCloneURLInvalid = errors.New(errmarkers.CloneURLInvalid)

// cloneURLFormRe 合法形态表（从宽——宁可漏报不误拦，后半段一律不细查）：
//   - scheme:// 长形：任意 RFC 3986 scheme（http(s)://…、ssh://git@host[:port]/path
//     自定义端口放行、file://、git://…）；
//   - SCP 短形 user@host:path（@ 后到冒号前不能再有 @ 或冒号）；
//   - 本地路径形态：绝对路径 / 开头（含 UNC）、Windows 盘符、./ ../、~
//     （既有单测与 e2e 用本地路径与 file:// 作克隆 URL，必须放行）。
var cloneURLFormRe = regexp.MustCompile(
	`^(?:[a-zA-Z][a-zA-Z0-9+.-]*://|[^\s@]+@[^\s@:]+:|\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\]|~)`)

// precheckCloneURL 克隆 URL 形态预检（P-20261003-70）——把打错的 URL（少冒号、
// 粘进中文空格/全角字符）从「任务启动跑一阵才失败」前移到输入/提交瞬间，与
// 目录预检（precheckDestDir）同族同位：只拦确定失败，吃不准的放行交给 git。
// 规则与前端 web/src/utils/cloneUrl.ts 同清单同语义，改动须两侧同步。
// 注意校验原始入参不做 trim——直达 API 的调用方传带空白的 URL 直接 400；
// 前端两处克隆入口发送前已自行 trim。
func precheckCloneURL(raw string) error {
	// 空白（unicode.IsSpace 覆盖普通空格/制表符/NBSP/全角空格等）与全角字符
	//（CJK 标点 3000-303F、全角形式 FF00-FFEF）——URL 出现即粘贴事故
	for _, r := range raw {
		if unicode.IsSpace(r) || (r >= 0x3000 && r <= 0x303F) || (r >= 0xFF00 && r <= 0xFFEF) {
			return errCloneURLInvalid
		}
	}
	if cloneURLFormRe.MatchString(raw) {
		return nil
	}
	return errCloneURLInvalid
}

// errCloneDestExists 克隆目标目录预检失败的稳定错误原文（P-20261003-26）。
// 视为对外契约：前端按该原文匹配为表单行内错误（web/src/api/http.ts
// KNOWN_ERROR_I18N + CloneModal），改动须两侧同步。文本唯一事实源在
// errmarkers 注册表（P-20261004-29）
var errCloneDestExists = errors.New(errmarkers.CloneDestExists)

// precheckDestDir 克隆目标目录预检——server/git/clone.go CloneRepoStreaming 注释
// 承诺「调用方需保证 destDir 非空（通常由 handler 做目录预检）」此前无人兑现，
// 克隆进已存在非空目录要等任务启动、git 跑一阵后才报错。这里把失败时点前移到
// 点击瞬间：存在且非空 → errCloneDestExists；存在且为空 / 不存在 → 放行
// （git clone 语义允许克隆进空目录）。用 ReadDir 而非 Stat：目标路径是普通文件、
// 权限不足等不确定形态一律放行，交给异步任务由 git 报真实错误——预检只拦
// 「确定非空目录」这一种可提前判定的失败；指向空目录的符号链接 ReadDir 按目标
// 语义解析，自然放行。
func precheckDestDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	if len(entries) > 0 {
		return errCloneDestExists
	}
	return nil
}

// CloneRepo 异步启动克隆任务，返回 taskId。
// 客户端通过 /ws/clone/:taskId 接收实时进度，结束时收到 done 消息。
func CloneRepo(c *gin.Context) {
	var req struct {
		URL    string `json:"url" binding:"required"`
		Dir    string `json:"dir" binding:"required"`
		Branch string `json:"branch"`
		Depth  int    `json:"depth"`
		Name   string `json:"name"`
		// SshKeyID 克隆对话框选定的 SSH 密钥 id（SSH 地址时按 id 精确取钥匙）
		SshKeyID string `json:"sshKeyId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Clone operation failed", err)
		return
	}

	if err := precheckCloneURL(req.URL); err != nil {
		// 稳定原文作为 publicMsg 直出（不依赖 devMode，err 传 nil 免日志噪音）——
		// 属用户输入问题而非服务端故障，同 errCloneDestExists 处置；
		// clone.url_invalid（P-20261005-160）：agent 自纠=修正 URL 重发
		shared.ErrorWithCode(c, shared.CodeCloneURLInvalid, err.Error(), nil)
		return
	}

	if err := precheckDestDir(req.Dir); err != nil {
		// 稳定原文作为 publicMsg 直出（不依赖 devMode，err 传 nil 免日志噪音）——
		// 属用户输入问题而非服务端故障；
		// clone.dest_exists：agent 自纠=换目录或清空后重发
		shared.ErrorWithCode(c, shared.CodeCloneDestExists, err.Error(), nil)
		return
	}

	taskID := git.DefaultTaskManager.Start(git.CloneRequest{
		URL:      req.URL,
		Dir:      req.Dir,
		Branch:   req.Branch,
		Depth:    req.Depth,
		Name:     req.Name,
		SshKeyID: req.SshKeyID,
	})
	c.JSON(http.StatusOK, gin.H{"taskId": taskID})
}

// CancelClone 取消克隆任务
func CancelClone(c *gin.Context) {
	taskID := c.Param("taskId")
	ok := git.DefaultTaskManager.Cancel(taskID)
	if !ok {
		shared.Error(c, http.StatusNotFound, "task not found or already finished", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ── 克隆前远端分支预取（P-20261003-93）──
// lsRemoteBranchesErrPrefix 失败响应的稳定前缀（对外契约）：前端
// useCloneBranchPrefetch 按后续类别子串映射本地化行内提示，改动须两侧同步。
const lsRemoteBranchesErrPrefix = "remote branch prefetch failed"

// classifyLsRemoteError 把 ls-remote 的 git stderr 分类为可行动的稳定英文类别
// 子串（认证失败 / 仓库不可达 / 仓库不存在）——前端 KNOWN_ERROR_I18N 与行内
// 提示按这些子串匹配（authentication failed / remote unreachable 与既有
// errors.known.* 条目共用关键词）。匹配串取自 git 常见报错原文（HTTPS / SSH），
// 小写化后子串匹配。注意排除项：git 失败输出有两行公共尾行（「fatal: Could
// not read from remote repository.」与「Please make sure you have the correct
// access rights」）在权限失败/仓库不存在场景都会出现，无独立判别力（实测
// nonexistent 本地仓库也带 access rights 尾行）——不进任何桶，分类靠前导行
// 的唯一关键词（Permission denied / Repository not found / resolve host 等）。
func classifyLsRemoteError(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "authentication failed"),
		strings.Contains(msg, "permission denied"),
		strings.Contains(msg, "could not read username"),
		strings.Contains(msg, "terminal prompts disabled"),
		strings.Contains(msg, "invalid credentials"):
		return "authentication failed"
	case strings.Contains(msg, "repository not found"),
		strings.Contains(msg, "does not appear to be a git repository"):
		return "repository not found"
	case strings.Contains(msg, "could not resolve host"),
		strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "connection timed out"),
		strings.Contains(msg, "network is unreachable"),
		strings.Contains(msg, "timed out after"),
		strings.Contains(msg, "i/o timeout"),
		strings.Contains(msg, "ssh: connect to host"):
		return "remote unreachable"
	default:
		return ""
	}
}

// ListCloneBranches 克隆前预取远端分支列表：POST /api/clone/branches
// {"url", "sshKeyId"?} → {"data": ["main", "feat/x", ...]}（ref 字典序）。
// 凭据注入语义同克隆（SSH 地址按 sshKeyId 精确取钥匙，server/git
// ListRemoteBranchesFromURL）。失败 502 + 稳定标记
// 「remote branch prefetch failed: <类别>: <git stderr 脱敏原文>」——
// 前端预取失败只提示不阻断克隆（分支仍可手填/留空走默认分支）。
func ListCloneBranches(c *gin.Context) {
	var req struct {
		URL string `json:"url" binding:"required"`
		// SshKeyID 克隆对话框选定的 SSH 密钥 id，语义同 CloneRepo
		SshKeyID string `json:"sshKeyId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "url is required", err)
		return
	}

	branches, err := git.ListRemoteBranchesFromURL(req.URL, req.SshKeyID)
	if err != nil {
		// 稳定标记作为 publicMsg 直出（不依赖 devMode，err 传 nil 免日志噪音，
		// errText 在 devMode 下只回 err.Error() 会丢类别）——同 errCloneDestExists
		// 先例：属用户输入/远端问题而非服务端故障；detail 为 git 包已脱敏的
		// stderr 原文，诊断信息不丢。502 Bad Gateway 语义 = 上游（git 远端）失败
		msg := lsRemoteBranchesErrPrefix
		if kind := classifyLsRemoteError(err); kind != "" {
			msg += ": " + kind
		}
		shared.Error(c, http.StatusBadGateway, msg+": "+strings.TrimSpace(err.Error()), nil)
		return
	}
	if branches == nil {
		// ls-remote 成功但零 heads（空仓库）：返回空数组而非 null，前端
		// 按分支列表长度判空
		branches = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"data": branches})
}
