package compareexp

// 采用落盘二阶段（P-20261004-72）：adopt 的 mode=apply 把「以某侧为准」从标注
// 变成工作区执行——基于既有三分类（ClassifyCompareFiles，归属正确性由其单测
// 钉死）编排文件级动作：
//
//	采用侧独有文件   保留（不动）
//	双方文件         无操作 + 注记（同目录形态两侧同基线，现工作区内容即采用态；
//	                 分目录形态的同文件双改内容裁决归二期——跨目录落盘编排另立）
//	另一侧独有文件   回滚（tracked：git diff --binary 基线→工作区补丁逆向 apply -R，
//	                 多文件合并单补丁一次调用即原子全有或全无）/ 删除（untracked）
//
// 形态语义（为何同目录只注记不回滚）：同目录双侧共享工作区，「不在采用侧清单」
// 逻辑等价于「内容与采用侧基线一致」——对它逆向回滚反而会把文件推离采用基线
// 制造脏状态。真正的另一侧独有回滚发生在分目录（dirA/dirB worktree）形态：在
// 未采用侧自己的目录里恢复其自身基线，采用侧目录零触碰。
//
// 安全三闸（P-49 冲突惯例）：
//  ①指纹对账：标注动作把行动文件 sha256 快照在案（store.CompareApplySnapshot），
//    apply 前后两次对账，标注后文件被手改即整体拒绝（稳定标记 ApplyConflictMarker，
//    前端 KNOWN_ERROR_I18N 映射）；旧记录无快照 → 自动补一次新标注（重拍指纹，
//    零间隙）再执行
//  ②备份强制前置：执行前把待回滚补丁 + 待删除 untracked 字节落库（车道 1 kind
//    expapply），落库失败即拒绝执行——删除类操作备份不可跳过；超字节上限同拒
//  ③写锁 + 原子回滚：per-dir 写锁串行（hunkWriteLocks 同款 sync.Map 惯例），
//    git apply 无 --reject 全有或全无，任何一步失败工作区不留半程

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	shared "codecombo/server/api/shared"
	"codecombo/server/errmarkers"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
	baseterm "codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// ApplyConflictMarker 稳定英文标记：标注后工作区再被手改（指纹失配/文件增减），
// 前端 KNOWN_ERROR_I18N 按子串映射「工作区已变化」提示；改文案必须同步前端正则。
// 文本唯一事实源在 errmarkers 注册表（P-20261004-29），此处保名别名
const ApplyConflictMarker = errmarkers.ApplyConflict

// conflictError/conflictText 冲突错误的稳定形态（P-49 ErrHunkDiscardConflict
// 同款惯例）：标记必须同时活在 err 文本与 publicMsg 里——shared.errText 在
// devMode 返回 err.Error()、非 dev 返回 publicMsg，只有双写才能保证响应体
// 恒含前端正则锚点
func conflictError(detail error) error { return fmt.Errorf("%s (%s)", ApplyConflictMarker, detail) }

func conflictText(detail error) string {
	return fmt.Sprintf("%s (%s); apply refused, workspace untouched", ApplyConflictMarker, detail)
}

// applyIDRe 落盘记录 ID 白名单（expapply- + 数字，expIDRe 同款防穿越形态）
var applyIDRe = regexp.MustCompile(`^expapply-[0-9]{1,32}$`)

// expApplyLocks 落盘写入按目录串行（hunkWriteLocks 同款惯例）：指纹对账 → 补丁
// 派生 → apply/删除 的读改写窗口被并发编辑打破时，后到者会基于同一张旧快照行动。
// 只串行本编排自身；目录粒度与 git 写队列（仓库粒度）正交不冲突
var expApplyLocks sync.Map // dir -> *sync.Mutex

