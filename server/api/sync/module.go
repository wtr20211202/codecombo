package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 多实例项目同步模块（P-20261023-1）：/api/sync/* 端点族的服务端承载
// + 定时同步分钟巡检 + 进度广播装配。传输/落位/账本实现在包内各文件；本模块
// 只负责内核生命周期接线。

// minuteTick 巡检周期（agentcron 同范式）
const minuteTick = time.Minute

// Module 内核模块
type Module struct {
	k kernel.Kernel
	// stopped 停机闸：内核 StopAll 先停模块后停调度器，两者之间 ticker 仍可能
	// 触发 tick——闸住这段窗口（Stop 后不再发起任何同步），与 agentcron 同纪律
	stopped chan struct{}
	// unsubRemoved 项目删除级联订阅（Init 挂、Stop 摘）
	unsubRemoved func()
	// tlsOn / certFile 本机 TLS 运行态与证书路径（组合根解析结果经构造注入，
	// share 模块同款）——携密核对仪式的 certinfo 端点数据源（P-20261024-3）
	tlsOn    bool
	certFile string
}

// Name / DependsOn 内核契约
func (m *Module) Name() string        { return "sync" }
func (m *Module) DependsOn() []string { return nil }

// NewModule 创建模块（cfg/TLS 运行态由组合根注入——本机证书指纹的只读数据源）
func NewModule(cfg *config.Config, tlsOn bool, certFile string) *Module {
	setLocalTLS(tlsOn, certFile)
	return &Module{stopped: make(chan struct{}), tlsOn: tlsOn, certFile: certFile}
}

// 本机 TLS 运行态的包级装配（setBroadcaster 同款组合根注入模式：启动期一次
// 写、此后只读——certinfo 端点从包级 handler 读，免 router 层持模块引用）
var localTLS struct {
	tlsOn    bool
	certFile string
}

func setLocalTLS(tlsOn bool, certFile string) {
	localTLS.tlsOn = tlsOn
	localTLS.certFile = certFile
}

// Init 校验持久化层可达 + 订阅项目删除级联（同步账本防陈旧基线误判——项目
// 删除后其单元键的账目无主，保留会让「对端仍在」的单元被误判 synced；
// 载荷带 path（删除时刻值），基名即单元键成分，账本清理无歧义）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	if store.Get() == nil {
		return fmt.Errorf("sync: store not assembled")
	}
	m.unsubRemoved = k.Events().Subscribe("project.removed", func(env kernel.Envelope) {
		var p struct{ Path string }
		if !decodePayload(env.Payload, &p) || p.Path == "" {
			return
		}
		base := rootBasename(p.Path)
		if base == "" {
			return
		}
		for _, kind := range append([]string{UnitProject}, ContextKinds()...) {
			_ = store.Get().SyncLedger.DeleteByUnit(UnitKey(kind, base))
		}
	})
	return nil
}

// Start 装配进度广播口 + 注册分钟巡检（到点定时同步任务评估）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	m.k = k
	setBroadcaster(broadcastProgress)
	if !k.Scheduler().AddTicker("sync-cron-scheduler", minuteTick, func(ctx context.Context) {
		select {
		case <-m.stopped:
			return
		default:
		}
		runDueCrons(time.Now())
	}) {
		return errors.New("sync: scheduler ticker already registered")
	}
	return nil
}

// Stop 落下停机闸、摘除级联订阅与广播装配（Stop 后巡检不再发起；在途传输
// 由各自 ctx 生命周期收口）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	select {
	case <-m.stopped:
		// 已关闭
	default:
		close(m.stopped)
	}
	if m.unsubRemoved != nil {
		m.unsubRemoved()
		m.unsubRemoved = nil
	}
	setBroadcaster(nil)
	return nil
}

// decodePayload 宽松解码 map/struct 形态的事件载荷（fsattr 同款防御——本包
// 只消费总线信封，拷贝 ~10 行防御代码不为此拉出公共依赖）
func decodePayload(payload any, dst any) bool {
	switch v := payload.(type) {
	case string:
		return json.Unmarshal([]byte(v), dst) == nil
	default:
		b, err := json.Marshal(payload)
		return err == nil && json.Unmarshal(b, dst) == nil
	}
}
