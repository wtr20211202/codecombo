package project

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 笔记库 handler 实现体（P-20261107-2 多篇 → P-20261108-3 单库化）──
//
// notepad 式多文档笔记库的 REST 实现：人经笔记独立视图新建/列表/切换，agent
// 经 /api/notes 族全 CRUD（list/create/read/write/rename/restore/delete，重命名
// 折叠进 PUT 的可选 title 字段）。端点族声明与手册分节见 notesglobal.go。
//
// 覆盖保护三件套：PUT 可选 baseUpdatedAt（不符 409 携 currentContent/
// currentUpdatedAt——files 写链 BaseHash 同款形态）；不传保持 last-writer-wins。
//
// 回收站：DELETE 软删（可恢复 30 天），agent 通道只有软删+restore——硬删
// （?purge=1）仅人侧（agent 令牌硬拒 403，无需 AgentGuard：可恢复 30 天 +
// 自托管 + 锁令牌门内，真实暴露面仅此）。
//
// 变更广播：写路径成功后 opschannel notes.updated（{projectId,noteId,action}），
// 前端直通分发 sc-ops:notes.updated——已挂载面板即时重拉，防列表/内容陈旧。
//
// 作用域：实现体只认 notesScope（作用域键 + 审计归属名），由端点族 resolver
// 产出。P-20261108-3 单库化后唯一端点族是全局库（resolver 固定保留哨兵
// store.GlobalNotesScope）——项目族 /api/projects/:id/notes(-multi) 随「全局库|
// 项目库」双源切换一并退役，存量项目篇经 notesmigrate.go 并入全局库。resolver
// 形态保留为作用域扩展点（错误码/审计/广播/回收站语义天然一致不分叉）。

// notesScope 笔记作用域：key 是仓储复合键的作用域段（store.GlobalNotesScope，
// 同时是 notes.updated 广播的 projectId 载荷），label 是审计 Detail 的归属名
type notesScope struct {
	key   string
	label string
}

// notesScopeResolver 从请求解析作用域；返回 false 时错误响应已写出
type notesScopeResolver func(c *gin.Context) (notesScope, bool)

// notesBodyMaxBytes 请求体粗上限：JSON 转义最坏 6×/字节（\u00XX），给足
// 合法载荷余量；精确 256KB 上限由仓储层按解码后内容判定（413 语义一致）
const notesBodyMaxBytes = 4 << 20

// notesTitleMaxRunesExport 文件名取标题时的截断保护（导出文件名过长部分
// 文件系统拒收；标题本体上限 200 字节已由仓储校验）
const notesExportNameMax = 60

// notesMeta 列表条目（绝不内联 content——256KB×100 篇内联会拖垮面板首开，
// 内容单篇 GET 取）
type notesMeta struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	UpdatedAt time.Time  `json:"updatedAt"`
	Size      int        `json:"size"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"` // 仅回收站视图携带
	DeletedBy string     `json:"deletedBy,omitempty"`
}

func toNotesMeta(n store.MultiNote) notesMeta {
	return notesMeta{ID: n.ID, Title: n.Title, UpdatedAt: n.UpdatedAt, Size: n.Size(), DeletedAt: n.DeletedAt, DeletedBy: n.DeletedBy}
}

// notesActionPayload notes.updated 广播载荷（ops-events 快照契约）。projectId
// 为作用域键：全局笔记库取保留哨兵 store.GlobalNotesScope（"_global"——字段名
// 沿用多篇时代的项目维度命名，载荷形状不变，旧消费方按项目 id 对位天然忽略）
type notesActionPayload struct {
	ProjectID string `json:"projectId"`
	NoteID    string `json:"noteId,omitempty"` // 空 = 作用域级（清单可能已变，重拉列表）
	Action    string `json:"action"`           // saved|created|renamed|trashed|restored|purged|migrated
}

// broadcastNotesUpdated 笔记写路径的统一广播口（异步不阻塞请求——opschannel
// BroadcastEvent 既有语义）
func broadcastNotesUpdated(projectID, noteID, action string) {
	opschannel.BroadcastEvent(opschannel.EventNotesUpdated, notesActionPayload{
		ProjectID: projectID, NoteID: noteID, Action: action,
	})
}

// noteSessionAttribution 软删操作者归属：agent 令牌 → agent（携会话 id 供对账），
// 用户解锁令牌 → human
func noteSessionAttribution(c *gin.Context) string {
	if middleware.IsAgentTokenRequest(c) {
		if sid := c.GetHeader("X-Session-ID"); sid != "" {
			return "agent:" + sid
		}
		return "agent"
	}
	return "human"
}

