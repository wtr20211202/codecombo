package remote

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"codecombo/server/api/shared"
	"codecombo/server/git"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 本地-远端同项目 Git 对照（P-20261004-34）：同一 repo 本地一份、远程主机一份，
// 「远端现在跑的是什么版本？落后本地多少？有没有未提交改动？」不用开两个终端
// 人肉对齐——服务端一次 SSH 往返取远端 HEAD/分支/脏文件数，与本地项目既有
// git 采集并排返回结构化对照，供「与本地对照」卡与 agent 远端排障第一步消费。
//
// 安全边界：远端命令是固定模板（三段 git 只读探针），路径经 QuoteArg 单引号
// 包裹且拒绝控制字符/标记形字符串——无任意命令注入面；本地侧全部走
// server/git 既有导出函数（execGit 汇流点）。
//
// 读路径纪律：GET 对照不落盘；远端路径记忆的写走独立的 PUT
// /git-compare-path（前端对照成功后显式保存），读零写盘副作用。

// gitCompareTimeout 单次 SSH 往返超时：对照是状态探针不是长命令，
// 20s 覆盖慢网拨号 + 远端 git 冷启动；超时按「远端不可达」优雅降级
const gitCompareTimeout = 20 * time.Second

// gitCompareMaxPath 远端路径长度上限（字节）：绝对路径的正常量级远低于此，
// 只拦异常输入
const gitCompareMaxPath = 1024

// 命令模板分段标记：三合一输出按标记切节解析。标记串故意生僻（含
// SC-GITCMP 段），并在路径校验中拒绝包含标记前缀的路径——防异常目录名
// 出现在 git 报错原文里干扰切节
const (
	gitCmpMarkerHead   = "@@SC-GITCMP-HEAD@@"
	gitCmpMarkerBranch = "@@SC-GITCMP-BRANCH@@"
	gitCmpMarkerDirty  = "@@SC-GITCMP-DIRTY@@"
	gitCmpMarkerPrefix = "@@SC-GITCMP"
)

// buildRemoteGitProbeCmd 构造远端三合一探针命令（固定模板，路径经引号包裹）：
//   - rev-parse HEAD：远端版本（错误原文并入 stdout 供降级归因）
//   - branch --show-current：当前分支（detached HEAD 输出空）
//   - status --porcelain | wc -l：脏文件数（行计数直传，免把整张变更清单
//     拖过 SSH——对照卡只要计数；`2>/dev/null` 容忍非 git 目录）
//
// 注意 sshclient.Exec 会把整串交给远端登录 shell 执行，这是 SSH exec 协议
// 形态（非 argv 直传）；注入防线 = 路径 QuoteArg + 控制字符/标记黑名单，
// 模板本体是服务端常量。
func buildRemoteGitProbeCmd(remotePath string) string {
	q := sshclient.QuoteArg(remotePath)
	return fmt.Sprintf(
		"printf '%s\\n'; git -C %s rev-parse HEAD 2>&1 | head -n 2; "+
			"printf '%s\\n'; git -C %s branch --show-current 2>&1 | head -n 2; "+
			"printf '%s\\n'; git -C %s status --porcelain 2>/dev/null | wc -l",
		gitCmpMarkerHead, q,
		gitCmpMarkerBranch, q,
		gitCmpMarkerDirty, q,
	)
}

// gitCompareSide 对照单侧（本地/远端同构）
type gitCompareSide struct {
	Available  bool   `json:"available"`
	Head       string `json:"head,omitempty"`   // 完整 40 位提交哈希
	Branch     string `json:"branch,omitempty"` // 当前分支（detached HEAD 为空）
	DirtyCount int    `json:"dirtyCount"`       // 未提交变更文件数（含未跟踪）
	// UnavailableReason 降级归因（稳定枚举，前端 i18n 映射）：
	//   notGitRepo / pathMissing / gitMissing / unreachable / timeout / error
	UnavailableReason string `json:"unavailableReason,omitempty"`
	// UnavailableDetail 底层原文（截断 300 字节），排障用不直出用户面
	UnavailableDetail string `json:"unavailableDetail,omitempty"`
}

