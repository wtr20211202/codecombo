package update

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// Module 应用更新模块（roadmap M1.2）：更新源装配 + 启动期清理 + 定时检查
// 进内核生命周期。原 app 组合根的 system.SetupUpdateSource() 与三处清理调用
// 迁入本模块
type Module struct {
	k            kernel.Kernel
	lastNotified string // 已推送过「新版本可用」通知的版本（进程内去重）

	// currentVerGen 当前版本取值口：默认读包级 currentVersion（main 注入），
	// 可整体替换（测试注入）
	currentVerGen func() string
}

// currentVersion 当前运行版本（SetCurrentVersion 由 main 注入，与
// api/system.buildVersion 同源同刻——update 包不反向依赖 api 包）
var currentVersion = "dev"

// SetCurrentVersion 注入当前运行版本（main 启动期调用，供自动检查对比用）
func SetCurrentVersion(v string) { currentVersion = v }

// NewModule 创建更新模块（version 由组合根声明式传入，与 system.NewModule
// 的 rt.Version 同源——自动检查用它对比 ReleaseInfo；"dev"/空 = 无对比语义）
func NewModule(version string) *Module {
	v := strings.TrimSpace(version)
	return &Module{
		currentVerGen: func() string { return v },
	}
}

func (m *Module) Name() string        { return "update" }
func (m *Module) DependsOn() []string { return nil }

// autoCheckInterval 自动检查周期。检查结果走 manager 的 1h 缓存；通知按版本
// 进程内去重——重启后同版本至多再推一次
const autoCheckInterval = 24 * time.Hour

// Init 装配更新源：设置 UpdateURL 为空时回填官方仓库（P-20261103-1 零配置
// 自更新）——「不更新」的语义由 UpdateChecks 开关承接（此处只管源，定时器看
// 开关）。源非法（非 https / 指向内网）时留痕并不启用——更新通道是供应链
// 入口，宁可不更新也不放宽
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	cfg := store.Get().Settings.Get()
	updateURL := strings.TrimSpace(cfg.Server.UpdateURL)
	if updateURL == "" {
		updateURL = config.UpdateURLOfficial
	}
	source, err := NewGitHubSource(updateURL)
	if err != nil {
		slog.Warn("update source rejected — update check disabled", "url", updateURL, "err", err)
		return nil
	}
	// 预发布通道（P-20261103-3）：设置 updateChannel=prerelease 时跟进 beta/rc
	//（默认 stable 只认最新正式版）。通道属检查口径，自更新应用链与校验链零特例
	if strings.EqualFold(strings.TrimSpace(cfg.Server.UpdateChannel), "prerelease") {
		source.IncludePrerelease = true
		slog.Info("update: prerelease channel enabled — beta/rc releases visible to checks")
	}
	GetManager().SetSource(source)
	return nil
}

// Start 启动期清理：旧备份、过期更新结果、serve 临时缓存；并挂定时检查
// （UpdateChecks 开关关闭 = 自动检查完全静默，手动检查不受影响）
func (m *Module) Start(ctx context.Context, k kernel.Kernel) error {
	exePath, _ := os.Executable()
	CleanupBackup(exePath)
	dd := config.DataDir()
	ClearOldUpdateResult(dd)
	CleanupServeCache(dd)
	slog.Debug("update: startup cleanup done")

	if !store.Get().Settings.Get().Server.UpdateChecks {
		slog.Info("update: auto check disabled by settings")
		return nil
	}
	if !k.Scheduler().AddTicker("update-check", autoCheckInterval, m.autoCheck) {
		return errors.New("update: update-check ticker already registered")
	}
	// 首检前置：启动后 2 分钟做一次（ticker 首跳要等满 24h）——错峰避开启动
	// 风暴，也让新装实例在当次会话内即可看到「新版本可用」
	go func() {
		select {
		case <-time.After(2 * time.Minute):
		case <-ctx.Done():
			return
		}
		m.autoCheck(ctx)
	}()
	return nil
}

// autoCheck 单次定时检查：失败静默（更新通道不应打扰），有新版且未推送过才发
// 系统通知（category=system，action=url 跳 Releases 页）
func (m *Module) autoCheck(ctx context.Context) {
	if m.k == nil {
		return
	}
	cur := strings.TrimSpace(m.currentVerGen())
	if cur == "" || cur == "dev" {
		return // 开发构建无对比语义
	}
	info, err := GetManager().CheckUpdateWithCache(ctx, cur, false)
	if err != nil || info == nil || !HasUpdate(cur, info.Version) {
		return
	}
	if info.Version == m.lastNotified {
		return
	}
	m.lastNotified = info.Version
	m.k.Events().Publish(kernel.Envelope{
		Topic: notification.TopicNew,
		Payload: notification.Notification{
			Type:          "info",
			Category:      notification.CategorySystem,
			Title:         "新版本可用：Codecombo v" + info.Version,
			Body:          "当前 v" + cur + "，可在首页版本面板检查并升级",
			Time:          time.Now(),
			Action:        "url",
			ActionPayload: config.UpdateURLOfficial + "/releases",
		},
	})
	slog.Info("update: new version available", "current", cur, "latest", info.Version)
}

// Stop 停机（调度器任务由内核统一停）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error { return nil }
