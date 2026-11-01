package compareexp

// 对比实验 HTTP 面（P-20261003-46；P-20261004-72 增落盘二阶段）。路由（router.go
// 注册，LockMiddleware 保护）：
//
//	POST   /api/compare-experiments            双开两个 runtime 会话竞写同一 prompt
//	GET    /api/compare-experiments            实验列表（创建时间倒序）
//	GET    /api/compare-experiments/:id        详情 + 双侧产出并集三分类（实时 diff）
//	POST   /api/compare-experiments/:id/adopt  采用标注/落盘（mode=annotate|apply）
//	DELETE /api/compare-experiments/:id        删除（级联清账落盘记录）
//	GET    /api/compare-experiments/:id/filediff?side=a|b&file=  单文件「基线 vs 侧产出」diff
//	GET    /api/compare-experiments/:id/applies            落盘记录列表（轻量视图）
//	GET    /api/compare-experiments/:id/applies/:aid/patch 单条记录全量（还原补丁+备份字节）
//
// 双开复用 terminalapi.LaunchAgentSession（与 agentcron 调度同层调用，HTTP 无关）；
// 完成回执复用完成链（task.progress → opschannel 观察者，见 watcher.go）；
// 产出对比复用 B3 产出视图核心（terminalapi.SessionActivity）。

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"codecombo/server/agentops"
	shared "codecombo/server/api/shared"
	terminalapi "codecombo/server/api/terminal"
	"codecombo/server/filepolicy"
	"codecombo/server/git"
	"codecombo/server/store"
	baseterm "codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

const (
	// promptMax prompt UTF-8 字节上限（launchArgs 服务端上限同口径，terminal.go
	// launchArgs > 500 拒绝——双开把 prompt 原样经 launchArgs 通道注入）
	promptMax = 500

	// sideA/sideB 侧别参数与标注词汇（store.CompareAdopt* 同值）
	sideA = "a"
	sideB = "b"
)

// expIDRe 实验 ID 白名单（cmp- + 数字，防路径穿越形态）
var expIDRe = regexp.MustCompile(`^cmp-[0-9]{1,32}$`)

// validateLaunchInput 创建请求校验：prompt 非空且 ≤500 字节、dir 存在（可选）、
// runtime 形态合法。双侧运行时允许相同——「同 runtime 两版挑好」是合法竞写
// 形态，e2e 亦依赖 shell/shell 的确定性双开；表单默认预填互异对引导差异对比。
// 返回首个错误的用户可读信息
func validateLaunchInput(prompt, dir, runtimeA, runtimeB string) string {
	if !utf8.ValidString(prompt) || len(prompt) == 0 {
		return "prompt is required"
	}
	if len(prompt) > promptMax {
		return "prompt too long (max 500 bytes)"
	}
	if dir != "" {
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			return "dir does not exist"
		}
	}
	for _, rt := range []string{runtimeA, runtimeB} {
		switch rt {
		case "", "auto", "shell":
		default:
			if !agentops.IsRegisteredProvider(rt) {
				return "unknown runtime"
			}
		}
	}
	return ""
}

