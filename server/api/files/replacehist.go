package files

// 批量替换历史与一键还原 API（P-20261004-66）：替换历史闭环的产品内承载——
//
//	GET  /api/projects/:id/replace/history                历史清单（元数据，不含补丁字节）
//	POST /api/projects/:id/replace/history/:hid/restore   一键还原（补丁逆向重建替换前现场）
//
// 还原链沿既有通道拼装（P-114 e2e 验证过的 checkout+apply 回滚组合的产品化）：
//  1. 取补丁：优先 replacehist 文档内嵌 base64（车道 1 副本，artifacts 清账后
//     仍可用），缺失回落 artifacts/replace-backups/ 文件（同一内容的车道 2 副本）
//  2. checkout 圈定路径回暂存区态（untracked 命中文件经 ls-files 滤除——无
//     index 基线不可 checkout，也不在还原范围；备份补丁自 P-20261004-56 起含
//     untracked new-file 段，apply 前经 git.FilterPatchToPaths 裁剪到圈定
//     路径——还原边界与 checkout 边界一致并如实回告）
//  3. 正向 apply 备份补丁 = 精确重建「替换前工作区」（含替换前已有的未提交
//     改动）；暂存区在替换后被推进则 apply 失败 409（工作区停在暂存区态）
//
// 为什么不是 apply -R 备份补丁：备份补丁是「暂存区→替换前工作区」的方向，
// 对替换后的内容逆向必然上下文失配（替换行就在补丁 hunk 里）；正向 apply 在
// checkout 归零后才是可重放的正确方向（任务书「git apply -R 沿既有链」的
// 意图 = 沿既有 git 补丁通道还原，方向由补丁语义决定，见 git/patch.go 注释）。