// ── 作用域参数化实现体（端点族 resolver 注入作用域）──

// notesList 清单（在册 / ?trash=1 回收站视图）；元数据面不内联 content
func notesList(c *gin.Context, resolve notesScopeResolver) {
	sc, ok := resolve(c)
	if !ok {
		return
	}
	notes, err := store.Get().MultiNotes.List(sc.key)
	if err != nil {
		// 存储层故障非「篇不存在」——不进 code 面（5xx 内部错误契约：agent
		// 不对 5xx 重试风暴），List 前 404 语义属 Get 单篇
		shared.Error(c, http.StatusInternalServerError, "failed to list notes", err)
		return
	}
	trash := c.Query("trash") == "1"
	out := make([]notesMeta, 0, len(notes))
	for _, n := range notes {
		if n.Live() == trash { // 在册视图留 Live（跳过软删），回收站视图留软删
			continue
		}
		out = append(out, toNotesMeta(n))
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// notesCreate 新建一篇 → 201（服务端生成 id，请求体不收 id）
func notesCreate(c *gin.Context, resolve notesScopeResolver) {
	sc, ok := resolve(c)
	if !ok {
		return
	}
	shared.LimitBody(c, notesBodyMaxBytes)

	var req struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.ErrorWithCode(c, shared.CodeNotesTooLarge, "Notes too large",
				errors.New("note content exceeds 256KB limit"))
			return
		}
		shared.Error(c, http.StatusBadRequest, "invalid request body", err)
		return
	}
	n, err := store.Get().MultiNotes.Create(sc.key, req.Title, req.Content)
	if err != nil {
		notesError(c, err)
		return
	}
	broadcastNotesUpdated(sc.key, n.ID, "created")
	c.JSON(http.StatusCreated, gin.H{"data": n})
}

