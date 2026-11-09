package store

import (
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// 笔记库（P-20261107-2 多篇 → P-20261107-5 全局库独立化 → P-20261108-3 单库化）：
// notepad 式多文档笔记库——每篇一个独立文档（per-note 复合键
// <scope>-<noteID>），人经笔记独立视图新建/列表/切换管理，agent 经 ops 手册
// 登记的 /api/notes REST 通道全 CRUD。车道 1 结构化状态纪律：禁止单文档存
// 整个数组（snippets all 反例在册），故一 key 一篇。
//
// 单库化（P-20261108-3，真实使用定调「笔记独立不合项目关联」）：UI 与 REST
// 只剩全局库一个作用域（保留哨兵 GlobalNotesScope，键 _global-<noteID>）；
// 项目作用域（键 <projectID>-<noteID>）是 P-20261107-2 时代的存量形态——不再
// 有任何写入口（项目端点族退役、sync 笔记单元落地拒收），只由启动期 / 手动
// 续迁 / 项目删除前三入口经 MigrateProjectNotesToGlobal 并入全局库（标题带
// 「[项目名] 」前缀，满额即中止留待续迁，零丢弃）。仓储方法仍按作用域形参
// 参数化（迁移读写两侧需要），复合键只按 List(Prefix) 前缀消费、禁止按 '-'
// 反解拆分（uuid-uuid 反解必歧义）。
//
// 覆盖保护三件套：Update 支持可选 baseUpdatedAt 乐观校验（不符返回
// ErrNotesConflict 携当前文档——409 currentContent 同款形态），不传保持
// last-writer-wins 既有语义。
//
// 回收站：软删=同篇文档内 DeletedAt/DeletedBy 字段（单文档单原子写；
// 刻意不拆第二 kind——filestore 无跨键事务，双写必有半态）。List/Get 返回
// 原样含软删（调用方过滤），硬清走 PurgeDeletedBefore 定时 + 惰性把守。
// agent 通道无硬删（可恢复 30 天内即真实暴露面兜底）；人侧面板可彻底删除。
//
// 篇数上限 NotesMaxGlobal（超限 ErrNotesGlobalLimitReached，只挡新增不触发
// 任何删除）；回收站 30 天硬清（PurgeDeletedBefore 全 kind 扫描——「永不自动
// 清」只指活篇）。哨兵冲突校验：项目 id 一律服务端 uuid 生成（project.go/
// clone_task.go/sync 落位），uuid 形态天然不可能为 _global；启动迁移遇旧单篇
// 键 _global 跳过并告警。

// GlobalNotesScope 全局笔记库作用域哨兵（notes repo 保留字，与 AgentProjectID
// "__agent__" 并列登记）：复合键 <GlobalNotesScope>-<noteID>；notes.updated
// 广播的 projectId 取此值即「全局库已变」（前端作用域键同值对位）
const GlobalNotesScope = "_global"

// ErrNotesConflict baseUpdatedAt 与服务端当前版本不符（覆盖保护触发，
// handler 层转 409 携 currentContent）
var ErrNotesConflict = errors.New("note was modified externally")

// NotesConflictError 冲突面错误：包装 ErrNotesConflict 并携带服务端当前文档
// （handler 409 的 currentContent/currentUpdatedAt 载荷源——面板「载入服务端
// 版本」动作的数据源）。errors.Is 命中 ErrNotesConflict，errors.As 取载荷
type NotesConflictError struct{ Current MultiNote }

func (e *NotesConflictError) Error() string { return ErrNotesConflict.Error() }
func (e *NotesConflictError) Unwrap() error { return ErrNotesConflict }

// ErrNotesGlobalLimitReached 笔记库篇数超出 NotesMaxGlobal（只挡新增不触发
// 任何删除，handler 层转 notes.global_limit）。P-20261108-3 单库化后是唯一的
// 篇数额度错误（原项目档 ErrNotesLimitReached 随项目作用域写入口退役）
var ErrNotesGlobalLimitReached = errors.New("global notes limit reached")

// ErrNotesTitleTooLong 标题超出 NotesMaxTitleBytes
var ErrNotesTitleTooLong = errors.New("note title too long")

// notesMultiKind 文档存储 kind 名
const notesMultiKind = "notesmulti"

// DefaultNoteID 默认篇 id（well-known）：空库时面板合成的占位篇 id——首写经
// PUT /api/notes/default 由 UpsertDefault 落真身（「打开即可打字」契约）。
// P-20261107-2 时代它还是项目兼容端点 shim 的落点，旧单文档键（裸 projectID）
// 的启动迁移同样落 <projectID>-default（再由单库化迁移并入全局库）
const DefaultNoteID = "default"

// NotesMaxGlobal 笔记库篇数上限（按 key 计数含回收站内的软删篇——硬清后才
// 释放额度；P-20261108-3 单库化后各作用域统一此档，迁移并入同受此限）
const NotesMaxGlobal = 100

// NotesMaxTitleBytes 标题 UTF-8 字节上限（不强制唯一——tab 条按 updatedAt
// 排序区分，重名不折叠）
const NotesMaxTitleBytes = 200

// NotesTrashRetention 软删篇保留窗：超期由 ticker + 惰性把守双路径硬清
const NotesTrashRetention = 30 * 24 * time.Hour

// MultiNote 单篇笔记文档
type MultiNote struct {
	ID        string     `json:"id"`                  // noteID（不含项目前缀；服务端生成，REST 客户端不可指定）
	Title     string     `json:"title"`               // 显示名（≤200 字节，允许重复）
	Content   string     `json:"content"`             // markdown 正文（≤256KB 同 ProjNotesMaxBytes）
	CreatedAt time.Time  `json:"createdAt"`           //
	UpdatedAt time.Time  `json:"updatedAt"`           // 最后写入时刻（乐观校验基准 / 列表排序键）
	DeletedAt *time.Time `json:"deletedAt,omitempty"` // 软删时刻（nil=在册；非 nil=回收站）
	DeletedBy string     `json:"deletedBy,omitempty"` // 软删操作者标识（human / agent:<session>）
}

// Live 在册（未软删）
func (n MultiNote) Live() bool { return n.DeletedAt == nil }

// Size 内容字节数（列表元数据面用，不内联 content）
func (n MultiNote) Size() int { return len(n.Content) }

// MultiNotesStore 笔记库仓储（projectID 形参即作用域键：REST 面恒为全局库
// 哨兵 GlobalNotesScope；项目 id 作用域只剩单库化迁移读侧与测试面使用）
type MultiNotesStore interface {
	// Create 新建一篇（服务端生成 id；作用域篇数达上限返回 ErrNotesGlobalLimitReached）
	Create(projectID, title, content string) (MultiNote, error)
	// Update 全量覆盖写入。baseUpdatedAt 非零时与当前 UpdatedAt 比对，不符返回
	// ErrNotesConflict 携当前文档（调用方按 409 呈现 currentContent）；为零值
	// 保持 last-writer-wins。title nil = 不改标题（重命名折叠进 PUT 的可选字段）
	Update(projectID, noteID string, title *string, content string, baseUpdatedAt time.Time) (MultiNote, error)
	// Get 读取单篇（含软删篇原样返回——回收站恢复/预览需要；不存在 ErrNotFound）
	Get(projectID, noteID string) (MultiNote, error)
	// List 作用域全部篇（含软删原样返回，调用方按 Live() 过滤在册/回收站两视图）
	List(projectID string) ([]MultiNote, error)
	// CountLive 作用域额度计数（含回收站软删篇，新建前的额度校验）
	CountLive(projectID string) (int, error)
	// SoftDelete 软删进回收站（幂等：已软删再删成功返回）
	SoftDelete(projectID, noteID, by string) error
	// Restore 软删恢复（幂等：在册篇恢复成功返回）
	Restore(projectID, noteID string) error
	// Purge 彻底删除单篇（硬删；不存在视为已清，幂等成功）
	Purge(projectID, noteID string) error
	// PurgeDeletedBefore 硬清软删时刻早于 cutoff 的全部篇（30 天 ticker 巡检；
	// 全 kind 扫描，单条失败不阻断整轮返回已清计数）
	PurgeDeletedBefore(cutoff time.Time) (int, error)
	// UpsertDefault 默认篇 upsert（PUT /api/notes/default 直写——默认篇是空库
	// 占位的虚拟实体，直写即落真身；title 非 nil 时随建随改）
	UpsertDefault(projectID, content string, title *string) (MultiNote, error)
	// MigrateLegacyProjectNotes 启动期幂等迁移：旧单文档键（projnotes kind 裸
	// projectID）→ 默认篇 <projectID>-default。返回迁移篇数（读路径零副作用
	// 红线：迁移类操作一律启动期——CLAUDE.md 持久化三车道纪律）
	MigrateLegacyProjectNotes() (int, error)
	// MigrateProjectNotesToGlobal 单库化迁移（P-20261108-3）：全部非全局作用域
	// 篇并入全局库（labels = 项目 id → 标题前缀名；未登记作用域保原标题），
	// 全局库满额即中止（结果携 Pending/Full，留待续迁——零丢弃）。幂等：目标 id
	// 由「源键+内容」确定性派生，重跑/删源失败的残留只删源不重复入库
	MigrateProjectNotesToGlobal(labels map[string]string) (NotesMigrationResult, error)
	// PendingProjectNotes 只读计数：仍滞留非全局作用域的篇数（面板续迁提示数据源；
	// 只列键不读文档，零写盘副作用）
	PendingProjectNotes() (int, error)
}

// NotesMigrationResult 单库化迁移单轮结果
type NotesMigrationResult struct {
	// Migrated 本轮新并入全局库的篇数（命中既有确定性目标只删源的不计）
	Migrated int `json:"migrated"`
	// Pending 本轮结束仍滞留非全局作用域的篇数（满额中止 / 单篇写失败 / 删源失败）
	Pending int `json:"pending"`
	// Full 全局库满额中止（Pending>0 的主因——腾出空间后续迁）
	Full bool `json:"full"`
}

type multiNotesRepo struct {
	doc DocumentStore
	// mu 仓储自持互斥锁：Create/Update 的「读额度/读版本→写」两段间串行。
	// filestore 同 kind 写自带互斥但读-写两段无原子性——无锁时并发首写可双双
	// 通过额度校验（filestore.go Upsert 注记的 repo 自持锁要求的同款动机）
	mu sync.Mutex
}

// NewMultiNotesRepo 构造多篇笔记仓储（测试用独立实例，不污染全局 Store）
func NewMultiNotesRepo(doc DocumentStore) MultiNotesStore {
	return &multiNotesRepo{doc: doc}
}

// noteKey per-note 复合键：<projectID>-<noteID>（车道 1 一 key 一篇）
func noteKey(projectID, noteID string) string { return projectID + "-" + noteID }

// get 解码单篇；不存在/损坏按 ErrNotFound（便签语义：坏数据不阻断面板，
// 重写即修复——projnotes 同判据）
func (r *multiNotesRepo) get(projectID, noteID string) (MultiNote, error) {
	data, err := r.doc.Get(notesMultiKind, noteKey(projectID, noteID))
	if err != nil {
		return MultiNote{}, ErrNotFound
	}
	var n MultiNote
	if json.Unmarshal(data, &n) != nil {
		return MultiNote{}, ErrNotFound
	}
	return n, nil
}

// Create 新建一篇（服务端生成 noteID，客户端不可指定——REST Create 不收 id
// 字段）。互斥锁内「数额度→写」两段串行，并发首写不会双双越限
func (r *multiNotesRepo) Create(projectID, title, content string) (MultiNote, error) {
	if len(content) > ProjNotesMaxBytes {
		return MultiNote{}, ErrNotesTooLarge
	}
	if err := validateNoteTitle(title); err != nil {
		return MultiNote{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if n, err := r.countLiveLocked(projectID); err != nil {
		return MultiNote{}, err
	} else if n >= NotesMaxGlobal {
		return MultiNote{}, ErrNotesGlobalLimitReached
	}
	n := MultiNote{
		ID:        uuid.NewString(),
		Title:     title,
		Content:   content,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	data, err := json.Marshal(n)
	if err != nil {
		return MultiNote{}, err
	}
	if err := r.doc.Create(notesMultiKind, noteKey(projectID, n.ID), data); err != nil {
		return MultiNote{}, err
	}
	return n, nil
}

// Update 全量覆盖写入。baseUpdatedAt 非零时乐观校验（读版本→写两段在互斥锁
// 内，校验通过即写必落——锁内无他人可插入写）；为零值 last-writer-wins
func (r *multiNotesRepo) Update(projectID, noteID string, title *string, content string, baseUpdatedAt time.Time) (MultiNote, error) {
	if len(content) > ProjNotesMaxBytes {
		return MultiNote{}, ErrNotesTooLarge
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, err := r.get(projectID, noteID)
	if err != nil {
		return MultiNote{}, err
	}
	if !baseUpdatedAt.IsZero() && !cur.UpdatedAt.Equal(baseUpdatedAt) {
		// 冲突面携当前文档（handler 409 携 currentContent——files 写链
		// BaseHash+currentContent 同款载荷形态），errors.As 取值
		return MultiNote{}, &NotesConflictError{Current: cur}
	}
	if title != nil {
		if err := validateNoteTitle(*title); err != nil {
			return MultiNote{}, err
		}
		cur.Title = *title
	}
	cur.Content = content
	cur.UpdatedAt = time.Now()
	data, err := json.Marshal(cur)
	if err != nil {
		return MultiNote{}, err
	}
	if err := r.doc.Update(notesMultiKind, noteKey(projectID, noteID), data); err != nil {
		return MultiNote{}, err
	}
	return cur, nil
}

// Get 读取单篇（含软删原样——handler 层按需过滤）
func (r *multiNotesRepo) Get(projectID, noteID string) (MultiNote, error) {
	return r.get(projectID, noteID)
}

// List 作用域全部篇（含软删；updatedAt 降序——面板侧栏/tab 默认序）。
// List(Prefix)+逐条 Get：作用域 ≤100 篇上界护栏内，量级无 N+1 之忧
func (r *multiNotesRepo) List(projectID string) ([]MultiNote, error) {
	keys, _, err := r.doc.List(notesMultiKind, ListOpts{Prefix: projectID + "-"})
	if err != nil {
		return nil, err
	}
	out := make([]MultiNote, 0, len(keys))
	for _, k := range keys {
		n, err := r.get(projectID, trimProjectPrefix(projectID, k))
		if err != nil {
			continue // 并发删除窗口的 key 消失：跳过（快照语义）
		}
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// CountLive 作用域额度计数（含回收站软删篇）
func (r *multiNotesRepo) CountLive(projectID string) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.countLiveLocked(projectID)
}

// countLiveLocked 额度计数（调用方持 r.mu）。按 key 计数（含回收站软删篇）：
// 软删不释放额度——回收站面板可见可彻底删除，30 天硬清自动释放；若按在册计，
// key 总量上限会翻倍（100 在册 + 100 软删）失去护栏意义
func (r *multiNotesRepo) countLiveLocked(projectID string) (int, error) {
	notes, err := r.List(projectID)
	if err != nil {
		return 0, err
	}
	return len(notes), nil
}

// SoftDelete 软删进回收站（同篇文档单原子写；幂等）
func (r *multiNotesRepo) SoftDelete(projectID, noteID, by string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	n, err := r.get(projectID, noteID)
	if err != nil {
		return err
	}
	if !n.Live() {
		return nil // 已在回收站：幂等
	}
	now := time.Now()
	n.DeletedAt = &now
	n.DeletedBy = by
	return r.put(projectID, n)
}

// Restore 软删恢复（幂等）
func (r *multiNotesRepo) Restore(projectID, noteID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	n, err := r.get(projectID, noteID)
	if err != nil {
		return err
	}
	if n.Live() {
		return nil // 在册：幂等
	}
	n.DeletedAt = nil
	n.DeletedBy = ""
	return r.put(projectID, n)
}

// Purge 彻底删除单篇（硬删；不存在视为已清——巡检的尽力而为语义）
func (r *multiNotesRepo) Purge(projectID, noteID string) error {
	if err := r.doc.Delete(notesMultiKind, noteKey(projectID, noteID)); err != nil && err != ErrNotFound {
		return err
	}
	return nil
}

// PurgeDeletedBefore 硬清软删超期的篇。全 kind List（全局库与迁移滞留的项目
// 作用域篇一并覆盖——软删篇散在各作用域前缀下）；单条失败不阻断整轮
func (r *multiNotesRepo) PurgeDeletedBefore(cutoff time.Time) (int, error) {
	keys, _, err := r.doc.List(notesMultiKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		data, err := r.doc.Get(notesMultiKind, k)
		if err != nil {
			continue
		}
		var n MultiNote
		if json.Unmarshal(data, &n) != nil {
			continue // 损坏文档由 filestore 隔离机制承接，此处跳过
		}
		if n.DeletedAt == nil || n.DeletedAt.After(cutoff) {
			continue
		}
		// key = <scope>-<noteID>，硬删只需 key 不需反解 id
		if r.doc.Delete(notesMultiKind, k) == nil {
			removed++
		}
	}
	return removed, nil
}

// put 已取出的文档原样落盘（软删/恢复/更新共用——保持 id/title 不变）
func (r *multiNotesRepo) put(projectID string, n MultiNote) error {
	data, err := json.Marshal(n)
	if err != nil {
		return err
	}
	return r.doc.Update(notesMultiKind, noteKey(projectID, n.ID), data)
}

// trimProjectPrefix 复合键剥项目前缀得 noteID
func trimProjectPrefix(projectID, key string) string {
	if len(key) > len(projectID)+1 && key[:len(projectID)+1] == projectID+"-" {
		return key[len(projectID)+1:]
	}
	return key
}

// UpsertDefault 默认篇 upsert：不存在则创建（确定性 id=default——空库占位篇
// 首写落点），存在则全量覆盖（last-writer-wins）；title 非 nil 时随建随改
// （面板占位篇首写重命名同路径）
func (r *multiNotesRepo) UpsertDefault(projectID, content string, title *string) (MultiNote, error) {
	if len(content) > ProjNotesMaxBytes {
		return MultiNote{}, ErrNotesTooLarge
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, err := r.get(projectID, DefaultNoteID)
	if err != nil {
		if err != ErrNotFound {
			return MultiNote{}, err
		}
		n := MultiNote{
			ID:        DefaultNoteID,
			Title:     "",
			Content:   content,
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}
		if title != nil {
			n.Title = *title
		}
		data, err := json.Marshal(n)
		if err != nil {
			return MultiNote{}, err
		}
		if err := r.doc.Create(notesMultiKind, noteKey(projectID, DefaultNoteID), data); err != nil {
			return MultiNote{}, err
		}
		return n, nil
	}
	cur.Content = content
	if title != nil {
		cur.Title = *title
	}
	cur.UpdatedAt = time.Now()
	return cur, r.put(projectID, cur)
}

// MigrateLegacyProjectNotes 启动期幂等迁移：扫 projnotes kind 旧键（裸
// projectID）→ 落默认篇 <projectID>-default → 成功后删旧键。幂等矩阵：
//   - 旧键在、默认篇缺 → 迁移内容后删旧键（正常路径）
//   - 旧键在、默认篇在 → 内容已在先前迁移落位，两键并存以新键为准
//     （提案既定策略）——删旧键。降级窗口边界：用户先升级（迁移完成、旧键
//     已删）再降级旧二进制写旧键、再升级——此窗口旧键的新内容以新键为准
//     被舍弃（与策略一致，注记于此为诚实边界）
//   - 旧键缺 → 无事（重跑幂等的主要形态）
func (r *multiNotesRepo) MigrateLegacyProjectNotes() (int, error) {
	keys, _, err := r.doc.List(projNotesKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	migrated := 0
	for _, k := range keys {
		data, err := r.doc.Get(projNotesKind, k)
		if err != nil {
			continue // 并发消失/损坏隔离：跳过，下轮再对账
		}
		var old ProjectNote
		if json.Unmarshal(data, &old) != nil {
			continue // 损坏文档由 filestore 隔离机制承接
		}
		projectID := k // 旧键 key = 裸 projectID
		if projectID == GlobalNotesScope {
			// 哨兵冲突校验①（P-20261107-2a 定案）：旧单篇键撞全局库保留字——
			// 迁移会把它落成全局库默认篇（项目内容串进全局面），跳过并告警，
			// 旧键原样保留（数据无损，人工核对后处置）
			slog.Warn("projnotes legacy key collides with global notes sentinel, skipped", "key", k)
			continue
		}
		r.mu.Lock()
		_, err = r.get(projectID, DefaultNoteID)
		if err == ErrNotFound {
			n := MultiNote{
				ID:        DefaultNoteID,
				Title:     "",
				Content:   old.Content,
				CreatedAt: old.UpdatedAt,
				UpdatedAt: old.UpdatedAt,
			}
			b, merr := json.Marshal(n)
			if merr == nil {
				err = r.doc.Create(notesMultiKind, noteKey(projectID, DefaultNoteID), b)
			} else {
				err = merr
			}
			if err == nil {
				migrated++
			}
		} else if err == nil {
			err = nil // 默认篇已在：两键并存以新键为准
		}
		r.mu.Unlock()
		if err != nil {
			// 本项目迁移失败：保留旧键（数据无损——旧键仍是旧二进制的可读面），
			// 下轮启动重试；不阻断其余项目
			continue
		}
		_ = r.doc.Delete(projNotesKind, k) // 删除失败旧键残留：下轮幂等重删
	}
	return migrated, nil
}

// ── 单库化迁移（P-20261108-3）：非全局作用域篇 → 全局库 ──

// notesMigrationNS 单库化迁移目标 id 的派生命名空间（uuid v5/SHA1）：目标 id =
// f(源键, 内容)——同源同内容恒得同一 id，重跑与「删源失败」残留只删源不重复
// 入库；降级窗口内源被旧二进制改写过（内容变）则派生新 id 另存一篇——零丢弃
// 优先于去重
var notesMigrationNS = uuid.NewSHA1(uuid.NameSpaceOID, []byte("codecombo/notesmulti/global-migration"))

// migrationTargetID 源篇 → 全局库目标篇 id（确定性派生，见 notesMigrationNS）
func migrationTargetID(sourceKey, content string) string {
	return uuid.NewSHA1(notesMigrationNS, []byte(sourceKey+"\x00"+content)).String()
}

// isGlobalNoteKey 复合键是否全局库篇（前缀判定——复合键禁止按 '-' 反解拆分）
func isGlobalNoteKey(key string) bool {
	return strings.HasPrefix(key, GlobalNotesScope+"-")
}

// scopeLabel 源键 → 标题前缀名：labels（项目 id → 名）里取「id-」为键前缀的
// 最长匹配（项目 id 同为定长 uuid，至多一个命中；最长匹配只为非 uuid 测试
// 夹具防短 id 误中）。未命中 = 未登记作用域（项目已删除的孤儿篇）→ 空串，
// 保原标题——宁缺前缀不编造项目名
func scopeLabel(key string, labels map[string]string) string {
	best, bestLen := "", -1
	for id, name := range labels {
		if id == "" || len(id) <= bestLen || !strings.HasPrefix(key, id+"-") {
			continue
		}
		best, bestLen = name, len(id)
	}
	return strings.TrimSpace(best)
}

// truncateToBytes 按 UTF-8 字节上限截断（rune 边界不劈字）：取 ≤max 的最后
// 一个 rune 起始位作切点（range 产出的即 rune 边界，非法字节同样按单字节推进）
func truncateToBytes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max {
		return s
	}
	cut := 0
	for i := range s {
		if i > max {
			break
		}
		cut = i
	}
	return s[:cut]
}

// migratedTitle 并入全局库的标题：「[项目名] 原标题」（原标题空 = 「[项目名]」；
// 已带同前缀不重复叠加；label 空 = 未登记作用域保原标题）。守 NotesMaxTitleBytes
// 上限：先截原标题，项目名本身超长再截项目名（rune 边界）
func migratedTitle(label, title string) string {
	title = strings.TrimSpace(title)
	if label == "" {
		return truncateToBytes(title, NotesMaxTitleBytes)
	}
	prefix := "[" + label + "]"
	if strings.HasPrefix(title, prefix) {
		return truncateToBytes(title, NotesMaxTitleBytes)
	}
	if len(prefix) > NotesMaxTitleBytes {
		prefix = "[" + truncateToBytes(label, NotesMaxTitleBytes-2) + "]"
	}
	rest := truncateToBytes(title, NotesMaxTitleBytes-len(prefix)-1)
	if strings.TrimSpace(rest) == "" {
		return prefix
	}
	return prefix + " " + rest
}

// MigrateProjectNotesToGlobal 单库化迁移：全部非全局作用域篇（项目篇，含回收站
// 软删篇——保 DeletedAt 原值，30 天硬清时钟不重置）并入全局库。
//
// 满额即中止（评审修订：不迁回收站歧路——回收站篇 30 天硬清 = 无声丢失），
// 结果携 Full/Pending，留待腾出空间后下轮启动或手动续迁。取舍序：在册篇先于
// 回收站篇、同档最近更新优先（额度给最可能还在用的内容）。
//
// 幂等矩阵（目标 id 确定性派生，见 notesMigrationNS）：
//   - 目标缺 → 有额度新建并删源 / 无额度中止（源原样保留）
//   - 目标在 → 上轮已落、删源失败的残留：只删源（不重复入库、不占额度）
//   - 删源失败 → 源滞留计入 Pending，下轮命中确定性目标只删源
func (r *multiNotesRepo) MigrateProjectNotesToGlobal(labels map[string]string) (NotesMigrationResult, error) {
	var res NotesMigrationResult
	keys, _, err := r.doc.List(notesMultiKind, ListOpts{})
	if err != nil {
		return res, err
	}
	type source struct {
		key   string
		label string
		note  MultiNote
	}
	var sources []source
	for _, k := range keys {
		if isGlobalNoteKey(k) {
			continue
		}
		data, err := r.doc.Get(notesMultiKind, k)
		if err != nil {
			continue // 并发消失/损坏隔离（filestore 自愈改名）：已不在源集，不计滞留
		}
		var n MultiNote
		if json.Unmarshal(data, &n) != nil {
			// 合法 JSON 但非笔记形态：不臆造内容，原样保留并如实计入滞留
			slog.Warn("notes migration: unparseable note document kept in place", "key", k)
			res.Pending++
			continue
		}
		sources = append(sources, source{key: k, label: scopeLabel(k, labels), note: n})
	}
	if len(sources) == 0 {
		return res, nil
	}
	sort.SliceStable(sources, func(i, j int) bool {
		li, lj := sources[i].note.Live(), sources[j].note.Live()
		if li != lj {
			return li
		}
		return sources[i].note.UpdatedAt.After(sources[j].note.UpdatedAt)
	})

	// 全程持仓储锁：额度只数一次、逐篇本地递增——并发 REST 新建在锁外排队，
	// 不会与迁移双双越限（≤ 数百篇的小文件读写，持锁亚秒级）
	r.mu.Lock()
	defer r.mu.Unlock()
	count, err := r.countLiveLocked(GlobalNotesScope)
	if err != nil {
		return res, err
	}
	for i, s := range sources {
		target := MultiNote{
			ID:        migrationTargetID(s.key, s.note.Content),
			Title:     migratedTitle(s.label, s.note.Title),
			Content:   s.note.Content,
			CreatedAt: s.note.CreatedAt,
			UpdatedAt: s.note.UpdatedAt,
			DeletedAt: s.note.DeletedAt,
			DeletedBy: s.note.DeletedBy,
		}
		if target.UpdatedAt.IsZero() {
			target.UpdatedAt = time.Now()
		}
		if target.CreatedAt.IsZero() {
			target.CreatedAt = target.UpdatedAt
		}
		if _, gerr := r.get(GlobalNotesScope, target.ID); gerr != nil {
			if count >= NotesMaxGlobal {
				res.Full = true
				res.Pending += len(sources) - i
				break
			}
			data, merr := json.Marshal(target)
			if merr != nil {
				res.Pending++
				continue
			}
			cerr := r.doc.Create(notesMultiKind, noteKey(GlobalNotesScope, target.ID), data)
			if cerr != nil && !errors.Is(cerr, ErrAlreadyExists) {
				slog.Warn("notes migration: create global note failed, source kept", "key", s.key, "err", cerr)
				res.Pending++
				continue
			}
			if cerr == nil {
				count++
				res.Migrated++
			}
		}
		if derr := r.doc.Delete(notesMultiKind, s.key); derr != nil && !errors.Is(derr, ErrNotFound) {
			slog.Warn("notes migration: source cleanup failed, retry next round", "key", s.key, "err", derr)
			res.Pending++
		}
	}
	return res, nil
}

// PendingProjectNotes 仍滞留非全局作用域的篇数（只列键不读文档——面板续迁
// 提示的只读数据源，零写盘副作用）
func (r *multiNotesRepo) PendingProjectNotes() (int, error) {
	keys, _, err := r.doc.List(notesMultiKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	n := 0
	for _, k := range keys {
		if !isGlobalNoteKey(k) {
			n++
		}
	}
	return n, nil
}

// validateNoteTitle 标题长度校验（UTF-8 字节；允许空白/重复——显示层自由）
func validateNoteTitle(title string) error {
	if len(title) > NotesMaxTitleBytes {
		return ErrNotesTitleTooLong
	}
	return nil
}
