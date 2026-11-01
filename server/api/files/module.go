package files

import (
	"context"
	"errors"
	"strings"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 文件管理领域模块：清单声明（/api/file、/api/upload 路由面）。
// 行为目前内聚在 files API handler 与 filepolicy 纯函数包中，无独立生命周期；
// 本模块是领域在内核注册表的存在锚点——后续文件域行为（策略扩展、索引等）
// 一律落在本模块生命周期内，不再新增散装启动调用
type Module struct {
	k kernel.Kernel
}

// NewModule 创建文件管理模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "files" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	publisher = k.Events()
	return nil
}

// TopicFileSelfWrite 工作台自身写入事件 topic（P-20261005-15）：files 域写入
// 链路落盘**前**发布（载荷 {path: 绝对路径，分隔符归一为 /}），watch 模块订阅
// 以标记自环窗口——同一 server 进程经 API 的写入同样会触发 fsnotify 事件，
// 敏感外部写入观测（watch 包）据此区分「真外部」与「工作台自己写的」。api 层
// 不 import watch 包，内核总线是两侧既有的解耦通道（project.added 同款先例；
// watch 侧订阅用字面量，与 busbridge 订阅 file.changed 同惯例）
const TopicFileSelfWrite = "file.selfwrite"

// publisher 领域事件发布面（Init 装配、Stop 卸载；未启动时 markSelfWrite
// 静默跳过——测试环境 watch 侧无订阅者，发布即 no-op）
var publisher *kernel.EventBus

// markSelfWrite 标记一个即将被工作台写入的绝对路径。发布先于写盘：总线同步
// 派发（kernel.Publish 语义），标记必然先于落盘完成，watcher goroutine 随后
// 处理 fsnotify 事件时标记必已就位，自环判定无竞态。载荷路径显式替换反斜杠
// 为 /（不走 filepath.ToSlash——Linux 恒等，归一语义与宿主解耦；消费侧
// watch.normalizeSlashes 同口径）
func markSelfWrite(absPath string) {
	if publisher == nil {
		return
	}
	publisher.Publish(kernel.Envelope{
		Topic:   TopicFileSelfWrite,
		Payload: map[string]string{"path": strings.ReplaceAll(absPath, `\`, `/`)},
	})
}

// Start 回收站与批量替换备份清账调度（P-20261003-304 + P-20261004-114，system
// 模块 auditlog-cleanup 同款 ticker 惯例）：启动即清一轮（跨次启动积压的过期
// 条目不必等 24h），之后每日兜底——trash 走 age/总量双上限，replace-backups
// 走 age/条数双上限，replacehist 车道 1 留档走 TTL（P-20261004-66，与备份
// 30 天同周期；每项目条数上限在 Append 时已环形裁剪，此处只管过期）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	PurgeExpiredTrash()
	PurgeExpiredReplaceBackups()
	purgeReplaceHist()
	if !k.Scheduler().AddTicker("trash-cleanup", 24*time.Hour, func(context.Context) {
		PurgeExpiredTrash()
		PurgeExpiredReplaceBackups()
		purgeReplaceHist()
	}) {
		return errors.New("files: trash-cleanup ticker already registered")
	}
	return nil
}

// purgeReplaceHist 替换历史 TTL 清账（store 未装配时静默跳过——测试环境）
func purgeReplaceHist() {
	if store.Get() == nil || store.Get().ReplaceHist == nil {
		return
	}
	store.Get().ReplaceHist.PurgeExpired(time.Now().Add(-store.ReplaceHistRetention))
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	publisher = nil
	return nil
}