// AdoptApplyResult 落盘执行结果（HTTP 载荷 + 通知/审计同源词汇）
type AdoptApplyResult struct {
	Side       string   `json:"side"`
	Kept       int      `json:"kept"`       // 采用侧独有文件（保留不动）
	RolledBack int      `json:"rolledBack"` // 另一侧独有 tracked 文件（逆向回滚）
	Deleted    int      `json:"deleted"`    // 另一侧独有 untracked 文件（删除）
	Noop       int      `json:"noop"`       // 双方文件 + 同目录他侧独有（无操作注记）
	Notes      []string `json:"notes,omitempty"`
	BackupID   string   `json:"backupId"` // 备份记录（GET .../applies/:id/patch 可取还原补丁）
}

// sideMeta 取侧会话元数据（classifyBySession 同一取数面；apply 需双侧齐备——
// 对比详情允许无基线侧退化参与，落盘不允许：缺基线会把全部产出错归「他侧
// 独有」进而盲回滚，宁拒勿删）
type sideMeta struct {
	dir       string
	startHead string
}

func sideMetaOf(side store.CompareSide) (*sideMeta, error) {
	meta, err := store.Get().AgentSession.Get(side.SessionID)
	if err != nil || meta == nil || meta.Dir == "" || meta.StartHead == "" {
		return nil, fmt.Errorf("side session %s has no baseline metadata", side.SessionID)
	}
	return &sideMeta{dir: meta.Dir, startHead: meta.StartHead}, nil
}

// sideMetasOfExp 双侧元数据一次取齐（am = 采用侧，om = 未采用侧）
func sideMetasOfExp(exp *store.CompareExperiment, side string) (am, om *sideMeta, err error) {
	adopted, other := exp.A, exp.B
	if side == sideB {
		adopted, other = exp.B, exp.A
	}
	if am, err = sideMetaOf(adopted); err != nil {
		return nil, nil, err
	}
	if om, err = sideMetaOf(other); err != nil {
		return nil, nil, err
	}
	return am, om, nil
}

// sideSettled 侧已终结：拿到完成链回执，或会话已消亡（shell 降级形态无回执，
// 关闭终端即视为实验终结——回执事实与存活态任一满足即可决断）
func sideSettled(side store.CompareSide) bool {
	if side.Result != "" {
		return true
	}
	return sessionGoneProbe(side.SessionID)
}

// sessionGoneProbe 会话消亡探测（与 experimentDetail 的 alive 同一事实源）。
// 包内变量仅为单测可注入——「会话存活且无回执」的未结算态需要真 PTY 会话，
// 单测不可得
var sessionGoneProbe = func(sessionID string) bool {
	return baseterm.DefaultManager.GetSession(sessionID) == nil
}

