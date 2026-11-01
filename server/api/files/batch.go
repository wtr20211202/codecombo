package files

// 文件批量操作服务端端点（P-20261006-39）：move/delete/rename/copy 四形态收口。
// 前三形态此前只能由前端逐条循环单文件端点拼装（批量移动 P-160 / 批量删除
// P-20 / 批量改名 P-283 各自逐个调 rename/delete），N 条目 = N 次串行 HTTP
// 往返：远程实例/高延迟链路单批耗时线性放大、中途网络抖动留半完成态、无
// 逐条结构化结果。本端点单请求顺序执行、逐条结构化结果、失败不中断批次
// （P-160 前端逐条跳过语义服务端化）；agent 侧同为批量原语（一次调用 +
// 结果清单），批量面在 AgentGuard 高危表一次审批覆盖整批（agentguard.go，
// op 按 action 细化、delete 形态保「删除文件」前缀兼容存量规则）。
// copy 形态（P-20261023-2）：树内复制/粘贴的服务端递归落点——entries 多路径
// + destDir，同名默认「-副本」步进自动改名（复制意图是要一份新副本，与上传
// 的跳过语义刻意分开），目录递归整树复用 trash 的 copyTree。
//
//	POST /api/projects/:id/files/batch
//	{"action":"move","entries":["a","b"],"destDir":"docs"}        挪入目录（destDir 缺省 = 项目根）
//	{"action":"delete","entries":["a","b"]}                        删除（逐条进回收站）
//	{"action":"rename","renames":[{"oldPath","newPath"},...]}      逐对改名（按提交序执行）
//	{"action":"copy","entries":["a","b"],"destDir":"docs"}         复制入目录（同名 -副本N 步进改名）
//	→ 200 {"action","ok","skipped","failed","results":[{"path","status","error"?}]}
//
// 护栏与校验全部复用单条面、不引入第二套口径：SafeJoinProject 边界（.. 段/
// 符号链接外逃）、validateNameCompat 跨平台名校验（P-132）、renameTargetCovered
// 目标存在防护（P-117）、GuardSensitiveWritePath 敏感写入路径闸（P-235）。
// 批量无跨条目回滚（逐条结构化结果，GitHub API 批量惯例）——半批成败由
// results 如实呈现，调用方按 status 分账。

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

const (
	// batchEntriesMax 单批条目上限：批量整理的合理规模封顶（前端 N≤50 量级
	// 护栏在本端点之上，端点 200 面对 agent 直调防爆量——两层护栏不同职责）；
	// 更大批次调用方分批（前端批量删除链 >200 按此分块串行）
	batchEntriesMax = 200
	// batchBodyMaxBytes 请求体上限：200 条 × rename 双路径 × 富余路径长度。
	// entries/renames 是纯文本路径面，无内容体，与 replace 的文本面上限同族
	// 的量级考量
	batchBodyMaxBytes = int64(1) << 20
)

// batchEntryResult 逐条结构化结果（提案响应契约）：path = 条目原始相对路径
// （rename 形态 = oldPath，调用方按提交清单对账）。status 三值：
// ok = 已落地；skipped = 语义 no-op 未执行（嵌套条目随父条目 / 移入自身子树）；
// error = 已尝试但失败（error 携稳定原因原文，「file already exists」与单条
// 端点同串——前端 errors.known.fileExists 识别口径）。
// 与 upload 端点 saved/skipped 报告同族的「失败不中断批次」形态
type batchEntryResult struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

const (
	batchStatusOK      = "ok"
	batchStatusSkipped = "skipped"
	batchStatusError   = "error"
)

// 批内跳过的稳定原因原文（前端按需映射 i18n；agent 直读）
var (
	errBatchCovered    = errors.New("covered by parent entry in this batch")
	errBatchInsideSelf = errors.New("cannot move into own subtree")
	// errCopyDestInsideSource copy 形态独有：目标目录在源条目子树内（含相等）
	// ——复制会把源子树写进它自己（copyTree 边走源边写目标，子树自吞无终止），
	// 与 move 的「移入自身子树」（errBatchInsideSelf，方向相反：源在目标内）
	// 是两个方向的守卫，不可共用判定
	errCopyDestInsideSource = errors.New("cannot copy into own subtree")
)

