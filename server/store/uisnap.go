package store

import (
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// ErrNoLiveSnapshot 无在报的用户现场快照：从未上报（浏览器未开项目页）/ TTL
// 过期（10 分钟无心跳）/ 设置开关关闭（读取端拦截）。三类在读取端同语义收敛
// ——「查无」不区分原因，陈旧现场宁缺勿错
var ErrNoLiveSnapshot = errors.New("no live ui snapshot")

// UIActiveFile 用户正在看的文件位置（仅位置不内容——隐私边界见手册「用户现场」节）
type UIActiveFile struct {
	// Path 项目相对路径（正斜杠归一由上报方负责；服务端不解析文件系统）
	Path string `json:"path"`
	// Line 1-based 行号（0/缺省 = 无行级定位，如欢迎页/预览签）
	Line int `json:"line"`
	// Column 可选 1-based 列号（0 = 未上报）
	Column int `json:"column,omitempty"`
}

// UIVisiblePanels 面板可见性投影（side/bottom 两族；主区视图互斥态不在此列）
type UIVisiblePanels struct {
	// Side 侧栏当前视图标识（files/changes/todos/stream/env/sync…，前端面板注册表 id；
	// 笔记 P-20261108-2 起为主区独立视图，不再出现在此）
	Side string `json:"side"`
	// SideOpen 侧栏是否展开
	SideOpen bool `json:"sideOpen"`
	// Bottom 底栏当前 tab 标识（git/terminal/preview/problems…）
	Bottom string `json:"bottom"`
	// BottomOpen 底栏是否展开
	BottomOpen bool `json:"bottomOpen"`
}

// UISnapshot 用户 UI 现场（P-20261004-52）：前端聚合上报的「用户此刻在看什么」
// ——agent 与用户共处同一工作台却对用户现场零感知，问询靠用户自述位置；本结构
// 是 agent 的「看着问」地基件（ask 提问与汇报引用现场提升精准度）。
//
// 隐私边界（手册「用户现场」节同文）：仅位置不内容——只含「哪个项目/哪个文件
// 第几行/哪些面板开着/哪个终端会话在前」，绝不含文件内容、终端输出、剪贴板；
// agent 不得据此推断用户行为。快照仅最近一条不存历史（单文档 last-write-wins）。
//
// 车道 1（可查询实体）：instance 级单文档 kind=uisnap，键=default——
// 保留策略即形态本身（单文档有界，新快照整体覆写旧快照，重启保留最近一条，
// TTL 由读取端按 UpdatedAt 判定，无后台清理义务）。
type UISnapshot struct {
	// ActiveProjectID 当前激活项目 id（首页无项目上下文时为空）
	ActiveProjectID string `json:"activeProjectId,omitempty"`
	// ActiveFile 当前激活文件位置（无激活文件为 nil）
	ActiveFile *UIActiveFile `json:"activeFile,omitempty"`
	// VisiblePanels 面板可见性投影
	VisiblePanels UIVisiblePanels `json:"visiblePanels"`
	// ActiveTerminalSessionID 用户最近激活的终端会话（跨底部终端/agent 管理页
	// 两宿主，最后激活者胜；多标签页竞争 MVP 同为最后写入优先）
	ActiveTerminalSessionID string `json:"activeTerminalSessionId,omitempty"`
	// UpdatedAt 最近上报时刻（心跳续期锚点；TTL 判定唯一依据，服务端时钟）
	UpdatedAt time.Time `json:"updatedAt"`
}

// UISnapStore 用户 UI 现场存储（doc store kind=uisnap，instance 级单文档）
type UISnapStore interface {
	// Put 整体覆写最近快照并盖 UpdatedAt 服务端时间戳（多标签页 last-write-wins）
	Put(snap UISnapshot) error
	// GetAlive 取在报快照：缺失或 now 距 UpdatedAt 超过 UISnapshotTTL 返回
	// ErrNoLiveSnapshot（now 注入供单测时间旅行；开关关闭的拦截在读取端，不落存储）
	GetAlive(now time.Time) (*UISnapshot, error)
}

const (
	uisnapKind = "uisnap"
	uisnapKey  = "default"
	// UISnapshotTTL 现场时效：10 分钟无心跳即查无。心跳 60s 一拍，10 分钟 =
	// 连续 10 拍缺席（浏览器关闭/休眠/切首页均断拍）——容忍瞬时网络抖动，
	// 不容忍「陈旧现场当现场」
	UISnapshotTTL = 10 * time.Minute
)

type uiSnapRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

func newUISnapRepo(doc DocumentStore) *uiSnapRepo {
	return &uiSnapRepo{doc: doc}
}

func (r *uiSnapRepo) Put(snap UISnapshot) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	snap.UpdatedAt = time.Now()
	raw, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	return r.doc.Upsert(uisnapKind, uisnapKey, raw)
}

func (r *uiSnapRepo) GetAlive(now time.Time) (*UISnapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	raw, err := r.doc.Get(uisnapKind, uisnapKey)
	if err != nil {
		return nil, ErrNoLiveSnapshot
	}
	var snap UISnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil, ErrNoLiveSnapshot
	}
	if snap.UpdatedAt.IsZero() || now.Sub(snap.UpdatedAt) > UISnapshotTTL {
		return nil, ErrNoLiveSnapshot
	}
	return &snap, nil
}