// runAdoptApply mode=apply 主编排。到达此处 side 已校验为 a/b。
// 全链任何失败都不产生部分落盘（备份先行 + git apply 原子 + 删除逐个容错）
func runAdoptApply(c *gin.Context, exp *store.CompareExperiment, side string) {
	// ① 双侧元数据齐备（缺基线退化面拒绝——见 sideMetaOf 注记）
	am, om, err := sideMetasOfExp(exp, side)
	if err != nil {
		shared.Error(c, http.StatusConflict, "side session has no baseline; apply refused", err)
		return
	}

	// ② 实验已终结（双侧回执齐备或会话已消亡）：对活体 agent 的工作区回滚 =
	//    与仍在写的 agent 竞态，must 拒
	if !sideSettled(exp.A) || !sideSettled(exp.B) {
		shared.Error(c, http.StatusConflict, "experiment is not settled yet (waiting for side results or session close)", nil)
		return
	}

	// ③ 标注/快照就位：标注非本侧或无快照（首次落盘/旧记录升级）→ 重拍标注 +
	//    指纹（随后零间隙执行，对账天然通过）；已有本侧快照 → 沿用（保住
	//    「标注→落盘」间隙的手改防护，这正是快照存在的意义）。指纹基准目录 =
	//    未采用侧目录（行动文件住在那里，分目录形态尤其）
	snap := exp.ApplySnapshot
	if exp.Adopted != side || snap == nil || snap.Side != side {
		files := fingerprintDir(om, classifyCandidates(exp, side))
		fresh, err := store.Get().CompareExp.SetAdoptedSnapshot(exp.ID, side, files)
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "compare experiment operation failed", err)
			return
		}
		exp, snap = fresh, fresh.ApplySnapshot
	}

	// ④ 行动集规划 + 指纹对账（锁外初核；锁内核后再核一次）
	sameDir := am.dir == om.dir
	rows := classifyBySession(exp)
	plan := planApplyRows(rows, side, sameDir)
	if err := verifyFingerprints(om, snap, plan.destructive()); err != nil {
		shared.Error(c, http.StatusConflict, conflictText(err), conflictError(err))
		return
	}

	// ⑤ 写锁内：再核 → 备份 → 执行（无破坏性动作则零锁零写）
	result := &AdoptApplyResult{Side: side}
	if len(plan.rollback) == 0 && len(plan.remove) == 0 {
		finalizeNoop(c, exp, plan, result, am, om, sameDir)
		return
	}
	l, _ := expApplyLocks.LoadOrStore(om.dir, &sync.Mutex{})
	l.(*sync.Mutex).Lock()
	defer l.(*sync.Mutex).Unlock()

	if err := verifyFingerprints(om, snap, plan.destructive()); err != nil {
		shared.Error(c, http.StatusConflict, conflictText(err), conflictError(err))
		return
	}

	// 备份构建（强制前置）：回滚文件的正向还原补丁 + 待删 untracked 字节
	backup := store.ExpApplyRecord{ExpID: exp.ID, Side: side, Dir: om.dir, BaseHead: om.startHead}
	var patches []string
	for _, row := range plan.rollback {
		patch, err := git.GetRestoreFileDiff(om.dir, om.startHead, row.Path)
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "build restore patch failed", err)
			return
		}
		if strings.TrimSpace(patch) == "" {
			result.Noop++ // 分类到执行间隙文件已自行回落基线：诚实注记不盲动
			result.Notes = append(result.Notes, "skipped (already at baseline): "+row.Path)
			continue
		}
		patches = append(patches, patch)
		backup.Patch += patch
	}
	backup.PatchBytes = len(backup.Patch)
	backup.Untracked = make(map[string][]byte, len(plan.remove))
	for _, row := range plan.remove {
		data, err := os.ReadFile(filepath.Join(om.dir, filepath.FromSlash(row.Path)))
		if err != nil {
			result.Noop++
			result.Notes = append(result.Notes, "skipped (unreadable): "+row.Path)
			continue
		}
		backup.Untracked[row.Path] = data
		backup.PatchBytes += len(data)
	}
	// 字节上限：备份不完整时执行删除/回滚等于盲删，宁拒勿删
	if backup.PatchBytes > store.ExpApplyBackupMaxBytes {
		shared.Error(c, http.StatusRequestEntityTooLarge,
			"workspace backup exceeds size cap; apply refused", nil)
		return
	}
	saved, err := store.Get().ExpApply.Create(backup)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "backup persist failed; apply refused", err)
		return
	}
	result.BackupID = saved.ID

	// 执行 1/2：tracked 回滚（合并单补丁一次 apply，全有或全无）
	if len(patches) > 0 {
		if err := git.ApplyPatchReverse(om.dir, strings.Join(patches, "")); err != nil {
			_ = store.Get().ExpApply.Delete(saved.ID) // 未执行：本次备份作废回收
			if strings.Contains(err.Error(), "patch does not apply") || strings.Contains(err.Error(), "does not match") {
				detail := fmt.Errorf("tracked file changed, patch no longer applies: %v", err)
				shared.Error(c, http.StatusConflict, conflictText(detail), conflictError(detail))
				return
			}
			shared.Error(c, http.StatusInternalServerError, "apply rollback patch failed; workspace untouched", err)
			return
		}
		result.RolledBack = len(patches)
	}

	// 执行 2/2：untracked 删除（逐个容错，失败注记不中断——备份已有字节）
	for _, row := range plan.remove {
		if _, ok := backup.Untracked[row.Path]; !ok {
			continue // 备份阶段已跳过（不可读）
		}
		if err := os.Remove(filepath.Join(om.dir, filepath.FromSlash(row.Path))); err != nil {
			if !os.IsNotExist(err) {
				result.Notes = append(result.Notes, "delete failed: "+row.Path)
				continue
			}
		}
		result.Deleted++
	}

	// 计数收尾 + 记录回写 + 对外反馈
	result.Kept = len(plan.keep)
	result.Noop += len(plan.noopBoth) + len(plan.noopBaseline)
	result.Notes = append(result.Notes, plan.formNotes(sameDir)...)
	finishApply(c, exp, saved, result, om)
}