// fileAlreadyExistsMsg 目标已存在的稳定原文：与 CreateFile/RenameFile 冲突
// 同串（既有识别口径，前端 KNOWN_ERROR 映射直达），批量面不另造措辞
const fileAlreadyExistsMsg = "file already exists"

// batchRenamePair rename 形态的逐对对照（P-283 前端 BatchRenamePair 同形）
type batchRenamePair struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

// batchRequest 批量操作请求体：move/delete 用 entries（+ move 的 destDir），
// rename 用 renames——三形态共用一个端点而非三个路径，AgentGuard 路由级
// 守卫（method+FullPath 精确匹配）单行即覆盖整个批量面
type batchRequest struct {
	Action  string            `json:"action"`
	Entries []string          `json:"entries"`
	DestDir string            `json:"destDir,omitempty"`
	Renames []batchRenamePair `json:"renames"`
}

// BatchFiles POST /api/projects/:id/files/batch — 批量 move/delete/rename
func BatchFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	shared.LimitBody(c, batchBodyMaxBytes)

	var req batchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.ErrorWithCode(c, shared.CodeFilesPayloadTooLarge, "File operation failed",
				fmt.Errorf("request body too large (max %d bytes)", batchBodyMaxBytes))
			return
		}
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "File operation failed", err)
		return
	}

	count := len(req.Entries)
	if req.Action == "rename" {
		count = len(req.Renames)
	}
	if count == 0 {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "entries or renames required", nil)
		return
	}
	if count > batchEntriesMax {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid,
			fmt.Sprintf("too many entries (max %d per batch, split into multiple requests)", batchEntriesMax), nil)
		return
	}

	var results []batchEntryResult
	switch req.Action {
	case "move":
		var done bool
		results, done = batchMoveEntries(c, p, req.Entries, req.DestDir)
		if done {
			return
		}
	case "delete":
		results = batchDeleteEntries(c, p, req.Entries)
	case "rename":
		var done bool
		results, done = batchRenameEntries(c, p, req.Renames)
		if done {
			return
		}
	case "copy":
		var done bool
		results, done = batchCopyEntries(c, p, req.Entries, req.DestDir)
		if done {
			return
		}
	default:
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "action must be move, delete, rename or copy", nil)
		return
	}

	ok, skipped := 0, 0
	for _, r := range results {
		switch r.Status {
		case batchStatusOK:
			ok++
		case batchStatusSkipped:
			skipped++
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"message": "batch done",
		"action":  req.Action,
		"ok":      ok,
		"skipped": skipped,
		"failed":  len(results) - ok - skipped,
		"results": results,
	})
}

// guardBatchSensitiveWrite 批量写目标的敏感写入路径闸预扫（P-235）：任一目标
// 命中窄表即走高危审批流（428 放在任一条目执行之前——半批已写的状态不可
// 接受，UploadFiles 双闸同款时序）。一次审批管整批：首个命中过闸即不再复扫
// 其余目标（精确逐目标审批需多次往返，UploadFiles MVP 同款取舍；其余敏感
// 目标随首卡放行）。返回 false = 已 428/403 中止，调用方直接 return（零副作用）
func guardBatchSensitiveWrite(c *gin.Context, targets []string) bool {
	for _, rel := range targets {
		if !middleware.IsSensitiveWritePath(rel) {
			continue
		}
		return middleware.GuardSensitiveWritePath(c, rel)
	}
	return true
}

// dedupBatchNested 嵌套源条目去重（升序仅向前查前缀，P-160 前端同款规则
// 服务端化）：条目已在另一条目子树内时随父条目一起走——父条目执行后子条目
// 旧路径必缺失，单独执行必然失败；语义 no-op 逐条 skipped（同条目重复提交
// 同此跳过）。返回保留清单与对应的 skipped 结果
func dedupBatchNested(entries []string) (kept []string, skipped []batchEntryResult) {
	sorted := append([]string(nil), entries...)
	sort.Strings(sorted)
	kept = make([]string, 0, len(sorted))
	for _, e := range sorted {
		covered := false
		for _, q := range kept {
			if q == e || strings.HasPrefix(e, q+"/") {
				covered = true
				break
			}
		}
		if covered {
			skipped = append(skipped, batchEntryResult{Path: e, Status: batchStatusSkipped, Error: errBatchCovered.Error()})
			continue
		}
		kept = append(kept, e)
	}
	return kept, skipped
}