// CreateExperiment POST /api/compare-experiments
// body: { prompt, dir?, runtimeA, runtimeB, dirA?, dirB? }
// dirA/dirB 可选：分目录竞写（worktree 隔离）——缺省双侧共用 dir。
// 先逐侧发起、双侧齐备才落实验记录：任一侧发起失败即整体报错（无半个实验；
// 已成功拉起的另一侧会话留在终端管理器，由用户自行处理——本链路不拥有
// 会话生命周期）
func CreateExperiment(c *gin.Context) {
	var req struct {
		Prompt   string `json:"prompt"`
		Dir      string `json:"dir"`
		RuntimeA string `json:"runtimeA"`
		RuntimeB string `json:"runtimeB"`
		DirA     string `json:"dirA"`
		DirB     string `json:"dirB"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "compare experiment operation failed", err)
		return
	}
	req.Prompt = strings.TrimSpace(req.Prompt)
	req.Dir = strings.TrimSpace(req.Dir)
	req.DirA = strings.TrimSpace(req.DirA)
	req.DirB = strings.TrimSpace(req.DirB)
	if req.DirA == "" {
		req.DirA = req.Dir
	}
	if req.DirB == "" {
		req.DirB = req.Dir
	}
	if msg := validateLaunchInput(req.Prompt, req.Dir, req.RuntimeA, req.RuntimeB); msg != "" {
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}

	lang := c.GetHeader("Accept-Language")
	// 逐侧发起（顺序而非并行：会话创建是本地 PTY/tmux 操作，毫秒级；并行会
	// 让两个 goroutine 竞争序号默认名命名链，顺序执行命名可预期）
	la, err := terminalapi.LaunchAgentSession("", req.RuntimeA, req.DirA, req.Prompt, lang)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "side A launch failed", err)
		return
	}
	lb, err := terminalapi.LaunchAgentSession("", req.RuntimeB, req.DirB, req.Prompt, lang)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "side B launch failed", err)
		return
	}
	exp, err := store.Get().CompareExp.Create(store.CompareExperiment{
		Prompt: req.Prompt,
		Dir:    req.Dir,
		A:      sideFromLaunch(la, req.DirA),
		B:      sideFromLaunch(lb, req.DirB),
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "compare experiment operation failed", err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": exp})
}

// sideFromLaunch AgentLaunch 快照 → 实验侧（选型后的实际运行时为准：auto 请求
// 的落选结果在这里，launched=false = 降级纯 shell）
func sideFromLaunch(l *terminalapi.AgentLaunch, dir string) store.CompareSide {
	return store.CompareSide{
		SessionID: l.ID,
		Runtime:   l.Runtime,
		Name:      l.Name,
		Dir:       dir,
		Launched:  l.Launched,
	}
}

// ListExperiments GET /api/compare-experiments
func ListExperiments(c *gin.Context) {
	exps, err := store.Get().CompareExp.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "compare experiment operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": exps})
}

// GetExperiment GET /api/compare-experiments/:id
// 详情 = 实验本体 + 双侧会话存活态 + 双侧产出并集三分类（实时计算：对比是
// 决断面，readiness 只说明双侧回执齐备，产出清单跟随工作区漂移）
func GetExperiment(c *gin.Context) {
	exp, ok := expFromParam(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": experimentDetail(exp)})
}

// experimentDetail 详情载荷组装（HTTP 形状独立成函数，测试可直接断言）
func experimentDetail(exp *store.CompareExperiment) gin.H {
	alive := func(side store.CompareSide) bool {
		return baseterm.DefaultManager.GetSession(side.SessionID) != nil
	}
	return gin.H{
		"experiment": exp,
		"alive":      gin.H{sideA: alive(exp.A), sideB: alive(exp.B)},
		"files":      classifyBySession(exp),
	}
}

// classifyBySession 按双侧会话元数据（startHead 快照面）取产出并分类。
// 元数据缺失/无基线/非 git 目录的侧按空产出参与（另一侧全落「仅」）——
// 对比视图如实呈现，退化原因由前端提示文案表达
func classifyBySession(exp *store.CompareExperiment) []CompareFileRow {
	filesFor := func(side store.CompareSide) []terminalapi.ActivityFile {
		meta, err := store.Get().AgentSession.Get(side.SessionID)
		if err != nil || meta == nil || meta.StartHead == "" || meta.Dir == "" {
			return nil
		}
		files, _, _, ok := terminalapi.SessionActivity(meta.Dir, meta.StartHead)
		if !ok {
			return nil
		}
		return files
	}
	return ClassifyCompareFiles(filesFor(exp.A), filesFor(exp.B))
}

// AdoptExperiment POST /api/compare-experiments/:id/adopt
// body: { side: "a"|"b"|"", mode?: "annotate"|"apply" }
// mode 缺省/annotate = 标注语义零变化（P-20261003-46 MVP；P-20261004-72 起标注
// 动作顺带快照行动文件指纹，作为 apply 的安全对账参照——增量字段，旧响应形状
// 不变）；mode=apply = 采用落盘二阶段（编排见 apply.go：保留/回滚/删除 + 备份
// 强制前置 + 指纹对账安全失败）
func AdoptExperiment(c *gin.Context) {
	exp, ok := expFromParam(c)
	if !ok {
		return
	}
	var req struct {
		Side string `json:"side"`
		Mode string `json:"mode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "compare experiment operation failed", err)
		return
	}
	side := strings.TrimSpace(req.Side)
	switch req.Mode {
	case "", "annotate":
		// 标注 + 指纹快照（side="" 清除标注与快照）；SetAdoptedSnapshot 对
		// 重复同侧标注刷新快照时刻 = 用户重新审阅的新参照系。指纹基准目录 =
		// 未采用侧（行动文件住在那里）；他侧元数据缺失时快照退化为空表
		//（apply 门 ① 会拒绝该形态，标注侧保持 MVP 宽容语义）
		var files map[string]string
		if side != "" {
			if _, om, err := sideMetasOfExp(exp, side); err == nil {
				files = fingerprintDir(om, classifyCandidates(exp, side))
			} else {
				files = map[string]string{}
			}
		}
		updated, err := store.Get().CompareExp.SetAdoptedSnapshot(exp.ID, side, files)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "side must be a, b or empty", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": updated})
	case "apply":
		if side != sideA && side != sideB {
			shared.Error(c, http.StatusBadRequest, "apply requires side a or b", nil)
			return
		}
		runAdoptApply(c, exp, side)
	default:
		shared.Error(c, http.StatusBadRequest, "mode must be annotate or apply", nil)
	}
}