// gitCompareBehind 两端 HEAD 的先后关系提示（本地侧 ancestry 推算，不碰远端）
type gitCompareBehind struct {
	// Relation 稳定枚举：same（两端一致）/ remoteBehind（远端落后本地）/
	// remoteAhead（远端领先本地）/ diverged（各有独有提交）/ unknown
	// （远端 HEAD 对象本地不可见——远端有本地没 fetch 过的提交，需 fetch
	// 才能判定，诚实降级不猜）
	Relation string `json:"relation"`
	// RemoteBehindCount 远端落后本地的提交数（relation=remoteBehind/diverged 时有效）
	RemoteBehindCount int `json:"remoteBehindCount,omitempty"`
	// LocalBehindCount 本地落后远端的提交数（relation=remoteAhead/diverged 时有效）
	LocalBehindCount int `json:"localBehindCount,omitempty"`
}

// gitCompareResp 对照响应（GET /api/remotehosts/:id/git-compare）
type gitCompareResp struct {
	Local  gitCompareSide    `json:"local"`
	Remote gitCompareSide    `json:"remote"`
	Behind *gitCompareBehind `json:"behind,omitempty"` // 两端 HEAD 均可得时才有
	// RemotePath 本次实际使用的远端路径（显式传参或记忆回填）
	RemotePath string `json:"remotePath"`
	// PathRemembered 本次路径是否来自 host+project 维度的持久记忆
	//（true 时前端可感知「这是上次记住的路径」）
	PathRemembered bool   `json:"pathRemembered"`
	DurationMs     int64  `json:"durationMs"`
	Error          string `json:"error,omitempty"` // 顶层异常（FTP 不支持等）
}

// gitComparePathError 校验远端路径：非空、长度上限、无控制字符（引号包裹
// 防不了控制字符串进模板干扰切节/换行逃逸）、不含分段标记前缀。
// 返回用户可读的拒绝原因（空串 = 通过）
func gitComparePathError(p string) string {
	if strings.TrimSpace(p) == "" {
		return "remotePath is required"
	}
	if len(p) > gitCompareMaxPath {
		return "remotePath too long (max 1024 bytes)"
	}
	for _, r := range p {
		if r == unicode.ReplacementChar || (unicode.IsControl(r) && r != ' ') {
			return "remotePath contains control characters"
		}
	}
	if strings.Contains(p, gitCmpMarkerPrefix) {
		return "remotePath contains reserved marker sequence"
	}
	return ""
}

// classifyRemoteGitProbeError 把 git 报错原文归因为稳定枚举（前端 i18n 映射）
func classifyRemoteGitProbeError(s string) string {
	switch {
	case strings.Contains(s, "not a git repository"):
		return "notGitRepo"
	case strings.Contains(s, "cannot change to"), strings.Contains(s, "No such file or directory"):
		return "pathMissing"
	case strings.Contains(s, "command not found"), strings.Contains(s, "not found"),
		strings.Contains(s, "is not recognized"):
		return "gitMissing"
	default:
		return "error"
	}
}

var gitHashRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

// parseRemoteGitProbe 解析三合一探针输出（按标记切节）。
// 返回 head（40 位 hex 或空）、branch、dirtyCount、headErr（rev-parse 节的
// 非哈希原文——非 git 目录/路径缺失等降级归因的输入）
func parseRemoteGitProbe(out string) (head, branch, headErr string, dirtyCount int) {
	sections := map[string]string{}
	cur := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		switch line {
		case gitCmpMarkerHead:
			cur = gitCmpMarkerHead
			continue
		case gitCmpMarkerBranch:
			cur = gitCmpMarkerBranch
			continue
		case gitCmpMarkerDirty:
			cur = gitCmpMarkerDirty
			continue
		}
		if cur != "" {
			sections[cur] += line + "\n"
		}
	}
	firstLine := func(s string) string {
		for _, l := range strings.Split(s, "\n") {
			if t := strings.TrimSpace(l); t != "" {
				return t
			}
		}
		return ""
	}
	if h := firstLine(sections[gitCmpMarkerHead]); h != "" {
		if gitHashRe.MatchString(strings.ToLower(h)) {
			head = strings.ToLower(h)
		} else {
			headErr = h
		}
	}
	branch = firstLine(sections[gitCmpMarkerBranch])
	if n := firstLine(sections[gitCmpMarkerDirty]); n != "" {
		// wc -l 输出在 BSD 系带前导空格；Atoi 前去空白；解析失败保持 0
		//（计数取不到时按 0 呈现是诚实降级——rev-parse 已成功说明是 git 目录）
		if v, err := strconv.Atoi(strings.TrimSpace(n)); err == nil && v > 0 {
			dirtyCount = v
		}
	}
	return head, branch, headErr, dirtyCount
}

