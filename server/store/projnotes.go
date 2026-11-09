package store

import (
	"encoding/json"
	"errors"
	"time"
)

// 项目笔记（P-20261002-110，人机共享便签层）：项目一文档的 markdown 便签，
// 人经「笔记」面板写交接说明，agent 经 ops 手册登记的 REST 通道读写同一份——
// 人机双向的项目级共享记忆（面板与 agent 并发为 last-writer-wins：
// 整文档替换写，filestore 同 kind 串行 + tmp 原子改名保证最终内容必为
// 某一方的完整版本，无读改写交错面，无需乐观锁版本号）。
//
// 存量形态（P-20261107-2 起）：生产面已无写入口——projnotes kind 只作启动迁移
// 读源（MigrateLegacyProjectNotes → 项目默认篇 → P-20261108-3 单库化并入全局
// 笔记库）；仓储本体保留给降级窗口兼容与迁移测试播种旧数据面。ErrNotesTooLarge /
// ProjNotesMaxBytes 仍是笔记库（notesmulti）共用的内容上限常量。

// ErrNotesTooLarge 笔记内容超出 ProjNotesMaxBytes
var ErrNotesTooLarge = errors.New("project notes too large")

// projNotesKind 文档存储 kind 名
const projNotesKind = "projnotes"

// ProjNotesMaxBytes 笔记内容 UTF-8 字节上限：256KB 足够一部中篇交接文档，
// 同时防止把车道 1 文档存成大块数据（大块归车道 2 纪律）
const ProjNotesMaxBytes = 256 << 10 // 256KB

// ProjectNote 单项目的笔记文档
type ProjectNote struct {
	Content   string    `json:"content"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ProjectNotesStore 项目笔记（项目一文档，key=projectID）
type ProjectNotesStore interface {
	// Get 读取笔记；项目从未写过时返回 ErrNotFound（调用方按空笔记呈现）
	Get(projectID string) (ProjectNote, error)
	// Put 全量覆盖写入（upsert；内容超 ProjNotesMaxBytes 返回 ErrNotesTooLarge）
	Put(projectID string, content string) error
	// Delete 删除项目笔记（项目删除级联清理，防孤儿文档）
	Delete(projectID string) error
}

type projectNotesRepo struct{ doc DocumentStore }

// NewProjectNotesRepo 构造项目笔记仓储（测试用独立实例，不污染全局 Store）
func NewProjectNotesRepo(doc DocumentStore) ProjectNotesStore {
	return &projectNotesRepo{doc: doc}
}

// Get 读取笔记。文档不存在/损坏按 ErrNotFound 处理——便签语义下空即无，
// 坏数据不阻断面板打开（重写即修复）
func (r *projectNotesRepo) Get(projectID string) (ProjectNote, error) {
	data, err := r.doc.Get(projNotesKind, projectID)
	if err != nil {
		return ProjectNote{}, ErrNotFound
	}
	var n ProjectNote
	if json.Unmarshal(data, &n) != nil {
		return ProjectNote{}, ErrNotFound
	}
	return n, nil
}

// Put 全量覆盖写入（upsert）。content 按 UTF-8 字节计长，超上限拒绝落库
func (r *projectNotesRepo) Put(projectID string, content string) error {
	if len(content) > ProjNotesMaxBytes {
		return ErrNotesTooLarge
	}
	n := ProjectNote{Content: content, UpdatedAt: time.Now()}
	data, err := json.Marshal(n)
	if err != nil {
		return err
	}
	return r.doc.Upsert(projNotesKind, projectID, data)
}

// Delete 删除项目笔记（不存在时静默成功——级联清理的尽力而为语义）
func (r *projectNotesRepo) Delete(projectID string) error {
	if err := r.doc.Delete(projNotesKind, projectID); err != nil && err != ErrNotFound {
		return err
	}
	return nil
}
