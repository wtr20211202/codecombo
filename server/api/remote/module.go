package remote

import (
	"context"
	"time"

	"codecombo/server/kernel"
)

// Module 远程主机领域模块：清单声明（remotehosts/远程终端/实例代理路由面）
// + 主机在线状态探测生命周期。原 app 组合根的 StartRemoteHostStatusProber
// 启动调用迁入内核生命周期。
// 设计约束（安全评审）：只做 TCP connect 端口级探测，不做周期 SSH 登录——
// auth-fail 主机反复失败握手会触发远端 fail2ban；认证有效性由
// 「测试连接」/开终端时验证
type Module struct {
	k    kernel.Kernel
	stop chan struct{}
	done chan struct{}
	// tunnelDone 隧道空闲回收循环退出信号（与探测循环共用 stop，独立收尸）
	tunnelDone chan struct{}
}

// NewModule 创建远程主机模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "remote" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	return nil
}

// Start 启动探测循环：启动即首探（徽章尽快可用），30s 周期 + 手动测试连接
// 后的非阻塞唤醒（NotifyStatusProbe）。重复 Start 无副作用（原子守卫保留）。
// 同窗口起两条回收循环（P-20261004-5 隧道 / P-20261005-159 连接池）：30s 一扫，
// 各自静默超 TTL 即关
func (m *Module) Start(_ context.Context, _ kernel.Kernel) error {
	if !statusStarted.CompareAndSwap(false, true) {
		return nil
	}
	m.stop = make(chan struct{})
	m.done = make(chan struct{})
	go func() {
		defer close(m.done)
		statusProbeLoop(m.stop)
	}()
	m.tunnelDone = make(chan struct{})
	go func() {
		defer close(m.tunnelDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-m.stop:
				return
			case <-ticker.C:
				tunnels.ReapIdle()
				conns.ReapIdle()
			}
		}
	}()
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	if m.stop != nil {
		close(m.stop)
		<-m.done
		if m.tunnelDone != nil {
			<-m.tunnelDone
			m.tunnelDone = nil
		}
		m.stop = nil
		m.done = nil
	}
	statusStarted.Store(false)
	// 停机清空全部隧道与池内连接（本地监听口与 SSH 连接不留悬挂资源）
	tunnels.CloseAll()
	conns.CloseAll()
	return nil
}
