package terminal

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 会话产出视图（P-20261007-22 纯搬运自 terminal.go，零逻辑改动）：
// GET /terminals/:id/activity（startHead 基线/审阅标记/工作区退化三态）
// 与 POST /terminals/:id/review-mark，git 解析助手同文件就近

// ActivityFile 会话产出文件条目（name-status 单行）：Status 为 git 短状态
// （M/A/D/R…，? = 未跟踪新文件），Path 相对仓库根
type ActivityFile struct {
	Status string
	Path   string
}

// SessionActivity 会话产出视图核心（HTTP 无关）：startHead..工作区 name-status
// + 未跟踪新文件补充 + numstat 行数汇总。GetTerminalActivity（B3 产出视图）
// 与 compareexp 对比数据面（P-20261003-46）共用同一实现，产出归属不两份口径。
// startHead 为空由调用方先行分流（退化工作区视图）；git diff 失败返回 ok=false
func SessionActivity(dir, startHead string) (files []ActivityFile, additions, deletions int64, ok bool) {
	return sessionActivity(dir, startHead, nil)
}

// SessionActivitySince 审阅基线视角（P-20261003-217）：tracked 部分基点 base
// 由调用方按时间戳解析（reviewMarkBase，失败退 startHead）；untracked 补充按
// 文件 mtime 过滤——ls-files 无时间维度，标记前已存在且此后未再写的文件
// （mtime < 标记）不属于本轮。mtime 是近似口径：标记后被重写的旧文件 mtime
// 推进入列（改过就算本轮，语义正确），系统时钟偏斜可致少量误入误出，审阅
// 示意可接受
func SessionActivitySince(dir, base string, notBefore time.Time) (files []ActivityFile, additions, deletions int64, ok bool) {
	return sessionActivity(dir, base, &notBefore)
}

// sessionActivity SessionActivity/Since 共同实现；notBefore 非空时启用
// untracked 的 mtime 过滤（会话起点视角不启用——起点即创建时刻，untracked
// 全量呈现是既有契约）
func sessionActivity(dir, startHead string, notBefore *time.Time) (files []ActivityFile, additions, deletions int64, ok bool) {
	// 文件级变更（name-status：状态 + 路径）
	cmd := exec.Command("git", "-C", dir, "diff", "--name-status", startHead)
	out, err := cmd.Output()
	if err != nil {
		return nil, 0, 0, false
	}
	files = parseNameStatus(string(out))
	// 未跟踪文件补充（Agent 产出以新建文件居多，git diff 不含 untracked；
	// ls-files --others --exclude-standard 排除 .gitignore 命中项）
	cmdU := exec.Command("git", "-C", dir, "ls-files", "--others", "--exclude-standard")
	if outU, err := cmdU.Output(); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(outU)), "\n") {
			if line == "" {
				continue
			}
			if notBefore != nil {
				// stat 失败（并发删除等）按在册处理——审阅视图宁多勿漏
				if fi, statErr := os.Stat(filepath.Join(dir, filepath.FromSlash(line))); statErr == nil && fi.ModTime().Before(*notBefore) {
					continue
				}
			}
			files = append(files, ActivityFile{Status: "?", Path: line})
		}
	}
	// 行数汇总（numstat）
	cmd2 := exec.Command("git", "-C", dir, "diff", "--numstat", startHead)
	if out2, err := cmd2.Output(); err == nil {
		additions, deletions = parseNumstat(string(out2))
	}
	return files, additions, deletions, true
}