// notesGet 读单篇（回收站内的篇同样可读——恢复前预览）
func notesGet(c *gin.Context, resolve notesScopeResolver) {
	sc, ok := resolve(c)
	if !ok {
		return
	}
	n, err := store.Get().MultiNotes.Get(sc.key, c.Param("noteId"))
	if err != nil {
		notesError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": n})
}

// notesPut 保存（title 携带即重命名；baseUpdatedAt 携带即乐观校验）
func notesPut(c *gin.Context, resolve notesScopeResolver) {
	sc, ok := resolve(c)
	if !ok {
		return
	}
	shared.LimitBody(c, notesBodyMaxBytes)

	var req struct {
		Content       string     `json:"content"`
		Title         *string    `json:"title"`
		BaseUpdatedAt *time.Time `json:"baseUpdatedAt"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.ErrorWithCode(c, shared.CodeNotesTooLarge, "Notes too large",
				errors.New("note content exceeds 256KB limit"))
			return
		}
		shared.Error(c, http.StatusBadRequest, "invalid request body", err)
		return
	}
	base := time.Time{}
	if req.BaseUpdatedAt != nil {
		base = *req.BaseUpdatedAt
	}
	n, err := store.Get().MultiNotes.Update(sc.key, c.Param("noteId"), req.Title, req.Content, base)
	if errors.Is(err, store.ErrNotFound) && c.Param("noteId") == store.DefaultNoteID {
		// 默认篇是空库占位的虚拟实体（well-known id 特例，其余 id 维持
		// Create/Update 分离与「服务端生成 id」纪律）：直写不存在时 upsert
		// 落真身。面板空库占位篇首写（无 baseUpdatedAt）即经此路径落盘
		// （「打开即可打字」契约）
		n, err = store.Get().MultiNotes.UpsertDefault(sc.key, req.Content, req.Title)
	}
	if err != nil {
		notesError(c, err)
		return
	}
	// 动作判别：title 携带（PUT 语义=重命名+保存）→ renamed，否则 saved——
	// 广播是元数据面的「清单可能变了」信号，消费方收到即重拉，不依赖动作精确性
	action := "saved"
	if req.Title != nil {
		action = "renamed"
	}
	broadcastNotesUpdated(sc.key, n.ID, action)
	c.JSON(http.StatusOK, gin.H{"data": n})
}

// notesDelete 软删进回收站；?purge=1 彻底删除（agent 令牌 403——agent 通道只有
// 可恢复的软删）
func notesDelete(c *gin.Context, resolve notesScopeResolver) {
	sc, ok := resolve(c)
	if !ok {
		return
	}
	noteID := c.Param("noteId")

	if c.Query("purge") == "1" {
		if middleware.IsAgentTokenRequest(c) {
			shared.Error(c, http.StatusForbidden,
				"agent tokens cannot purge notes (soft delete is recoverable for 30 days)",
				errors.New("notes purge is human-only"))
			return
		}
		if err := store.Get().MultiNotes.Purge(sc.key, noteID); err != nil {
			notesError(c, err)
			return
		}
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditNotesPurge,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s: %s", sc.label, noteID),
		})
		broadcastNotesUpdated(sc.key, noteID, "purged")
		c.JSON(http.StatusOK, gin.H{"message": "purged"})
		return
	}

	if err := store.Get().MultiNotes.SoftDelete(sc.key, noteID, noteSessionAttribution(c)); err != nil {
		notesError(c, err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditNotesDelete,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s", sc.label, noteID),
	})
	broadcastNotesUpdated(sc.key, noteID, "trashed")
	c.JSON(http.StatusOK, gin.H{"message": "moved to trash"})
}

// notesRestore 回收站恢复（幂等）
func notesRestore(c *gin.Context, resolve notesScopeResolver) {
	sc, ok := resolve(c)
	if !ok {
		return
	}
	noteID := c.Param("noteId")
	if err := store.Get().MultiNotes.Restore(sc.key, noteID); err != nil {
		notesError(c, err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditNotesRestore,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s", sc.label, noteID),
	})
	broadcastNotesUpdated(sc.key, noteID, "restored")
	c.JSON(http.StatusOK, gin.H{"message": "restored"})
}

// notesExport 单篇导出（md 缺省 / txt）
func notesExport(c *gin.Context, resolve notesScopeResolver) {
	sc, ok := resolve(c)
	if !ok {
		return
	}
	n, err := store.Get().MultiNotes.Get(sc.key, c.Param("noteId"))
	if err != nil {
		notesError(c, err)
		return
	}
	format := strings.ToLower(c.DefaultQuery("format", "md"))
	if format != "md" && format != "txt" {
		format = "md"
	}
	name := exportNoteName(n.Title, format)
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(n.Content))
}

// exportNoteName 导出文件名：标题净化截断 + 扩展名；空标题回落日期名
func exportNoteName(title, format string) string {
	name := strings.TrimSpace(title)
	if name == "" {
		name = "note-" + time.Now().Format("20060102-150405")
	}
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		}
		return r
	}, name)
	r := []rune(name)
	if len(r) > notesExportNameMax {
		r = r[:notesExportNameMax]
	}
	return string(r) + "." + format
}

// notesError notes 族统一错误分流（code 契约见 shared/errors.go notes 域）
func notesError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		shared.ErrorWithCode(c, shared.CodeNotesNotFound, "note not found", nil)
	case errors.Is(err, store.ErrNotesConflict):
		// 冲突载荷携当前版本（errors.As 取仓储包装的当前文档——files.conflict
		// currentContent 同款形态），面板据此呈现「载入服务端版本」
		var nce *store.NotesConflictError
		if errors.As(err, &nce) {
			shared.JSONWithCode(c, shared.CodeNotesConflict, gin.H{
				"error":            "note was modified externally",
				"currentContent":   nce.Current.Content,
				"currentUpdatedAt": nce.Current.UpdatedAt,
			})
			return
		}
		shared.ErrorWithCode(c, shared.CodeNotesConflict, "note was modified externally", nil)
	case errors.Is(err, store.ErrNotesTooLarge):
		shared.ErrorWithCode(c, shared.CodeNotesTooLarge, "Notes too large",
			errors.New("note content exceeds 256KB limit"))
	case errors.Is(err, store.ErrNotesGlobalLimitReached):
		// 笔记库额度（P-20261108-3 单库化后唯一额度档）：只挡新增，不触发任何删除
		shared.ErrorWithCode(c, shared.CodeNotesGlobalLimit, "global notes limit reached",
			errors.New("global notes limit is 100 (trash included)"))
	case errors.Is(err, store.ErrNotesTitleTooLong):
		shared.ErrorWithCode(c, shared.CodeNotesTitleTooLong, "note title too long",
			errors.New("note title limit is 200 bytes"))
	default:
		shared.Error(c, http.StatusInternalServerError, "failed to save note", err)
	}
}
