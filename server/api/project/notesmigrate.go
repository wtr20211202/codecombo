package project

import (
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 笔记单库化迁移编排（P-20261108-3）──
//
// 旧项目作用域篇（P-20261107-2 notes-multi 时代的 <projectID>-<noteID> 键，含经
// MigrateLegacyProjectNotes 收编的单篇便签与项目回收站篇）并入全局笔记库，
// 标题带「[项目名] 」前缀、内容逐字保留。三入口共用 migrateNotesToGlobal：
//   ① 启动期（app.go 启动数据治理段——读路径零副作用红线下的启动期例外）
//   ② 手动续迁 POST /api/notes/migration（满额中止后用户腾出空间再续）
//   ③ 项目删除（DeleteProject 不再级联删笔记——「笔记独立不合项目关联」；趁
//      项目名还在尽力带前缀并入，满额则残留为孤儿篇，下轮按原标题并入）
// 满额即中止（评审修订：砍「迁入回收站」歧路——回收站 30 天硬清 = 无声丢失），
// 告知三面：启动日志 + 通知中心一条（app.go，动作直达笔记视图）+ 面板续迁
// 横幅（GET /api/notes/migration 只读计数）。审计每轮有迁入时一条汇总
// notes.migrated（不逐篇）。

// projectNoteLabels 项目 id → 迁移标题前缀名（项目名；名空回落根目录基名）。
// extra 追加/覆盖（项目删除入口：记录已摘除，经 extra 补回刚删项目的名字）
func projectNoteLabels(extra map[string]string) map[string]string {
	labels := map[string]string{}
	if projects, err := store.Get().Project.List(); err == nil {
		for _, p := range projects {
			labels[p.ID] = projectLabel(p.Name, p.Path)
		}
	}
	for id, name := range extra {
		labels[id] = name
	}
	return labels
}

// projectLabel 项目展示名（名空回落根目录基名——标准库取基名，不手拼分隔符）
func projectLabel(name, path string) string {
	if n := strings.TrimSpace(name); n != "" {
		return n
	}
	if path == "" {
		return ""
	}
	return filepath.Base(filepath.Clean(path))
}

// migrateNotesToGlobal 单库化迁移一轮：① 旧单篇键 → 项目默认篇（P-20261107-2
// 迁移前置——降级窗口回写的旧键同链收编）② 全部非全局作用域篇 → 全局库。
// 有迁入即审计一条汇总 + 广播一次作用域级 notes.updated（已挂载面板重拉清单）；
// 滞留篇如实告警。c 非空 = 请求入口（审计带 IP/rid）
func migrateNotesToGlobal(trigger string, c *gin.Context, extraLabels map[string]string) (store.NotesMigrationResult, error) {
	st := store.Get()
	if n, err := st.MultiNotes.MigrateLegacyProjectNotes(); err != nil {
		slog.Warn("projnotes legacy migration failed", "trigger", trigger, "err", err)
	} else if n > 0 {
		slog.Info("projnotes legacy notes migrated to project default notes", "trigger", trigger, "count", n)
	}
	res, err := st.MultiNotes.MigrateProjectNotesToGlobal(projectNoteLabels(extraLabels))
	if err != nil {
		slog.Warn("notes single-library migration failed", "trigger", trigger, "err", err)
		return res, err
	}
	if res.Migrated > 0 {
		ev := store.AuditEvent{
			Action: store.AuditNotesMigrated,
			Result: store.AuditResultSuccess,
			Detail: fmt.Sprintf("migrated %d, pending %d (trigger=%s)", res.Migrated, res.Pending, trigger),
		}
		if c != nil {
			ev.IP = c.ClientIP()
			middleware.AuditAppend(c, ev)
		} else {
			st.Audit.Append(ev)
		}
		// 服务端自发起（启动期/手动续迁/项目删除前三入口）——origin 恒空：
		// 迁移是作用域级批量并入，消费方按外部更新重拉（宁多刷不漏刷）
		broadcastNotesUpdated(store.GlobalNotesScope, "", "migrated", "")
		slog.Info("project notes merged into global notes library",
			"trigger", trigger, "migrated", res.Migrated, "pending", res.Pending)
	}
	if res.Pending > 0 {
		slog.Warn("project notes still pending migration into global notes library",
			"trigger", trigger, "pending", res.Pending, "globalFull", res.Full)
	}
	return res, nil
}

// MigrateNotesOnStartup 启动期入口（app.go 启动数据治理段调用；结果供组合根
// 决定是否入账满额通知）
func MigrateNotesOnStartup() store.NotesMigrationResult {
	res, _ := migrateNotesToGlobal("startup", nil, nil)
	return res
}

// migrateNotesOnProjectDelete 项目删除入口：项目记录已摘除，经 extra 补回刚删
// 项目的名字让其残留篇带前缀并入（尽力而为不阻断删除——失败/满额残留为孤儿
// 篇，下轮启动或手动续迁按原标题并入，零丢弃）
func migrateNotesOnProjectDelete(c *gin.Context, p *config.ProjectConfig) {
	if p == nil {
		return
	}
	_, _ = migrateNotesToGlobal("project-delete", c, map[string]string{p.ID: projectLabel(p.Name, p.Path)})
}

// GetNotesMigration GET /api/notes/migration —— 滞留计数（面板续迁横幅数据源；
// 只读：只列键不读文档，零写盘副作用）。full = 全局库已到额度上限
func GetNotesMigration(c *gin.Context) {
	pending, err := store.Get().MultiNotes.PendingProjectNotes()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "failed to count pending notes", err)
		return
	}
	full := false
	if pending > 0 {
		if n, err := store.Get().MultiNotes.CountLive(store.GlobalNotesScope); err == nil {
			full = n >= store.NotesMaxGlobal
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"pending": pending, "full": full}})
}

// PostNotesMigration POST /api/notes/migration —— 手动续迁（满额中止后腾出空间
// 再续；与启动期同一实现，幂等可重复调用）→ {migrated,pending,full}
func PostNotesMigration(c *gin.Context) {
	res, err := migrateNotesToGlobal("manual", c, nil)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "notes migration failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}