// batchMoveEntries move 形态：entries 逐条挪入 destDir（保持叶子名）。
// 返回 done=true 表示敏感路径闸已 428/403 中止（零执行，响应已写出）
func batchMoveEntries(c *gin.Context, p *config.ProjectConfig, entries []string, destDir string) (results []batchEntryResult, done bool) {
	// 移动目标整批共用：边界校验一次（非法 = 请求形态错误 400，零执行；
	// destDir 为空 = 项目根本身，与 upload dest 同语义）
	if _, err := SafeJoinProject(p.Path, destDir); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, "invalid destDir", nil)
		return nil, true
	}
	destNorm := NormalizeRelPath(destDir)

	kept, skips := dedupBatchNested(entries)
	results = append(results, skips...)

	// 敏感写入路径闸预扫：目标 = destDir/叶子名，全部在前置阶段可精确算出。
	// 放在任一条目挪动之前（428 = 零副作用）
	targets := make([]string, 0, len(kept))
	for _, e := range kept {
		targets = append(targets, path.Join(destNorm, path.Base(e)))
	}
	if !guardBatchSensitiveWrite(c, targets) {
		return nil, true
	}

	for _, e := range kept {
		// 移入自身/自身子目录：目标随移动消失或成环，语义 no-op（P-160 前端
		// skipInsideSelf 同判定；destNorm 为空（根）时不可能命中）
		if destNorm != "" && (e == destNorm || strings.HasPrefix(e, destNorm+"/")) {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusSkipped, Error: errBatchInsideSelf.Error()})
			continue
		}
		absSrc, err := SafeJoinProject(p.Path, e)
		if err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		destRel := path.Join(destNorm, path.Base(e))
		// 跨平台名校验（P-132）：与单条 RenameFile 同位（只校验新路径）
		if err := validateNameCompat(destRel); err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		absDest, err := SafeJoinProject(p.Path, destRel)
		if err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 本地历史快照（P-130，与单条 RenameFile 同钩子）：重命名把内容从旧
		// 路径挪走前留档旧内容；留档失败仅记日志
		snapshotForHistory(p.ID, NormalizeRelPath(e), absSrc)
		// 目标存在防护（P-117，与单条 RenameFile 同口径）：Linux os.Rename 对
		// 已存在目标静默覆盖，显式拦截为逐条 error「file already exists」
		if renameTargetCovered(absDest, absSrc) {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: fileAlreadyExistsMsg})
			continue
		}
		if err := os.Rename(absSrc, absDest); err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 审计入账与单条面同粒度（逐条 event，detail 只记项目与相对路径）：
		// 批量面前端逐条循环时代本就是 N 条 event，服务端化不改变审计形态
		store.Get().Audit.Append(store.AuditEvent{
			Action: store.AuditFileRename,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s: %s → %s", p.Name, e, destRel),
		})
		results = append(results, batchEntryResult{Path: e, Status: batchStatusOK})
	}
	return results, false
}

// batchDeleteEntries delete 形态：entries 逐条入回收站。不做嵌套去重——父条目
// 入站后子条目 Lstat 不存在，走幂等成功分支（与逐条循环单文件端点的既有
// 时序同形，results 与提交清单一一对账）。删除面无敏感路径闸（单条
// DeleteFile 同不设防：删除移除执行面而非创建它），无前置中止分支
func batchDeleteEntries(c *gin.Context, p *config.ProjectConfig, entries []string) []batchEntryResult {
	results := make([]batchEntryResult, 0, len(entries))
	for _, e := range entries {
		absPath, err := SafeJoinProject(p.Path, e)
		if err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 不允许删除项目根（单条面 403 同语义，批量面承载为逐条 error）
		if absPath == mustAbsRoot(p.Path) {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: "cannot delete project root"})
			continue
		}
		if _, err := moveToTrash(p.ID, p.Path, e, absPath); err != nil {
			if os.IsNotExist(err) {
				// 目标不存在：与单条 DeleteFile 对不存在路径的原语义对齐（幂等成功）
				results = append(results, batchEntryResult{Path: e, Status: batchStatusOK})
				continue
			}
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 审计入账（单条面同粒度：只记项目与相对路径，内容本体在回收站）
		store.Get().Audit.Append(store.AuditEvent{
			Action: store.AuditFileDelete,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s: %s", p.Name, e),
		})
		results = append(results, batchEntryResult{Path: e, Status: batchStatusOK})
	}
	return results
}

