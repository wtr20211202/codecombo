package update

import (
	"context"
	"log/slog"
	"os"
	"strings"

	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// Module 应用更新模块（roadmap M1.2）：更新源装配 + 启动期清理进内核生命周期。
// 原 app 组合根的 system.SetupUpdateSource() 与三处清理调用迁入本模块
type Module struct {
}

// NewModule 创建更新模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "update" }
func (m *Module) DependsOn() []string { return nil }

// Init 装配更新源：读设置里的 UpdateURL（原 api/system.SetupUpdateSource 逻辑，
// setter 注入点随之消除）。源非法（非 https / 指向内网）时留痕并不启用——
// 更新通道是供应链入口，宁可不更新也不放宽
func (m *Module) Init(_ context.Context, _ kernel.Kernel) error {
	cfg := store.Get().Settings.Get()
	updateURL := strings.TrimSpace(cfg.Server.UpdateURL)
	if updateURL == "" {
		return nil
	}
	source, err := NewGitHubSource(updateURL)
	if err != nil {
		slog.Warn("update source rejected — update check disabled", "url", updateURL, "err", err)
		return nil
	}
	GetManager().SetSource(source)
	return nil
}

// Start 启动期清理：旧备份、过期更新结果、serve 临时缓存
func (m *Module) Start(_ context.Context, _ kernel.Kernel) error {
	exePath, _ := os.Executable()
	CleanupBackup(exePath)
	dd := config.DataDir()
	ClearOldUpdateResult(dd)
	CleanupServeCache(dd)
	slog.Debug("update: startup cleanup done")
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error { return nil }