// finalizeNoop 无破坏性动作的落盘（同目录形态常态）：仅记录 + 反馈，零锁零写。
// 备份不落库（没有备份点）——通知仍入账（用户动作要有回执）
func finalizeNoop(c *gin.Context, exp *store.CompareExperiment, plan *applyPlan, result *AdoptApplyResult, am, om *sideMeta, sameDir bool) {
	result.Kept = len(plan.keep)
	result.Noop = len(plan.noopBoth) + len(plan.noopBaseline)
	result.Notes = append(result.Notes, plan.formNotes(sameDir)...)
	finishApply(c, exp, nil, result, om)
}

// finishApply 执行收尾：记录落库（有备份时回写计数）+ 通知 + 审计 + 200 响应
func finishApply(c *gin.Context, exp *store.CompareExperiment, saved *store.ExpApplyRecord, result *AdoptApplyResult, om *sideMeta) {
	if saved != nil {
		saved.Kept, saved.RolledBack, saved.Deleted, saved.Noop, saved.Notes =
			result.Kept, result.RolledBack, result.Deleted, result.Noop, result.Notes
		if err := store.Get().ExpApply.Update(saved); err != nil {
			slog.Warn("compare experiment apply record update failed", "exp", exp.ID, "err", err)
		}
	}
	notifyApplied(exp, result)
	auditApply(c, exp, result, "")
	fresh, err := store.Get().CompareExp.Get(exp.ID)
	if err != nil {
		fresh = exp
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"experiment": fresh, "applied": result}})
}

// ─────────────── 行动集规划（纯函数，单测锚点） ───────────────

// applyPlan 三分类 → 文件级行动集。分目录形态的破坏性动作只落在未采用侧目录；
// 同目录形态零破坏动作（见文件头形态语义）
type applyPlan struct {
	keep         []CompareFileRow // 采用侧独有：保留
	noopBoth     []CompareFileRow // 双方：无操作注记
	noopBaseline []CompareFileRow // 同目录形态他侧独有：已在采用基线，无操作注记
	rollback     []CompareFileRow // 分目录他侧独有 tracked：逆向回滚
	remove       []CompareFileRow // 分目录他侧独有 untracked：删除
}

// destructive 破坏性动作集（指纹对账面）
func (p *applyPlan) destructive() []CompareFileRow {
	out := make([]CompareFileRow, 0, len(p.rollback)+len(p.remove))
	out = append(out, p.rollback...)
	out = append(out, p.remove...)
	return out
}