// GitCompareRemoteHost GET /api/remotehosts/:id/git-compare?projectId=X[&remotePath=Y]
// 远端路径缺省时回填 host+project 维度的持久记忆（响应 PathRemembered=true 标明）；
// 两侧任一不可得按结构化降级返回（HTTP 恒 200，降级原因进各自 side）
func GitCompareRemoteHost(c *gin.Context) {
	id := c.Param("id")
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	projectID := c.Query("projectId")
	if projectID == "" {
		shared.Error(c, http.StatusBadRequest, "projectId query parameter is required", nil)
		return
	}
	proj, err := store.Get().Project.GetByID(projectID)
	if err != nil || proj == nil {
		shared.Error(c, http.StatusNotFound, "project not found", err)
		return
	}
	if rh.IsFTP() {
		c.JSON(http.StatusOK, gin.H{"data": gitCompareResp{Error: "FTP host does not support SSH git compare (files only)"}})
		return
	}

	start := time.Now()
	remotePath := strings.TrimSpace(c.Query("remotePath"))
	pathRemembered := false
	if remotePath == "" {
		if remembered, ok := store.Get().RemoteGitPath.Get(id, projectID); ok {
			remotePath = remembered
			pathRemembered = true
		} else {
			shared.Error(c, http.StatusBadRequest,
				"remotePath is required (no remembered path for this host+project)", nil)
			return
		}
	}
	if reason := gitComparePathError(remotePath); reason != "" {
		shared.Error(c, http.StatusBadRequest, reason, nil)
		return
	}

	resp := gitCompareResp{
		RemotePath:     remotePath,
		PathRemembered: pathRemembered,
		Local:          gitCompareLocalSide(proj.Path),
	}
	// 响应出口统一收口（本包 GET 惯例 = {"data": ...} 包装，hostkey/tunnels 同款）
	respond := func() {
		c.JSON(http.StatusOK, gin.H{"data": resp})
	}

	// 远端侧：单次 SSH 往返执行固定探针模板。连接从 per-host 池借出
	//（P-20261005-159：免每请求握手）；连接级首错由池弃置重建重试一次
	//（探针只读幂等）。ctx 超时不属连接级错误，不触发重试
	if err := ResolveRemoteHostAuth(rh); err != nil {
		resp.Remote = degradeSide("unreachable", err.Error())
		resp.DurationMs = time.Since(start).Milliseconds()
		respond()
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), gitCompareTimeout)
	defer cancel()
	var out *sshclient.ExecOutput
	err = conns.WithLease(id, dialOptions(rh), func(client *sshclient.Client) error {
		var e error
		out, e = client.Exec(ctx, sshclient.ExecOptions{Cmd: buildRemoteGitProbeCmd(remotePath)}, nil)
		return e
	})
	switch {
	case err != nil && out == nil:
		// 连接/会话层失败：超时与其他失败区分（对照卡给出不同可行动文案）
		reason := "unreachable"
		if ctx.Err() != nil {
			reason = "timeout"
		}
		resp.Remote = degradeSide(reason, err.Error())
		resp.DurationMs = time.Since(start).Milliseconds()
		respond()
		return
	}
	stdout := ""
	if out != nil {
		stdout = strings.Join(out.Stdout, "\n")
	}
	head, branch, headErr, dirty := parseRemoteGitProbe(stdout)
	if head == "" && headErr != "" {
		resp.Remote = degradeSide(classifyRemoteGitProbeError(headErr), headErr)
	} else {
		resp.Remote = gitCompareSide{Available: true, Head: head, Branch: branch, DirtyCount: dirty}
	}

	resp.Behind = computeBehindHint(proj.Path, resp.Local.Head, resp.Remote.Head)
	resp.DurationMs = time.Since(start).Milliseconds()
	respond()
}

