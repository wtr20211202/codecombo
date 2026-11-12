package terminal

import (
	"context"

	"codecombo/server/api/opschannel"
	"codecombo/server/kernel"
)

// Module 终端 API 生命周期模块：承载粘贴图片清理（roadmap M2.1，原 app 组合根
// 的 StartPasteImageCleaner 裸 goroutine 迁入内核生命周期——首清一次 + 周期清理
// 托管到内核调度器）+ 排队指令触发引擎装配与完成回执观察者注册（P-20261003-248）
// + agent 会话自动命名观察器（P-20261111-6 S1，周期检测转写首条用户消息）
// ——都是终端 API 域的启动期装配，共用一个内核模块
type Module struct {
	k kernel.Kernel
	// unsubscribeQueueObserver 回执观察者退订句柄（Init 注册，Stop 退订——
	// 观察者是包级单点，模块重启（单测装配多实例）不得重复挂观察者）
	unsubscribeQueueObserver func()
}

// NewModule 创建模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "paste-cleaner" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	// 排队指令触发引擎 + 完成回执观察者（P-20261003-248）：观察者追加式注册
	//（ai 模块落库观察者同流多消费，覆盖式 SetObserver 会清掉先注册的）；
	// 引擎在 Stop 摘除——停机闸后回执不再驱动发送
	setDefaultQueueEngine(newQueueEngine())
	m.unsubscribeQueueObserver = opschannel.AddObserver(QueueReceiptObserver())
	return nil
}

// Start 先同步清一次（上次运行遗留），再注册周期清理 ticker；agent 会话自动
// 命名观察器（P-20261111-6 S1）同为终端 API 域启动期装配——周期检测 claude
// 会话首个用户消息落盘并按其总结会话名（语义与边界见 agent_autoname.go）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	m.k = k
	CleanupStalePasteImages(pasteImageMaxAge)
	k.Scheduler().AddTicker("paste-image-clean", pasteImageCleanInterval, func(context.Context) {
		CleanupStalePasteImages(pasteImageMaxAge)
	})
	k.Scheduler().AddTicker("agent-auto-name", autoNameTickInterval, func(context.Context) {
		autoNameTick()
	})
	return nil
}

// Stop 摘除引擎装配与回执观察者（在途回执不再驱动发送；重启后由下一次 Init 重建）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	setDefaultQueueEngine(nil)
	if m.unsubscribeQueueObserver != nil {
		m.unsubscribeQueueObserver()
		m.unsubscribeQueueObserver = nil
	}
	return nil
}