// formNotes 形态注记（诚实交代无操作的原因；分目录双方文件二期边界）
func (p *applyPlan) formNotes(sameDir bool) []string {
	var notes []string
	if len(p.noopBoth) > 0 {
		notes = append(notes, fmt.Sprintf("%d both-side file(s) left as-is (shared worktree content is the adopted state)", len(p.noopBoth)))
	}
	if sameDir && len(p.noopBaseline) > 0 {
		notes = append(notes, fmt.Sprintf("%d other-side-only file(s) already at adopted baseline (same-dir form); nothing to roll back", len(p.noopBaseline)))
	}
	if !sameDir && len(p.noopBoth) > 0 {
		notes = append(notes, "both-side file content adjudication across dirs is deferred to a later phase; kept as-is")
	}
	return notes
}

// planApplyRows 分类行 → 行动集（纯函数：sameDir 决定他侧独有行是注记还是动作）
func planApplyRows(rows []CompareFileRow, side string, sameDir bool) *applyPlan {
	p := &applyPlan{}
	for _, row := range rows {
		inAdopted, inOther := row.InA, row.InB
		otherStatus := row.StatusB
		if side == sideB {
			inAdopted, inOther = row.InB, row.InA
			otherStatus = row.StatusA
		}
		switch {
		case inAdopted && inOther:
			p.noopBoth = append(p.noopBoth, row)
		case inAdopted:
			p.keep = append(p.keep, row)
		case inOther && sameDir:
			// 同目录他侧独有 = 内容已在采用基线（见文件头形态语义），回滚反而制脏
			p.noopBaseline = append(p.noopBaseline, row)
		case inOther && otherStatus == "?":
			// 分目录形态他侧独有 untracked：删除
			p.remove = append(p.remove, row)
		default:
			// 分目录形态他侧独有 tracked：逆向回滚
			p.rollback = append(p.rollback, row)
		}
	}
	return p
}

// classifyCandidates 标注时点的行动文件清单（指纹快照面 = 他侧独有行；同目录
// 形态他侧独有行是 no-op 也入表——留指纹可让「标注后又被手改」在同目录形态
// 同样可检，代价仅快照体略增）
func classifyCandidates(exp *store.CompareExperiment, side string) []CompareFileRow {
	rows := classifyBySession(exp)
	var out []CompareFileRow
	for _, row := range rows {
		inAdopted, inOther := row.InA, row.InB
		if side == sideB {
			inAdopted, inOther = row.InB, row.InA
		}
		if !inAdopted && inOther {
			out = append(out, row)
		}
	}
	return out
}

// fingerprintDir 对行动文件做 sha256 指纹（路径 → hex；读不到的文件不入表 =
// 「标注时不存在」事实）。git 产出的路径是正斜杠，指纹表统一 slash 形态
func fingerprintDir(m *sideMeta, rows []CompareFileRow) map[string]string {
	files := make(map[string]string, len(rows))
	for _, row := range rows {
		if h, ok := hashFile(m.dir, row.Path); ok {
			files[row.Path] = h
		}
	}
	return files
}

// hashFile 单文件内容指纹（存在返回 hex+true；stat/read 失败 = 不存在语义，
// 指纹表缺席即事实——apply 对账据此区分「标注后新增」）
func hashFile(dir, slashPath string) (string, bool) {
	data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(slashPath)))
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), true
}

// verifyFingerprints 快照对账：行动文件现状 vs 标注时点指纹。任何漂移（内容
// 变化 / 标注后新增）即拒绝——标注的是用户审阅过的工作区状态，被手改后继续
// 执行等于执行一份用户没批过的计划。返回首个失配的描述（进错误文本可定位）。
// 「标注时缺席 + 现在仍缺席」一致放行（另一侧删掉文件的 D 状态是合法回滚态：
// 逆向补丁恢复之），缺席语义随快照缺席键记录在案
func verifyFingerprints(m *sideMeta, snap *store.CompareApplySnapshot, rows []CompareFileRow) error {
	if snap == nil {
		return errors.New("no adoption snapshot")
	}
	for _, row := range rows {
		want, annotated := snap.Files[row.Path]
		got, present := hashFile(m.dir, row.Path)
		switch {
		case annotated && !present:
			return fmt.Errorf("file disappeared after adoption: %s", row.Path)
		case !annotated && present:
			return fmt.Errorf("file appeared after adoption: %s", row.Path)
		case annotated && got != want:
			return fmt.Errorf("file modified after adoption: %s", row.Path)
		}
	}
	return nil
}