// gitCompareLocalSide 本地侧采集：全部走 server/git 既有导出函数
// （RevParseHead / GetCurrentBranch / GetStatus 同源 gitops 状态面）
func gitCompareLocalSide(repoPath string) gitCompareSide {
	head, err := git.RevParseHead(repoPath)
	if err != nil {
		return degradeSide(classifyRemoteGitProbeError(err.Error()), err.Error())
	}
	branch, _ := git.GetCurrentBranch(repoPath)
	status, err := git.GetStatus(repoPath)
	if err != nil {
		return degradeSide(classifyRemoteGitProbeError(err.Error()), err.Error())
	}
	return gitCompareSide{Available: true, Head: head, Branch: branch, DirtyCount: len(status)}
}

// computeBehindHint 两端 HEAD 先后关系（本地侧 ancestry 推算）：远端 HEAD
// 对象本地不可见（远端有本地未 fetch 的提交）时诚实返回 unknown 不猜
func computeBehindHint(repoPath, localHead, remoteHead string) *gitCompareBehind {
	if localHead == "" || remoteHead == "" {
		return nil
	}
	if localHead == remoteHead {
		return &gitCompareBehind{Relation: "same"}
	}
	// rev-list --left-right --count HEAD...<remote>：一次子进程同时计量
	// 「仅本地有 / 仅远端引用可见」两侧差集（远端对象缺失时整命令失败 → unknown）
	localOnly, remoteOnly, ok := git.AheadBehindBetween(repoPath, "HEAD", remoteHead)
	if !ok {
		return &gitCompareBehind{Relation: "unknown"}
	}
	switch {
	case localOnly > 0 && remoteOnly == 0:
		return &gitCompareBehind{Relation: "remoteBehind", RemoteBehindCount: localOnly}
	case remoteOnly > 0 && localOnly == 0:
		return &gitCompareBehind{Relation: "remoteAhead", LocalBehindCount: remoteOnly}
	case localOnly > 0 && remoteOnly > 0:
		return &gitCompareBehind{Relation: "diverged",
			RemoteBehindCount: localOnly, LocalBehindCount: remoteOnly}
	default:
		// 计数全零但哈希不同：理论不可达（同哈希必同提交），防御性归 unknown
		return &gitCompareBehind{Relation: "unknown"}
	}
}

// degradeSide 结构化降级单侧（Available=false + 稳定枚举原因 + 截断原文）
func degradeSide(reason, detail string) gitCompareSide {
	return gitCompareSide{
		Available:         false,
		UnavailableReason: reason,
		UnavailableDetail: truncateStr(detail, 300),
	}
}

// SaveGitComparePath PUT /api/remotehosts/:id/git-compare-path
// {"projectId","remotePath"}——远端路径记忆的显式写入口（对照成功后前端
// 回写；空 remotePath = 清除记忆）。GET 对照保持纯读零写盘副作用
func SaveGitComparePath(c *gin.Context) {
	id := c.Param("id")
	if _, err := store.Get().RemoteHost.Get(id); err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	var req struct {
		ProjectID  string `json:"projectId" binding:"required"`
		RemotePath string `json:"remotePath"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "save git compare path failed", err)
		return
	}
	if _, err := store.Get().Project.GetByID(req.ProjectID); err != nil {
		shared.Error(c, http.StatusNotFound, "project not found", err)
		return
	}
	if req.RemotePath != "" {
		if reason := gitComparePathError(req.RemotePath); reason != "" {
			shared.Error(c, http.StatusBadRequest, reason, nil)
			return
		}
	}
	if err := store.Get().RemoteGitPath.Set(id, req.ProjectID, strings.TrimSpace(req.RemotePath)); err != nil {
		shared.Error(c, http.StatusInternalServerError, "save git compare path failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true, "remembered": req.RemotePath != ""}})
}