// batchRenameEntries rename 形态：renames 按提交序逐对执行，父目录先于子项时
// 子项旧路径自动改写（旧父前缀 → 新父前缀映射，P-283 前端执行链 resolve 的
// 服务端化——选中集同时含目录与其子项时子项不因旧路径失效而误败；映射按
// 成功序登记、链式迭代收敛）。失败/重名逐对 error 不中断批次。
// 返回 done=true 表示敏感路径闸已中止（零执行）
func batchRenameEntries(c *gin.Context, p *config.ProjectConfig, renames []batchRenamePair) (results []batchEntryResult, done bool) {
	// 敏感写入路径闸预扫：扫描全部提交 newPath（守写目标，与单条 RenameFile
	// 同防——把内容挪进敏感位置与直写同害）。解析改写只可能引入「已提交的
	// newPath 前缀」（前缀映射登记自成功对的 newPath），故提交面扫描无漏网：
	// 最终目标命中窄表所必需的敏感段必来自某个提交 newPath
	targets := make([]string, 0, len(renames))
	for _, pr := range renames {
		targets = append(targets, pr.NewPath)
	}
	if !guardBatchSensitiveWrite(c, targets) {
		return nil, true
	}

	// 已改名条目前缀映射（原始 oldPath → 实际 newPath）：有序切片而非 map
	// ——单遍取最长命中前缀（嵌套登记 src→dst 且 src/inner→dst/in2 时，短
	// 前缀先改写会把路径锁死在旧形态，P-283 前端执行链逐个调用时代的既有
	// 不收敛缺陷，服务端化顺带修正）
	type prefixPair struct{ oldDir, newDir string }
	var renamedPrefixes []prefixPair
	resolve := func(pth string) string {
		// 逐遍迭代收敛（链式改名 a→b 且 b→c 两跳到位），迭代上限 = 登记数 +1
		// ——前缀互改的病态提交（a→b 且 b→a）会成环，前端执行链无界 for(;;)
		// 在此形态会挂死，服务端原语必须保证终止：超限按当前值返回，后续
		// rename 以逐条 error 收场（不中断批次）
		for i := 0; i <= len(renamedPrefixes); i++ {
			best := -1
			for j, pp := range renamedPrefixes {
				if pth == pp.oldDir || strings.HasPrefix(pth, pp.oldDir+"/") {
					if best == -1 || len(pp.oldDir) > len(renamedPrefixes[best].oldDir) {
						best = j
					}
				}
			}
			if best == -1 {
				return pth
			}
			hit := renamedPrefixes[best]
			pth = hit.newDir + pth[len(hit.oldDir):]
		}
		return pth
	}

	for _, pr := range renames {
		oldRel := resolve(pr.OldPath)
		parent := ""
		if idx := strings.LastIndex(oldRel, "/"); idx >= 0 {
			parent = oldRel[:idx+1]
		}
		newRel := parent + path.Base(pr.NewPath)

		// 源路径按 resolve 后的旧路径锚定（父目录已随前对改名时，原始
		// oldPath 在磁盘上已不存在——与前端执行链 renameFile(resolved) 同源）
		absSrc, err := SafeJoinProject(p.Path, oldRel)
		if err != nil {
			results = append(results, batchEntryResult{Path: pr.OldPath, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 跨平台名校验（P-132）：与单条 RenameFile 同位（只校验新名——旧名已
		// 存在，改名离开地雷名应放行）
		if err := validateNameCompat(newRel); err != nil {
			results = append(results, batchEntryResult{Path: pr.OldPath, Status: batchStatusError, Error: err.Error()})
			continue
		}
		absDest, err := SafeJoinProject(p.Path, newRel)
		if err != nil {
			results = append(results, batchEntryResult{Path: pr.OldPath, Status: batchStatusError, Error: err.Error()})
			continue
		}
		snapshotForHistory(p.ID, NormalizeRelPath(oldRel), absSrc)
		// 目标存在防护（P-117）：批内撞名（前对已把同径目标占住）同串同拦；
		// 同名自身重命名幂等放行（renameTargetCovered 的 os.SameFile 语义）
		if renameTargetCovered(absDest, absSrc) {
			results = append(results, batchEntryResult{Path: pr.OldPath, Status: batchStatusError, Error: fileAlreadyExistsMsg})
			continue
		}
		if err := os.Rename(absSrc, absDest); err != nil {
			results = append(results, batchEntryResult{Path: pr.OldPath, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 登记原始 oldPath → 实际 newPath（成功才登记；文件改名登记无副作用
		// ——无后续路径以文件路径为前缀），随后的子项沿用新父路径
		renamedPrefixes = append(renamedPrefixes, prefixPair{oldDir: pr.OldPath, newDir: newRel})
		store.Get().Audit.Append(store.AuditEvent{
			Action: store.AuditFileRename,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s: %s → %s", p.Name, oldRel, newRel),
		})
		results = append(results, batchEntryResult{Path: pr.OldPath, Status: batchStatusOK})
	}
	return results, false
}

// copyCandidate batch copy 的第 n 个候选叶子名：n=1 → 原名直取（目标不冲突时
// 不改名）；首个冲突档 → <stem>-副本<ext>，此后 <stem>-副本<n-1><ext> 步进
// （Windows 资源管理器「副本/副本 (2)」同款语义，不带括号——括号在部分 shell
// 场景需要转义，连写更稳）。复制意图是要一份新副本，与上传的跳过语义刻意
// 分开（提案 P-20261023-2）
func copyCandidate(leaf, stem, ext string, n int) string {
	if n == 1 {
		return leaf
	}
	if n == 2 {
		return stem + "-副本" + ext
	}
	return stem + "-副本" + strconv.Itoa(n-1) + ext
}

// batchCopyEntries copy 形态：entries 逐条复制入 destDir，同名默认「-副本N」
// 步进自动改名（copyCandidate，复制要的是新副本——与上传跳过/覆盖语义分开），
// 目录递归整树（trash 的 copyTree：Lstat 语义、符号链接重建本身、权限保留），
// 文件字节级复制（跟随符号链接拷内容，O_EXCL 绝不覆盖既有条目——duplicate
// 的 createDuplicate 同款 EXCL 纪律，此处经 createWithCandidates 泛形共用）。
// 返回 done=true 表示敏感路径闸已 428/403 中止（零执行，响应已写出）
func batchCopyEntries(c *gin.Context, p *config.ProjectConfig, entries []string, destDir string) (results []batchEntryResult, done bool) {
	// 复制目标整批共用：边界校验一次（非法 = 请求形态错误 400，零执行；
	// destDir 为空 = 项目根本身，与 move/upload dest 同语义）
	if _, err := SafeJoinProject(p.Path, destDir); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, "invalid destDir", nil)
		return nil, true
	}
	destNorm := NormalizeRelPath(destDir)

	kept, skips := dedupBatchNested(entries)
	results = append(results, skips...)

	// 敏感写入路径闸预扫：目标按「改名前的叶子名」算（dest/leaf）。-副本N 步进
	// 只在叶子名后缀追加、不动任何路径段，敏感窄表前缀/后缀族（.env* / *.key 等）
	// 命中不因步进丢失；按改名前目标预检是保守方向（精确名模式宁多拦不漏拦）。
	// 428 放在任一条目复制之前（零副作用，UploadFiles/batchMove 同款时序）
	targets := make([]string, 0, len(kept))
	for _, e := range kept {
		targets = append(targets, path.Join(destNorm, path.Base(NormalizeRelPath(e))))
	}
	if !guardBatchSensitiveWrite(c, targets) {
		return nil, true
	}

	for _, e := range kept {
		srcRel := NormalizeRelPath(e)
		// 目标目录在源条目子树内（含相等）：复制会把源子树写进它自己
		// （copyTree 边走源边写目标 → 子树自吞无终止），语义 no-op 逐条 skipped。
		// 与 move 的 inside-self 判定方向相反（那是源在目标内，见 errBatchInsideSelf）
		if destNorm == srcRel || strings.HasPrefix(destNorm, srcRel+"/") {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusSkipped, Error: errCopyDestInsideSource.Error()})
			continue
		}
		absSrc, err := SafeJoinProject(p.Path, srcRel)
		if err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		srcInfo, err := os.Lstat(absSrc)
		if err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 目录形态先做条目规模预检（duplicate 同护栏同值）：超限整条拒绝零落盘，
		// 不留半棵被截断的树
		if srcInfo.IsDir() {
			if err := countEntriesLimited(absSrc, dupMaxEntries); err != nil {
				if errors.Is(err, errDupTooLarge) {
					results = append(results, batchEntryResult{Path: e, Status: batchStatusError,
						Error: fmt.Sprintf("directory too large to copy (max %d entries)", dupMaxEntries)})
				} else {
					results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
				}
				continue
			}
		}
		// 首个候选名（即原名叶子）的跨平台名校验（P-132）：-副本N 步进只追加
		// 尾缀，不改目录形态，任一候选命中即全体命中——闸在循环外判一次
		//（duplicate 同款取舍）
		leaf := path.Base(srcRel)
		stem, ext := splitNameExt(leaf)
		destParentAbs, err := SafeJoinProject(p.Path, destNorm)
		if err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		if err := validateNameCompat(path.Join(destNorm, copyCandidate(leaf, stem, ext, 1))); err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}

		// EXCL 语义创建：同名（或并发撞名）换下一个 -副本N 候选，绝不覆盖既有条目。
		// 目录 = Mkdir EXCL 占位根 + copyTree 子树；文件 = O_EXCL + io.Copy
		// （跟随符号链接拷内容，duplicate 同款「副本 = 内容拷贝」语义）
		var create func(absDst string) error
		if srcInfo.IsDir() {
			create = func(absDst string) error {
				if err := os.Mkdir(absDst, srcInfo.Mode().Perm()); err != nil {
					return err
				}
				if err := copyTree(absSrc, absDst); err != nil {
					// 子树复制半途失败：移除残根如实报错（不留看不见的半棵树；
					// 批量无跨条目回滚——本条目按 error 分账）
					_ = os.RemoveAll(absDst)
					return err
				}
				return nil
			}
		} else {
			create = func(absDst string) error {
				in, err := os.Open(absSrc)
				if err != nil {
					return err
				}
				defer in.Close()
				out, err := os.OpenFile(absDst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, srcInfo.Mode().Perm())
				if err != nil {
					return err
				}
				if _, err := io.Copy(out, in); err != nil {
					out.Close()
					return err
				}
				return out.Close()
			}
		}
		absDst, err := createWithCandidates(destParentAbs, func(n int) string {
			return copyCandidate(leaf, stem, ext, n)
		}, create)
		if err != nil {
			results = append(results, batchEntryResult{Path: e, Status: batchStatusError, Error: err.Error()})
			continue
		}
		// 自环标记（P-20261005-15）：copy 是项目内直写口（不经 atomicWriteFile），
		// 不标记则敏感名目标的 fsnotify 事件被误记为「工作台外写入」假阳性。
		// 整树面只标根——子路径由 copyTree 逐一写出，敏感观测按 basename 模式
		// 匹配，子树内的敏感名仍可能假阳性；trash 的 movePath 跨盘回退同只标
		// 根的先例（整树逐文件标记的成本在数千条目子树上不成比例）
		markSelfWrite(absDst)
		newRel := path.Join(destNorm, path.Base(filepath.ToSlash(absDst)))
		// 审计入账与单条面同粒度（只记项目与相对路径；file.copy 与 file.duplicate
		// 同为「创建新副本」语义，各自独立 action 便于按来源分账）
		store.Get().Audit.Append(store.AuditEvent{
			Action: store.AuditFileCopy,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s: %s → %s", p.Name, srcRel, newRel),
		})
		results = append(results, batchEntryResult{Path: e, Status: batchStatusOK})
	}
	return results, false
}
