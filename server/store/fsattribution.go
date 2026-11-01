package store

import (
	"encoding/json"
	"sync"
	"time"
)

// 文件改动来源归因账（P-20261005-170）：watcher 命中事件 × OSC133 命令窗
// 的时间账——「这个文件刚才被哪条命令/哪个会话改的」的对账原语。判定在
// server/fsattr（事件发生当时），此处只做落盘留存与查询；关联语义（窗归属/
// 重叠歧义/编辑器标记）见该包注释。

// FSAttributionSource 归因来源三态（诚实账：未归因也是一等记录）
const (
	FSAttributionCommand      = "command"      // 落在某会话运行中命令的 [C,D] 窗内
	FSAttributionEditor       = "editor"       // 本产品文件 API 写（编辑器保存/替换/改名/删除链）
	FSAttributionUnattributed = "unattributed" // 无窗无标记（shellint 缺失/窗间隙/git API 写等）
)

// FSAttributionRef 单条归因：事件时刻命中的一个 (会话, 命令) 窗
type FSAttributionRef struct {
	TerminalID  string    `json:"terminalId"`
	SessionName string    `json:"sessionName"`
	Command     string    `json:"command,omitempty"` // 命令文本摘要（OSC133 E 帧；无帧为空）
	ExitCode    int       `json:"exitCode,omitempty"`
	Running     bool      `json:"running,omitempty"` // D 未至（命令仍在跑）——EndedAt 零值同义
	StartedAt   time.Time `json:"startedAt"`
	EndedAt     time.Time `json:"endedAt,omitempty"`
}

// FSAttributionEvent 账面单条：一次 watcher 命中事件及其归因结果
type FSAttributionEvent struct {
	At   time.Time `json:"at"`
	Path string    `json:"path"` // 项目相对 slash 路径（记录时归一；根自身事件不入账）
	// Op fsnotify 事件形态小写归一（create/write/remove/rename/chmod，
	// 复合 op 以 | 连接）。平台间语义有差异（Windows rename 报 rename，
	// 同场景 Linux 可能报 remove|rename），属信息性字段不承诺精确
	Op     string `json:"op,omitempty"`
	Source string `json:"source"`
	// Attributions Source=command 时非空；单窗单条、多会话/多窗并行同项目
	// 时全列（重叠歧义由 Overlap 标注，不武断裁决）
	Attributions []FSAttributionRef `json:"attributions,omitempty"`
	Overlap      bool               `json:"overlap,omitempty"`
}

// FSAttributionStore 文件改动归因账（按项目隔离，doc key=projectID）
type FSAttributionStore interface {
	// Append 追加一条（超出上限丢最旧；同路径 2s 内的紧邻重复事件就地
	// 合并——编辑器保存链/codegen 连写同一路径的爆发不放大账面与 IO）
	Append(projectID string, ev FSAttributionEvent) error
	// Query 该项目最近事件（新→旧）；path 非空时仅返回该路径（精确匹配
	// 归一形态），空 = 全部路径；limit 截断返回条数
	Query(projectID, path string, limit int) ([]FSAttributionEvent, error)
	// DeleteProject 项目删除级联清账（项目 ID 不复用，孤儿文档无人可达）
	DeleteProject(projectID string) error
}

const (
	// fsattributionKind 车道 1 kind
	fsattributionKind = "fsattribution"
	// FSAttributionMax 每项目保留条数上限（环形：超出丢最旧）。含未归因
	// 事件——诚实账的前提是无差别记账，只留「归上了的」会假装外部世界
	// 比实际安静
	FSAttributionMax = 500
	// fsAttributionMergeWindow 同路径紧邻事件的就地合并窗口：watcher 防抖
	// 500ms 已挡同路径连发，2s 窗再收一次「保存链/原子写的 tmp+rename 双
	// 事件」尾部；跨过窗口的同路径事件是两次独立改动，保留两条
	fsAttributionMergeWindow = 2 * time.Second
)

// fsAttributionRepo per-project 单文档环形（terminal_history 同款形状——
// 追加型高频小记录 × 有界环形；PERSISTENCE_LANES 已把该形状列为历史债务
// 「勿新增」，此处为任务书显式指定的例外：文件事件频率远高于命令，一事件
// 一文档会产生每秒数百次的文档 churn。单文档体积有界（500 × ~300B ≈ 150KB），
// 换 SQLite 时随 terminal_history 一并迁移）
type fsAttributionRepo struct {
	// filestore 锁是 kind 级，Get→append→Update 读改写必须 repo 内互斥，
	// 否则并发 Append 会互相覆盖丢条目（terminalHistoryRepo 同款）
	mu  sync.Mutex
	doc DocumentStore
}

func newFSAttributionRepo(doc DocumentStore) *fsAttributionRepo {
	return &fsAttributionRepo{doc: doc}
}

// load 读取项目账面，文档不存在或损坏时返回空切片
func (r *fsAttributionRepo) load(projectID string) []FSAttributionEvent {
	data, err := r.doc.Get(fsattributionKind, projectID)
	if err != nil {
		return nil
	}
	var events []FSAttributionEvent
	if json.Unmarshal(data, &events) != nil {
		return nil
	}
	return events
}

func (r *fsAttributionRepo) save(projectID string, events []FSAttributionEvent) error {
	if events == nil {
		events = []FSAttributionEvent{}
	}
	data, err := json.Marshal(events)
	if err != nil {
		return err
	}
	if has, _ := r.doc.Has(fsattributionKind, projectID); has {
		return r.doc.Update(fsattributionKind, projectID, data)
	}
	return r.doc.Create(fsattributionKind, projectID, data)
}

func (r *fsAttributionRepo) Append(projectID string, ev FSAttributionEvent) error {
	if projectID == "" {
		return ErrInvalidArg
	}
	if ev.At.IsZero() {
		ev.At = time.Now()
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	events := r.load(projectID)

	// 同路径紧邻事件就地合并：账面语义「该路径最近一次被这样改过」，
	// 连写爆发的中间态（保存链的写前快照、tmp 往返）没有对账价值
	if n := len(events); n > 0 {
		last := &events[n-1]
		if last.Path == ev.Path && ev.At.Sub(last.At) <= fsAttributionMergeWindow && ev.At.After(last.At) {
			*last = ev
			return r.save(projectID, events)
		}
	}

	events = append(events, ev)
	if len(events) > FSAttributionMax {
		events = events[len(events)-FSAttributionMax:]
	}
	return r.save(projectID, events)
}

func (r *fsAttributionRepo) Query(projectID, path string, limit int) ([]FSAttributionEvent, error) {
	if projectID == "" {
		return nil, ErrInvalidArg
	}
	if limit <= 0 {
		limit = FSAttributionMax
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	events := r.load(projectID)
	out := make([]FSAttributionEvent, 0, len(events))
	// 倒序遍历：最新在前
	for i := len(events) - 1; i >= 0 && len(out) < limit; i-- {
		if path == "" || events[i].Path == path {
			out = append(out, events[i])
		}
	}
	return out, nil
}

func (r *fsAttributionRepo) DeleteProject(projectID string) error {
	if projectID == "" {
		return ErrInvalidArg
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if has, _ := r.doc.Has(fsattributionKind, projectID); !has {
		return nil // 无账面时清空为幂等成功
	}
	return r.doc.Delete(fsattributionKind, projectID)
}
