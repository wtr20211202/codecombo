package remoteaccess

import (
	"context"
	"fmt"
	"log/slog"

	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 远程接入模块：反向隧道管理器的进程生命周期（停机级联关闭）+ 启动
// 自动恢复（settings.remoteAccess.enabled=true 且安全门槛仍满足时）。
// 档案 CRUD 在 settings，REST 控制在 tunnel.go。
type Module struct{}

// NewModule 创建远程接入模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "remoteaccess" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, _ kernel.Kernel) error { return nil }

// Start 启动即尝试恢复上次启用的隧道（异步，不阻塞内核启动序列）。
// 安全门槛复核（锁定/TLS 显式确认）不满足时不自动暴露：关闭 enabled 位
// 并留审计——「TLS 未启用强警示 + 显式确认」是每次暴露的裁决，不可靠
// 上一次的确认静默延续到重启后。
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	go m.autoStart(k)
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	manager.CloseAll()
	return nil
}

func (m *Module) autoStart(k kernel.Kernel) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("remoteaccess: auto-start panic", "panic", r)
		}
	}()
	st := store.Get()
	if st == nil {
		return
	}
	cfg := st.Settings.Get()
	ra := cfg.Server.RemoteAccess
	if ra == nil || !ra.Enabled || ra.ActiveID == "" {
		return
	}
	p := ra.ActiveProfile()
	if p == nil {
		ra.Enabled = false
		_ = st.Settings.Save()
		auditBackground(store.AuditRemoteAccessFail, store.AuditResultFailure, "",
			"auto-start skipped: active relay profile is missing")
		return
	}
	if ready, reason, _ := lockGate(); !ready {
		ra.Enabled = false
		_ = st.Settings.Save()
		auditBackground(store.AuditRemoteAccessFail, store.AuditResultFailure, "",
			fmt.Sprintf("auto-start skipped (lock gate): %s", reason))
		k.Logger().Warn("remoteaccess auto-start skipped: lock gate", "reason", reason)
		return
	}
	if !config.TLSEnabled() {
		ra.Enabled = false
		_ = st.Settings.Save()
		auditBackground(store.AuditRemoteAccessFail, store.AuditResultFailure, "",
			"auto-start skipped: TLS disabled, explicit confirmation required per exposure")
		k.Logger().Warn("remoteaccess auto-start skipped: TLS disabled")
		return
	}
	spec, err := buildSpec(cfg, p, "")
	if err != nil {
		auditBackground(store.AuditRemoteAccessFail, store.AuditResultFailure, "",
			fmt.Sprintf("auto-start config invalid: %s", truncateErr(err)))
		k.Logger().Warn("remoteaccess auto-start config invalid", "err", err)
		return
	}
	if _, err := manager.Start(spec); err != nil {
		auditBackground(store.AuditRemoteAccessFail, store.AuditResultFailure, "",
			fmt.Sprintf("auto-start failed: %s", truncateErr(err)))
		k.Logger().Warn("remoteaccess auto-start failed", "err", err)
	}
}