// ─────────────── 反馈面（通知 + 审计） ───────────────

// notifyApplied 落盘结果通知（保留 N/回滚 M/删除 K；通知中心入账并广播
// notification.new，模板文案与前端 experiment.notify.* 成对维护）
func notifyApplied(exp *store.CompareExperiment, result *AdoptApplyResult) {
	store.Get().Notification.Add(notification.Notification{
		Type:     "success",
		Category: notification.CategoryTask,
		TitleKey: "experiment.notify.applied.title",
		BodyKey:  "experiment.notify.applied.body",
		Title:    "对比实验已落盘",
		Body:     fmt.Sprintf("kept=%d rolledBack=%d deleted=%d", result.Kept, result.RolledBack, result.Deleted),
		MsgParams: map[string]any{
			"kept": result.Kept,
			"roll": result.RolledBack,
			"del":  result.Deleted,
			"noop": result.Noop,
			"side": strings.ToUpper(result.Side),
		},
	})
}

// auditApply 落盘审计（工作区破坏性动作留痕；Detail 语言中立摘要不含文件内容）。
// 携 gin context 走 AuditAppend 中央口，rid 随请求注入（P-20261006-53）
func auditApply(c *gin.Context, exp *store.CompareExperiment, result *AdoptApplyResult, applyErr string) {
	ev := store.AuditEvent{Action: store.AuditCompareExpApply}
	if applyErr != "" {
		ev.Result = store.AuditResultFailure
		ev.Detail = fmt.Sprintf("exp=%s side=%s err=%s", exp.ID, result.Side, applyErr)
	} else {
		ev.Result = store.AuditResultSuccess
		ev.Detail = fmt.Sprintf("exp=%s side=%s kept=%d rolled=%d deleted=%d",
			exp.ID, result.Side, result.Kept, result.RolledBack, result.Deleted)
	}
	middleware.AuditAppend(c, ev)
}

// ListExpApplies GET /api/compare-experiments/:id/applies
// 落盘记录列表（轻量视图：不含备份本体——补丁/字节经单条端点另取）
func ListExpApplies(c *gin.Context) {
	exp, ok := expFromParam(c)
	if !ok {
		return
	}
	recs, err := store.Get().ExpApply.ListByExperiment(exp.ID)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "compare experiment operation failed", err)
		return
	}
	out := make([]gin.H, 0, len(recs))
	for _, r := range recs {
		out = append(out, gin.H{
			"id": r.ID, "expId": r.ExpID, "side": r.Side, "dir": r.Dir,
			"baseHead": r.BaseHead, "kept": r.Kept, "rolledBack": r.RolledBack,
			"deleted": r.Deleted, "noop": r.Noop, "notes": r.Notes,
			"patchBytes": r.PatchBytes, "truncated": r.Truncated,
			"hasUntracked": len(r.Untracked) > 0,
			"createdAt":    r.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// GetExpApplyPatch GET /api/compare-experiments/:id/applies/:aid/patch
// 单条落盘记录全量（含还原补丁 + untracked 字节备份）——「备份可查」的取数面，
// 落盘出错时用户/agent 凭此手工还原
func GetExpApplyPatch(c *gin.Context) {
	exp, ok := expFromParam(c)
	if !ok {
		return
	}
	aid := c.Param("aid")
	if !applyIDRe.MatchString(aid) {
		shared.Error(c, http.StatusBadRequest, "invalid apply id", nil)
		return
	}
	rec, err := store.Get().ExpApply.Get(aid)
	if err != nil || rec.ExpID != exp.ID {
		shared.Error(c, http.StatusNotFound, "apply record not found", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rec})
}
