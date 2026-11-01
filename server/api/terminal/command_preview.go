package terminal

import (
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"codecombo/server/api/shared"
	"codecombo/server/filepolicy"
	"codecombo/server/git"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 高危命令影响面预览（P-20261005-191）：POST /api/terminals/command-preview。
// 输入命令串（+ 可选 cwd），返回结构化判定 {level, kind, detail, matches[]}：
// 命中模式来自 server/terminal 的纯模式表（MatchCommandRisk），动态计数在本层
// 注入——rm/truncate/shred 族做目标路径 glob 展开 + fs walk 统计文件数/总大小
//（带 1 万条上限护栏，delConfirm DirStat 同款「触顶即下界」语义），git 族对
// cwd 跑 git status 数脏文件/untracked。拿不到动态计数（无 cwd/非 git 目录）
// 的命中降级静态警示——前端确认卡照弹，只是没有规模数字。
//
// 智能体操作面：本端点即 agent 自检原语——运行书/broadcast-write 执行前可先
// 调它拿影响面摘要（登记 ops 手册 terminal 节）。只读面（读元数据不执行命令、
// 不写盘），不入项目硬锁写族；对任意 cwd 可用——终端工作目录不受项目根约束，
// 与用户 shell 同权限域（能跑这条命令的会话本就能读这些元数据）。

// 请求/响应护栏：所有上限独立成常量便于单测验证截断语义
const (
	// maxPreviewCommandBytes 命令串字节上限（超长粘贴截去尾部——预检对象是
	// 人可辨认的命令，8KB 足够表达；同时防病态载荷）
	maxPreviewCommandBytes = 8 * 1024
	// maxPreviewCwdBytes cwd 路径长度上限
	maxPreviewCwdBytes = 1024
	// maxPreviewTargets 单命中参与计数的目标数上限（rm a b c … 病态长列表截断）
	maxPreviewTargets = 16
	// maxPreviewGlobMatches 单个 glob 模式的展开上限（expand * 于超大目录时触顶）
	maxPreviewGlobMatches = 256
	// maxPreviewWalkEntries 单请求 fs walk 总条目预算（跨目标共享）：node_modules/
	// 构建产物级目录触顶即收尾置 Truncated——「以上为下界」，同步预检不无限走盘
	maxPreviewWalkEntries = 10000
	// maxPreviewPaths 受影响路径摘要条数上限（前端确认卡逐行展示面）
	maxPreviewPaths = 8
)

// RiskDynamic 动态影响面计数（拿不到时为 nil = 静态降级）。字段按计数族区分：
// 路径族 files/bytes/paths/truncated；git 族 dirty 或 untracked；覆盖重定向族 exists。
type RiskDynamic struct {
	Files     int64    `json:"files,omitempty"`     // 将消失的文件条目数（符号链接计条目本身）
	Bytes     int64    `json:"bytes,omitempty"`     // 文件内容字节总量
	SizeHuman string   `json:"sizeHuman,omitempty"` // HumanBytes 展示值（前端直显，DirStat 同款）
	Truncated bool     `json:"truncated,omitempty"` // 触及护栏提前收尾：以上字段均为下界
	Paths     []string `json:"paths,omitempty"`     // 受影响路径摘要（≤8 条，cwd 相对形态优先）
	Dirty     int64    `json:"dirty,omitempty"`     // git 族：tracked 脏条目数（reset/checkout/restore 将回滚的面）
	Untracked int64    `json:"untracked,omitempty"` // git 族：untracked 条目数（clean 将删除的面）
	Exists    bool     `json:"exists,omitempty"`    // overwrite 族：目标文件当前已存在（覆盖的是有内容的目标）
}

// CommandPreviewMatch 单命中 + 动态计数
type CommandPreviewMatch struct {
	terminal.RiskMatch
	Dynamic *RiskDynamic `json:"dynamic,omitempty"`
}

// CommandPreviewResult 结构化判定。level 为全部命中的最高档（"" = 未命中）；
// kind/detail 取首个最高档命中（detail 为稳定英文短语，供 agent/日志消费；
// 人读文案由前端按 kind i18n）
type CommandPreviewResult struct {
	Level   string                `json:"level"`
	Kind    string                `json:"kind"`
	Detail  string                `json:"detail"`
	Matches []CommandPreviewMatch `json:"matches"`
}

// PreviewCommand POST /api/terminals/command-preview {"command","cwd"?}
func PreviewCommand(c *gin.Context) {
	var req struct {
		Command string `json:"command" binding:"required"`
		Cwd     string `json:"cwd"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	if len(req.Command) > maxPreviewCommandBytes {
		req.Command = req.Command[:maxPreviewCommandBytes]
	}
	cwd := strings.TrimSpace(req.Cwd)
	if len(cwd) > maxPreviewCwdBytes {
		cwd = ""
	}
	if cwd != "" {
		// cwd 须是存在的目录，否则放弃动态计数（静态降级）而非报错——预检是
		// 尽力而为的增强面，失败不该阻断粘贴主链路
		if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
			cwd = ""
		}
	}

	hits := terminal.MatchCommandRisk(req.Command)
	if len(hits) == 0 {
		c.JSON(http.StatusOK, gin.H{"data": CommandPreviewResult{}})
		return
	}

	result := CommandPreviewResult{Matches: make([]CommandPreviewMatch, 0, len(hits))}
	for _, h := range hits {
		m := CommandPreviewMatch{RiskMatch: h}
		if len(m.Targets) > maxPreviewTargets {
			m.Targets = m.Targets[:maxPreviewTargets]
		}
		if cwd != "" {
			m.Dynamic = enrichDynamic(cwd, m.RiskMatch)
		}
		result.Matches = append(result.Matches, m)
		// 档位取最高（danger > warning），同档取首见
		if riskLevelRank(h.Level) > riskLevelRank(terminal.RiskLevel(result.Level)) {
			result.Level = string(h.Level)
			result.Kind = h.Kind
			result.Detail = previewDetail(h, m.Dynamic)
		}
	}
	if result.Detail == "" && len(result.Matches) > 0 {
		first := result.Matches[0]
		result.Level = string(first.Level)
		result.Kind = first.Kind
		result.Detail = previewDetail(first.RiskMatch, first.Dynamic)
	}
	c.JSON(http.StatusOK, gin.H{"data": result})
}

// riskLevelRank 档位排序值（danger > warning > 空）
func riskLevelRank(l terminal.RiskLevel) int {
	switch l {
	case terminal.RiskDanger:
		return 2
	case terminal.RiskWarning:
		return 1
	}
	return 0
}

// previewDetail 稳定英文摘要（agent/日志消费；数字来自动态计数，无则静态注记）
func previewDetail(m terminal.RiskMatch, d *RiskDynamic) string {
	if d == nil {
		return fmt.Sprintf("%s: static match (no impact counts)", m.ID)
	}
	switch m.Kind {
	case "git":
		if d.Dirty == 0 && d.Untracked > 0 {
			return fmt.Sprintf("%s: %d untracked entries affected", m.ID, d.Untracked)
		}
		return fmt.Sprintf("%s: %d dirty tracked entries affected", m.ID, d.Dirty)
	case "overwrite":
		if d.Exists {
			return fmt.Sprintf("%s: target exists (%s bytes will be overwritten)", m.ID, fmtInt(d.Bytes))
		}
		return fmt.Sprintf("%s: target does not exist yet", m.ID)
	default:
		return fmt.Sprintf("%s: %s files, %s bytes%s", m.ID, fmtInt(d.Files), fmtInt(d.Bytes),
			truncatedSuffix(d.Truncated))
	}
}

func truncatedSuffix(t bool) string {
	if t {
		return " (truncated lower bound)"
	}
	return ""
}

// fmtInt 千分位分隔（人读辅助）
func fmtInt(v int64) string {
	s := fmt.Sprintf("%d", v)
	if len(s) <= 3 {
		return s
	}
	var out []byte
	for i, ch := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, ch)
	}
	return string(out)
}

// enrichDynamic 按 kind 注入动态计数：git 族走 git status；路径族做 glob 展开
// + fs walk。cwd 已由调用方验证为存在目录
func enrichDynamic(cwd string, m terminal.RiskMatch) *RiskDynamic {
	switch m.Kind {
	case "git":
		return gitDynamic(cwd, m.ID)
	case "rm", "truncate", "shred", "overwrite":
		return pathsDynamic(cwd, m.Kind, m.Targets)
	}
	return nil
}

// gitDynamic git 族计数：reset/checkout/restore 数 tracked 脏条目（回滚面），
// clean 数 untracked（删除面）。非 git 目录/状态读取失败 → nil（静态降级）。
// IsRepoProbe 探测语义：终端停在非 git 目录是常态，失败不广播命令台
func gitDynamic(cwd, id string) *RiskDynamic {
	if !git.IsRepoProbe(cwd) {
		return nil
	}
	statuses, err := git.GetStatus(cwd)
	if err != nil {
		return nil
	}
	d := &RiskDynamic{}
	for _, st := range statuses {
		if st.Status == "Untracked" {
			d.Untracked++
		} else {
			d.Dirty++
		}
	}
	switch id {
	case "git-clean":
		return &RiskDynamic{Untracked: d.Untracked}
	case "git-reset-hard", "git-checkout-discard", "git-restore":
		return &RiskDynamic{Dirty: d.Dirty}
	}
	return nil
}

// walkBudget 单请求共享的 walk 条目预算（跨目标/跨 glob 展开消耗）
type walkBudget struct {
	left      int
	truncated bool
}

// pathsDynamic 路径族计数：目标逐个 glob 展开（相对 cwd 解析）后统计规模。
// 单目标不可读/不存在不计入（rm 不存在的目标是 no-op，不虚构规模）；
// 符号链接计条目本身不深入（WalkDir 语义，DirStat 删除确认先例同款——
// rm 会移除链接本身，跳过计数将低报规模）。overwrite 族额外标 Exists：
// 覆盖的是已存在的目标（区别于新建）
func pathsDynamic(cwd, kind string, targets []string) *RiskDynamic {
	d := &RiskDynamic{}
	budget := &walkBudget{left: maxPreviewWalkEntries}
	for _, target := range targets {
		pattern := target
		if !filepath.IsAbs(pattern) {
			pattern = filepath.Join(cwd, target)
		}
		candidates := []string{pattern}
		if strings.ContainsAny(pattern, "*?[") {
			matches, err := filepath.Glob(pattern)
			if err != nil {
				continue // 病态模式（非法 [] 等）：该目标跳过计数
			}
			if len(matches) > maxPreviewGlobMatches {
				matches = matches[:maxPreviewGlobMatches]
				budget.truncated = true
			}
			candidates = matches
		}
		for _, cand := range candidates {
			info, err := os.Lstat(cand)
			if err != nil {
				continue
			}
			if kind == "overwrite" {
				d.Exists = true
			}
			notePath(d, cwd, cand)
			if !info.IsDir() {
				d.Files++
				d.Bytes += info.Size()
				continue
			}
			walkDirStat(cand, d, budget)
			if budget.left <= 0 {
				// 预算耗尽：后续目标不再走盘（Truncated 已标注下界语义）
				break
			}
		}
		if budget.left <= 0 {
			break
		}
	}
	d.SizeHuman = filepolicy.HumanBytes(d.Bytes)
	return d
}

// walkDirStat 目录递归统计：WalkDir 只读元数据不读内容；预算触顶 SkipAll 收尾
// 置 Truncated（「以上为下界」，DirStat 同款：先计数后上限，恰好在预算内不置位）
func walkDirStat(root string, d *RiskDynamic, budget *walkBudget) {
	_ = filepath.WalkDir(root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if p == root {
			return nil
		}
		if budget.left <= 0 {
			budget.truncated = true
			return fs.SkipAll
		}
		budget.left--
		if entry.IsDir() {
			return nil
		}
		// 符号链接（含目录链）IsDir()=false：计文件条目，尺寸取链接本身
		d.Files++
		if fi, e := entry.Info(); e == nil {
			d.Bytes += fi.Size()
		}
		// 受影响路径摘要逐条目登记（notePath 自带上限，超出静默忽略；
		// WalkDir 的 p 以 root 为前缀，折回绝对形态再由 notePath 归一 cwd 相对）
		notePath(d, filepath.Dir(root), p)
		return nil
	})
}

// notePath 受影响路径摘要：cwd 内折相对形态（人读友好），cwd 外保留绝对；
// 上限截断（超出不置 Truncated——摘要只是展示面，规模数字已含全量）
func notePath(d *RiskDynamic, cwd, path string) {
	if len(d.Paths) >= maxPreviewPaths {
		return
	}
	if rel, err := filepath.Rel(cwd, path); err == nil && !strings.HasPrefix(rel, "..") {
		path = rel
	}
	d.Paths = append(d.Paths, filepath.ToSlash(path))
}