import (
	"encoding/base64"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// recordReplaceHist 执行成功后的历史留档（runReplaceBatch 挂钩，尽力而为）：
// 一替换一文档（时间/pattern/replacement/选项快照/文件数/处数/改写明细/
// 备份名/补丁 base64）。补丁超 ReplaceHistPatchMaxBytes 不内嵌（留 artifacts
// 文件名引用，还原回落读文件），落盘/内存上界见 store/replacehist.go 头注
func recordReplaceHist(p *config.ProjectConfig, o replaceOptions, res replaceResult, patchContent string) {
	if store.Get() == nil || store.Get().ReplaceHist == nil {
		return // 测试环境未装配 Store 时静默跳过（auditReplace 同款守卫）
	}
	rec := store.ReplaceHistRecord{
		ProjectID:     p.ID,
		Pattern:       o.Pattern,
		Replacement:   o.Replacement,
		UseRegex:      o.UseRegex,
		CaseSensitive: o.CaseSensitive,
		WholeWord:     o.WholeWord,
		PreserveCase:  o.PreserveCase,
		Files:         len(res.Changed),
		Hits:          res.TotalHits,
		Skipped:       len(res.Skipped),
		Conflicts:     len(res.Conflicts),
		Changed:       make([]store.ReplaceHistFile, 0, len(res.Changed)),
	}
	for _, f := range res.Changed {
		rec.Changed = append(rec.Changed, store.ReplaceHistFile{Path: f.Path, Hits: f.Hits})
	}
	if res.Backup != nil {
		rec.BackupName = res.Backup.Name
		rec.BackupEmpty = res.Backup.Empty
	}
	if patchContent != "" {
		rec.PatchBytes = len(patchContent)
		if len(patchContent) <= store.ReplaceHistPatchMaxBytes {
			rec.PatchB64 = base64.StdEncoding.EncodeToString([]byte(patchContent))
		} else {
			rec.PatchTruncated = true
			slog.Info("replacehist patch too large to embed; restore falls back to artifacts file",
				"project", p.ID, "backup", rec.BackupName, "bytes", rec.PatchBytes)
		}
	}
	if saved := store.Get().ReplaceHist.Append(rec); saved.ID == "" {
		slog.Warn("replacehist append failed", "project", p.ID)
	}
}

// replaceHistEntry 历史清单项：元数据视图（PatchB64 剥离——清单面不背补丁
// 字节，20 份 × 2.7MB base64 的清单响应是不可接受的；还原端点按需取补丁）
type replaceHistEntry struct {
	ID             string                  `json:"id"`
	Time           string                  `json:"time"`
	Pattern        string                  `json:"pattern"`
	Replacement    string                  `json:"replacement,omitempty"`
	UseRegex       bool                    `json:"useRegex,omitempty"`
	CaseSensitive  bool                    `json:"caseSensitive,omitempty"`
	WholeWord      bool                    `json:"wholeWord,omitempty"`
	PreserveCase   bool                    `json:"preserveCase,omitempty"`
	Files          int                     `json:"files"`
	Hits           int                     `json:"hits"`
	Skipped        int                     `json:"skipped,omitempty"`
	Conflicts      int                     `json:"conflicts,omitempty"`
	Changed        []store.ReplaceHistFile `json:"changed,omitempty"`
	BackupName     string                  `json:"backupName,omitempty"`
	BackupEmpty    bool                    `json:"backupEmpty,omitempty"`
	PatchBytes     int                     `json:"patchBytes,omitempty"`
	PatchTruncated bool                    `json:"patchTruncated,omitempty"`
	// Restorable 还原原料在位（内嵌补丁或 artifacts 文件至少有一路）；
	// false = 只剩历史元数据（备份被清且未内嵌/留档时备份失败——不可还原
	// 的条目按钮置灰，不做点了才失败的假入口）
	Restorable bool `json:"restorable"`
}

func toHistEntry(rec store.ReplaceHistRecord) replaceHistEntry {
	e := replaceHistEntry{
		ID:             rec.ID,
		Time:           rec.Time.Format(time.RFC3339),
		Pattern:        rec.Pattern,
		Replacement:    rec.Replacement,
		UseRegex:       rec.UseRegex,
		CaseSensitive:  rec.CaseSensitive,
		WholeWord:      rec.WholeWord,
		PreserveCase:   rec.PreserveCase,
		Files:          rec.Files,
		Hits:           rec.Hits,
		Skipped:        rec.Skipped,
		Conflicts:      rec.Conflicts,
		Changed:        rec.Changed,
		BackupName:     rec.BackupName,
		BackupEmpty:    rec.BackupEmpty,
		PatchBytes:     rec.PatchBytes,
		PatchTruncated: rec.PatchTruncated,
	}
	e.Restorable = rec.PatchB64 != "" || (rec.BackupEmpty && len(rec.Changed) > 0) || replaceHistArtifactExists(rec)
	return e
}

// replaceHistArtifactExists 内嵌补丁缺失时 artifacts 文件是否仍在（清账前）
func replaceHistArtifactExists(rec store.ReplaceHistRecord) bool {
	if rec.BackupName == "" || !validBackupName(rec.BackupName) {
		return false
	}
	_, err := os.Stat(filepath.Join(replaceBackupsProjectDir(rec.ProjectID), rec.BackupName))
	return err == nil
}

// ReplaceHistoryList GET /api/projects/:id/replace/history
// 历史清单（新→旧）：设置·安全「替换历史」面板与 agent 观测面共读。
// 读面不设防（resolve 族同构）：条目是本应用的功能性历史，无凭据语义
func ReplaceHistoryList(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	recs := store.Get().ReplaceHist.List(p.ID, 0)
	out := make([]replaceHistEntry, 0, len(recs))
	for _, rec := range recs {
		out = append(out, toHistEntry(rec))
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// errRestoreConflictStable 还原冲突稳定标记：checkout+apply 链的 apply 段失败
// （暂存区在替换后被推进，补丁对新基面失配）——工作区已归暂存区态，备份补丁
// 仍在历史条目（artifacts 副本 + 内嵌 base64）可重试。文本唯一事实源在
// errmarkers 注册表（P-20261004-29，前端 KNOWN_ERROR_I18N 对账），此处保名别名
var errRestoreConflictStable = errmarkers.ReplaceBackupStale

// resolveRestorePatch 还原补丁取数：内嵌 base64 优先，回落 artifacts 文件；
// BackupEmpty（替换前工作区干净）无补丁可取属合法形态（还原=checkout 归零）。
// 返回 (patch, error)——patch 为空即无需 apply 段
func resolveRestorePatch(rec store.ReplaceHistRecord) (string, error) {
	if rec.PatchB64 != "" {
		patch, err := base64.StdEncoding.DecodeString(rec.PatchB64)
		if err != nil {
			return "", fmt.Errorf("embedded backup patch corrupt: %w", err)
		}
		return string(patch), nil
	}
	if rec.BackupName != "" {
		if !validBackupName(rec.BackupName) {
			return "", fmt.Errorf("invalid backup name")
		}
		data, err := os.ReadFile(filepath.Join(replaceBackupsProjectDir(rec.ProjectID), rec.BackupName))
		if err != nil {
			return "", fmt.Errorf("backup patch purged or unreadable")
		}
		return string(data), nil
	}
	return "", nil
}

// RestoreReplaceHistory POST /api/projects/:id/replace/history/:hid/restore
// 一键还原：把该条替换改写过的文件回滚到替换前现场。ProjectHardLock 互斥
// （与批量替换同锁面）；agent 令牌走 guardedRoutes「批量替换还原」高危审批。
// checkout+apply 两段在 git 写队列串行域内执行，与并发写族互斥
func RestoreReplaceHistory(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	hid := c.Param("hid")
	rec, ok := store.Get().ReplaceHist.Get(p.ID, hid)
	if !ok {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "replace history entry not found", nil)
		return
	}
	if len(rec.Changed) == 0 {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "entry has no changed files to restore", nil)
		return
	}
	patch, err := resolveRestorePatch(rec)
	if err != nil {
		shared.Error(c, http.StatusGone, err.Error(), nil)
		return
	}

	// untracked 命中文件不在还原范围（无 index 基线，备份边界同款如实回告）：
	// checkout 圈定 tracked 子集，单文件本地历史（P-130）兜此类文件的还原
	paths := make([]string, 0, len(rec.Changed))
	for _, f := range rec.Changed {
		paths = append(paths, f.Path)
	}
	tracked, err := git.ListTrackedFiles(p.Path, paths)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "restore failed: cannot list tracked files", err)
		return
	}
	untracked := len(paths) - len(tracked)

	// checkout 归零先于 apply（顺序即正确性）：备份补丁的 a 侧 = 暂存区内容、
	// 上下文行含替换前文本——对替换后的工作区 apply 必上下文失配（正向预检
	// 同样失配，预检无意义）；先 checkout 把圈定路径回暂存区态（=补丁 a 侧
	// 基面），正向 apply 才能确定性重放。空备份（替换前工作区干净）无补丁段，
	// checkout 即完成还原。apply 万一失败（checkout 与 apply 之间暂存区被并发
	// 推进，写队列拦不住该窗口）：工作区已归暂存区态、备份补丁仍在（artifacts
	// 副本 + 内嵌 base64），可重试或手动重放——如实回告不让用户猜
	if err := git.DiscardWorktreeChanges(p.Path, tracked); err != nil {
		shared.Error(c, http.StatusInternalServerError, "restore failed: checkout refused", err)
		return
	}
	// 还原边界=checkout 圈定（tracked 子集）：备份补丁自 P-20261004-56 起含
	// untracked new-file 段，整补丁 apply 会撞上仍在工作区的已替换 untracked
	// 文件（"already exists in working directory" 整体失败、还原恒 409）——
	// 先裁剪到 tracked 路径再 apply，与上方 ls-files 滤除口径一致；裁剪后为
	// 空（全部命中都在还原范围外）时 checkout 已完成还原，无需 apply
	patch = git.FilterPatchToPaths(patch, tracked)
	if patch != "" {
		if err := git.ApplyPatch(p.Path, patch, false); err != nil {
			// 稳定标记走 publicMsg 通道（devMode 下 err 原文会覆盖响应体——
			// KNOWN_ERROR_I18N 契约要求标记恒在响应里），git 原始错误另记日志
			slog.Warn("replace restore apply failed", "project", p.ID, "err", err)
			shared.Error(c, http.StatusConflict,
				errRestoreConflictStable+" (index changed since the replacement; workspace is at staged state, backup patch kept in history)", nil)
			return
		}
	}

	auditReplaceRestore(c, p, rec)
	slog.Info("replace history restored", "project", p.ID, "entry", hid,
		"files", len(tracked), "untracked", untracked)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"restored":  tracked,
		"untracked": untracked, // 未还原的 untracked 命中文件数（>0 时前端点名提示）
	}})
}

// auditReplaceRestore 还原入账（file.replace_restore）：只记元数据（项目/
// 文件数/历史条目 ID），pattern/replacement 不入账（auditReplace 同纪律）
func auditReplaceRestore(c *gin.Context, p *config.ProjectConfig, rec store.ReplaceHistRecord) {
	if store.Get() == nil || store.Get().Audit == nil {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileReplaceRestore,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: restored %d file(s) from replace history %s", p.Name, len(rec.Changed), rec.ID),
	})
}