// GetTerminalActivity GET /api/terminals/:id/activity（B3 产出视图）：
// 该会话自创建以来的产出——git diff --name-status <startHead>（含会话期间
// 已提交的工作）+ 增删行数汇总 + 未跟踪新文件。
// 审阅基线切换（P-20261003-217）：?since=<标记时间戳 RFC3339Nano> 把 diff
// 范围从 startHead 换到该标记（基点解析见 reviewMarkBase），响应附 base=
// 实际计算基点 + marks=该会话全部标记供前端切换器渲染。
// 无基线（非 git 目录/老会话恢复补记失败）时退化为 git status 工作区视图
// （baseline=false 标记，前端展示对应提示）；无元数据时查 Manager 里的存活
// 会话（项目终端跑 claude code / 元数据落库前的老会话）同样退化工作区视图；
// 会话不存在/已结束 → 404
func GetTerminalActivity(c *gin.Context) {
	id := c.Param("id")
	meta, err := store.Get().AgentSession.Get(id)
	if err != nil || meta == nil {
		// 无元数据但会话存活：按会话当前目录退化工作区视图（与有元数据无
		// 基线同形态，baseline=false），治「项目终端跑 claude code 点产出必
		// 404」——用户视角它在跑智能体，理应看到产出
		if s := terminal.DefaultManager.GetSession(id); s != nil {
			files, ok := workingTreeChanges(s.Path)
			if !ok {
				c.JSON(http.StatusOK, gin.H{"data": gin.H{"startHead": "", "baseline": false, "gitRepo": false, "files": nil, "additions": 0, "deletions": 0}})
				return
			}
			additions, deletions := workingTreeNumstat(s.Path)
			c.JSON(http.StatusOK, gin.H{"data": gin.H{
				"startHead": "", "dir": s.Path,
				"baseline": false, "gitRepo": true, "files": files,
				"additions": additions, "deletions": deletions,
			}})
			return
		}
		shared.Error(c, http.StatusNotFound, "no session activity", fmt.Errorf("session meta not found"))
		return
	}
	// diff 基点：默认 startHead；携带合法 since 时换成标记基点。基点解析失败
	// （标记早于全部提交 / HEAD 不存在）退回 startHead——宁可多展示整段产出
	// 也不空窗，与「无基线退化工作区」同一取舍
	base := meta.StartHead
	sinceActive := false
	var sinceTs time.Time
	if sinceStr := c.Query("since"); sinceStr != "" {
		ts, err := time.Parse(time.RFC3339Nano, sinceStr)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid since", err)
			return
		}
		sinceTs = ts
		sinceActive = true
		if markBase, ok := reviewMarkBase(meta.Dir, ts); ok {
			base = markBase
		}
	}
	if base == "" {
		files, ok := workingTreeChanges(meta.Dir)
		if !ok {
			// 目录不存在或非 git 仓库
			c.JSON(http.StatusOK, gin.H{"data": gin.H{"startHead": "", "baseline": false, "gitRepo": false, "files": nil, "additions": 0, "deletions": 0, "marks": meta.Marks}})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{
			"startHead": "", "dir": meta.Dir, "runtime": meta.Runtime,
			"baseline": false, "gitRepo": true, "files": files, "additions": 0, "deletions": 0,
			"marks": meta.Marks,
		}})
		return
	}
	var files []ActivityFile
	var additions, deletions int64
	var ok bool
	if sinceActive {
		files, additions, deletions, ok = SessionActivitySince(meta.Dir, base, sinceTs)
	} else {
		files, additions, deletions, ok = SessionActivity(meta.Dir, base)
	}
	if !ok {
		shared.Error(c, http.StatusInternalServerError, "diff failed", fmt.Errorf("git diff failed in %s", meta.Dir))
		return
	}
	outFiles := make([]gin.H, 0, len(files))
	for _, f := range files {
		outFiles = append(outFiles, gin.H{"status": f.Status, "path": f.Path})
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"startHead": meta.StartHead,
		"base":      base,
		"dir":       meta.Dir,
		"runtime":   meta.Runtime,
		"createdAt": meta.CreatedAt,
		"baseline":  true,
		"files":     outFiles,
		"additions": additions,
		"deletions": deletions,
		"marks":     meta.Marks,
	}})
}

// maxSessionReviewMarks 每会话审阅基线标记上限（FIFO 逐旧裁剪）：追加型数据
// 带保留口径；meta 随会话关闭整体删除，天然有界
const maxSessionReviewMarks = 10

