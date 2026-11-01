package files

import (
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/filepolicy"
	"codecombo/server/fsattr"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 本地文件历史（P-20261002-130）：写路径快照钩子（WriteFile/RenameFile 覆盖前
// 留档）+ 查询/恢复三端点。快照策略在调用方（本包）：存在且为常规文件、不超
// fileHistoryMaxFileBytes、filepolicy 判非二进制才留档；存储与容量治理在
// store.FileHistory。快照为尽力而为——任何失败记日志后放行原写入，安全网
// 绝不阻塞业务写路径。

// fileHistoryMaxFileBytes 单文件快照字节上限：4MB 覆盖一切常规源码/文本留档
// 场景，同时防单版本吃掉每项目 50MB 容量预算的大头
const fileHistoryMaxFileBytes int64 = 4 << 20

// NormalizeRelPath 项目相对路径归一（正斜杠 + Clean）：快照键与查询/恢复共用
// 一把尺子，写进快照的 path 形态（"a//b"、"./a"、Windows 反斜杠）与后续查询
// 形态归一后必然同键。返回空串表示归一后指向项目根（不是文件，调用方跳过）
func NormalizeRelPath(rel string) string {
	norm := filepath.ToSlash(filepath.Clean(strings.TrimSpace(rel)))
	if norm == "." || strings.HasPrefix(norm, "../") {
		return ""
	}
	return norm
}

// isEditableTextFile 判定 absPath 是否可整读整写的文本文件：常规文件、不超
// maxBytes、filepolicy 判非二进制（NUL 探测 + UTF-16 BOM 豁免）。本地历史
// 快照与批量替换（P-20261004-114）共用的甄别口径——「编辑器打不开的不碰」
func isEditableTextFile(absPath string, maxBytes int64) bool {
	info, err := os.Stat(absPath)
	if err != nil || info.IsDir() || info.Size() > maxBytes {
		return false
	}
	ext := filepolicy.ExtOf(absPath)
	if filepolicy.IsBinaryExt(ext) {
		return false
	}
	hasNUL := false
	if filepolicy.NeedsSniff(ext) {
		if nul, e := filepolicy.SniffHasNUL(absPath, filepolicy.SniffMax); e == nil {
			hasNUL = nul && !filepolicy.HasUTF16BOM(absPath)
		}
	}
	return filepolicy.KindFor(ext, info.Size(), hasNUL).Kind != filepolicy.KindBinary
}

// snapshotForHistory 覆盖前快照：把 absPath 的磁盘现内容按 relPath 留档。
// 文件不存在（首次创建无旧内容可保）、目录、超限、二进制、留档失败均静默跳过
// （尽力而为语义，绝不阻塞调用方的原写入）
func snapshotForHistory(projectID, relPath, absPath string) {
	if store.Get() == nil || store.Get().FileHistory == nil {
		return // 测试环境未装配 Store 时静默跳过
	}
	if relPath == "" {
		return // 归一后指向项目根（非文件路径）
	}
	if !isEditableTextFile(absPath, fileHistoryMaxFileBytes) {
		return
	}
	content, err := os.ReadFile(absPath)
	if err != nil {
		slog.Warn("filehistory snapshot read failed", "path", absPath, "err", err)
		return
	}
	if _, err := store.Get().FileHistory.Append(projectID, relPath, content); err != nil {
		slog.Warn("filehistory snapshot append failed", "project", projectID, "rel", relPath, "err", err)
	}
}

// atomicWriteFile tmp(唯一)+rename 原子落盘（P-104 语义）：WriteFile 保存与
// 本地历史恢复共用同一条写入链路，恢复写回自动继承冲突防护之外的全部既有行为。
// 归因账 API 写预打标（P-20261005-170）也在此收口——保存/恢复/批量替换三条
// 链同走本函数，落盘前打标（事件可能早于写完成到达，落盘后补标输给竞态）
func atomicWriteFile(absPath string, data []byte) error {
	// 自环标记（P-20261005-15）：本函数是编辑器保存/批量替换/历史恢复的共同
	// 落盘口，标记先行让 watcher 把随后的 fsnotify 事件判为工作台自身写入
	markSelfWrite(absPath)
	fsattr.NoteAPIWrite(absPath)
	tmp, err := uniqueTmp(absPath)
	if err != nil {
		return err
	}
	// tmp 路径同标（P-20261005-15）：tmp 名保留目标前缀（.env → .env.sc-tmp-*），
	// 敏感名模式照样命中，而 Create 事件先于 rename 落在 tmp 上——不标则工作台
	// 自己的每次保存都被外部写入观测误记为「外部改了 .env.sc-tmp-*」（e2e 实测）
	markSelfWrite(tmp)
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, absPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// FileHistoryList GET /api/projects/:id/file/history?path= — 版本列表（新→旧）。
// 文件已被删除/改名后仍可查（快照按路径独立于磁盘存在），供恢复入口使用
func FileHistoryList(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	rel, ok := historyRel(c, p.Path, c.Query("path"))
	if !ok {
		return
	}
	versions, err := store.Get().FileHistory.List(p.ID, rel)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": versions})
}

// historyRel 历史端点的路径闸门：原始 path 先过 SafeJoinProject（与写入端点
// 同标准——穿越/伪装/外逃一律 403），再归一为快照键（正斜杠 + Clean）。归一后
// 指向项目根（" 目录自身"）不是文件，回 400。返回 ok=false 表示已写响应
func historyRel(c *gin.Context, root, rawPath string) (string, bool) {
	if _, err := SafeJoinProject(root, rawPath); err != nil {
		shared.Error(c, http.StatusForbidden, err.Error(), nil)
		return "", false
	}
	rel := NormalizeRelPath(rawPath)
	if rel == "" {
		shared.Error(c, http.StatusBadRequest, "path is required", nil)
		return "", false
	}
	return rel, true
}

// FileHistoryContent GET /api/projects/:id/file/history/content?path=&id= —
// 单版内容。文本经 decodeText 解码（GBK/UTF-16 历史版可读），供前端 diff
// 左侧取数；私有不落缓存（读取面 no-store 同 P-121 口径）
func FileHistoryContent(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	rel, ok := historyRel(c, p.Path, c.Query("path"))
	if !ok {
		return
	}
	content, err := store.Get().FileHistory.Content(p.ID, rel, c.Query("id"))
	if err == store.ErrNotFound || err == store.ErrInvalidArg {
		shared.Error(c, http.StatusNotFound, "history version not found", nil)
		return
	}
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}
	text, encoding := decodeText(content)
	resp := gin.H{"data": text, "size": len(content)}
	if encoding != "" {
		resp["encoding"] = encoding
	}
	c.JSON(http.StatusOK, resp)
}

// FileHistoryRestore POST /api/projects/:id/file/history/restore — 恢复指定
// 版本到磁盘。复用 WriteFile 的 SafeJoin + 原子写链路；恢复前对当前内容再做
// 一次快照（回滚本身可再撤销）。同内容恢复幂等（快照层同内容跳过不产生噪声）
func FileHistoryRestore(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Path string `json:"path"`
		ID   string `json:"id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "File operation failed", err)
		return
	}
	if req.Path == "" || req.ID == "" {
		shared.Error(c, http.StatusBadRequest, "path and id are required", nil)
		return
	}

	// 路径边界与写入端点同标准（兄弟目录前缀伪装 + 符号链接外逃均拦截）；
	// 快照键用归一形态（SafeJoinProject 只验边界，不改写路径形态）
	absPath, err := SafeJoinProject(p.Path, req.Path)
	if err != nil {
		shared.Error(c, http.StatusForbidden, err.Error(), nil)
		return
	}
	rel := NormalizeRelPath(req.Path)
	if rel == "" {
		shared.Error(c, http.StatusBadRequest, "path is required", nil)
		return
	}

	content, err := store.Get().FileHistory.Content(p.ID, rel, req.ID)
	if err == store.ErrNotFound || err == store.ErrInvalidArg {
		shared.Error(c, http.StatusNotFound, "history version not found", nil)
		return
	}
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	// 恢复前快照当前内容：覆盖动作的后悔药覆盖恢复动作自身。目标文件已不存在
	//（被删后恢复）时跳过——无现内容可保
	snapshotForHistory(p.ID, rel, absPath)

	// 父目录可能已随删除消失（恢复被删文件场景）：先补齐再原子写
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}
	if err := atomicWriteFile(absPath, content); err != nil {
		shared.Error(c, http.StatusInternalServerError, "File operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "restored", "hash": contentHash(content)})
}