// DeleteExperiment DELETE /api/compare-experiments/:id（删实验记录；已拉起的
// 会话不受影响——对比实验只读产出，不拥有会话生命周期。P-20261004-72 起级联
// 清账落盘记录：孤儿备份会在容量裁剪时挤掉在用实验的新备份，保留策略随实验
// 一同终结；恢复手法随记录删除即失，删除确认面前端已交代）
func DeleteExperiment(c *gin.Context) {
	exp, ok := expFromParam(c)
	if !ok {
		return
	}
	if err := store.Get().CompareExp.Delete(exp.ID); err != nil {
		shared.Error(c, http.StatusNotFound, "compare experiment not found", err)
		return
	}
	if _, err := store.Get().ExpApply.DeleteByExperiment(exp.ID); err != nil {
		slog.Warn("compare experiment apply records cleanup failed", "exp", exp.ID, "err", err)
	}
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// GetExperimentFileDiff GET /api/compare-experiments/:id/filediff?side=a&file=x
// 单文件「基线 vs 侧会话产出」unified diff（DiffViewer 直接消费）：
//   - 已跟踪变更：git diff <侧 startHead> -- <file>（git.GetBaseFileDiff）
//   - 未跟踪新文件（status ?）：git diff 不含 untracked，读文件合成 new-file
//     diff（体积/二进制护栏内），前端同一渲染路径
//
// file 是 git 产出的仓库相对路径（正斜杠，三平台同形）：Clean + 绝对路径 +
// .. 段三重校验防穿越（与 merge.go 冲突读取同款防线）
func GetExperimentFileDiff(c *gin.Context) {
	exp, ok := expFromParam(c)
	if !ok {
		return
	}
	sideVal := strings.ToLower(c.Query("side"))
	side := exp.A
	if sideVal == sideB {
		side = exp.B
	} else if sideVal != sideA {
		shared.Error(c, http.StatusBadRequest, "side must be a or b", nil)
		return
	}
	file := c.Query("file")
	if file == "" || filepath.IsAbs(file) || filepath.Clean(file) != file || strings.HasPrefix(file, "..") {
		shared.Error(c, http.StatusBadRequest, "invalid file path", nil)
		return
	}

	meta, err := store.Get().AgentSession.Get(side.SessionID)
	if err != nil || meta == nil || meta.Dir == "" {
		shared.Error(c, http.StatusNotFound, "session meta not found", err)
		return
	}
	if meta.StartHead == "" {
		shared.Error(c, http.StatusConflict, "session has no baseline", nil)
		return
	}
	var diff string
	if strings.HasPrefix(c.Query("status"), "?") {
		diff, err = untrackedFileDiff(meta.Dir, file)
	} else {
		diff, err = git.GetBaseFileDiff(meta.Dir, meta.StartHead, file)
	}
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "diff failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": filepolicy.DecodeDisplay(diff)})
}

// expFromParam 路由 :id 解析 + 白名单校验 + 取记录（不存在 404）
func expFromParam(c *gin.Context) (*store.CompareExperiment, bool) {
	id := c.Param("id")
	if !expIDRe.MatchString(id) {
		shared.Error(c, http.StatusBadRequest, "invalid experiment id", nil)
		return nil, false
	}
	exp, err := store.Get().CompareExp.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "compare experiment not found", err)
		return nil, false
	}
	return exp, true
}