// MarkReviewBaseline POST /api/terminals/:id/review-mark（P-20261003-217）：
// 长会话阶段性审阅——把当前时点记为该会话的审阅基线标记（时间戳 + HEAD 参考
// 快照），产出视图经 activity?since= 切换 diff 范围到任一标记。只写会话元
// 数据不碰工作区/暂存区，不入项目硬锁写族；HEAD 解析失败（非 git 目录）留
// 空照记——标记本身仍可用于时间戳锚定
func MarkReviewBaseline(c *gin.Context) {
	meta, err := store.Get().AgentSession.Get(c.Param("id"))
	if err != nil || meta == nil {
		shared.Error(c, http.StatusNotFound, "session not found", fmt.Errorf("session meta not found"))
		return
	}
	mark := store.SessionMark{Ts: time.Now()}
	if meta.Dir != "" {
		if head, err := execGitHead(meta.Dir); err == nil {
			mark.Head = head
		}
	}
	meta.Marks = append(meta.Marks, mark)
	if len(meta.Marks) > maxSessionReviewMarks {
		meta.Marks = meta.Marks[len(meta.Marks)-maxSessionReviewMarks:]
	}
	if err := store.Get().AgentSession.Save(*meta); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"marks": meta.Marks}})
}

// reviewMarkBase 按标记时间戳解析 diff 基点（P-20261003-217）：rev-list
// --before 取「提交时间 ≤ 标记时点」的最后一个提交（committer date 口径）。
// 不用标记记录的 Head——会话期间 rebase/amend 会使其悬空，时间戳锚定不受
// 历史改写影响（提案定案：diff 范围 rev-list 按时间戳计算，SessionActivity
// 复用零改动）。
// 边界注记（提案风险项「commit 间边界」）：git 提交时间戳只有秒精度——与
// 标记同秒内做出的提交，无论先后都按秒粒度归入「标记前」（该轮 diff 会多算
// 一条同秒提交，绝不漏算已审过的工作）；秒内顺序精确归属需 commit-notes 级
// 记账，超出本提案锚定语义。无早于标记的提交 / HEAD 不存在 / 目录非 git
// 仓库 → ok=false，调用方退回 startHead 基线
func reviewMarkBase(dir string, ts time.Time) (string, bool) {
	if dir == "" {
		return "", false
	}
	cmd := exec.Command("git", "-C", dir, "rev-list", "-n", "1",
		"--before="+ts.Format("2006-01-02 15:04:05 -0700"), "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	base := strings.TrimSpace(string(out))
	return base, base != ""
}

// workingTreeChanges 无基线时的退化视图：git status --porcelain 的当前
// 工作区改动（含暂存与未跟踪）。目录不存在/非 git 仓库返回 ok=false
func workingTreeChanges(dir string) ([]gin.H, bool) {
	if dir == "" {
		return nil, false
	}
	cmd := exec.Command("git", "-C", dir, "status", "--porcelain")
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	files := make([]gin.H, 0)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if len(line) < 4 {
			continue
		}
		x, y := line[0], line[1]
		status := string(y)
		if x == '?' {
			status = "?"
		} else if x != ' ' {
			status = string(x)
		}
		files = append(files, gin.H{"status": status, "path": strings.TrimSpace(line[3:])})
	}
	return files, true
}

// workingTreeNumstat 工作区视图的行数汇总：git diff --numstat HEAD（含已暂存）。
// 空仓库（无 HEAD）/非 git 目录返回 0——文件清单已由 workingTreeChanges 负责
func workingTreeNumstat(dir string) (additions, deletions int64) {
	if dir == "" {
		return 0, 0
	}
	cmd := exec.Command("git", "-C", dir, "diff", "--numstat", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return 0, 0
	}
	return parseNumstat(string(out))
}

// parseNameStatus 解析 git diff --name-status 输出（状态制表符分隔，rename 带
// 分隔的旧路径）
func parseNameStatus(out string) []ActivityFile {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	files := make([]ActivityFile, 0, len(lines))
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}
		files = append(files, ActivityFile{Status: parts[0], Path: parts[1]})
	}
	return files
}

// parseNumstat 解析 git diff --numstat 输出的增删行数（二进制文件以 - 表示，计 0）
func parseNumstat(out string) (add int64, del int64) {
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) < 3 {
			continue
		}
		a, _ := strconv.ParseInt(parts[0], 10, 64)
		d, _ := strconv.ParseInt(parts[1], 10, 64)
		add += a
		del += d
	}
	return add, del
}
