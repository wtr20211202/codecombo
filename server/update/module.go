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

	// currentVerGen 当前版本取值口：组合根 NewModule(rt.Version) 声明式注入
	//（与 system.NewModule 的 rt.Version 同源；update 包不反向依赖 api 包），
	// 可整体替换（测试注入）
	currentVerGen func() string

	// dataDirGen 数据目录取值口（默认 config.DataDir）：启动清理与结果观察窗
	// 共用，测试注入临时目录——模块契约测试不得读写真实数据目录
	dataDirGen func() string

	// stopWatch 结果观察窗的取消口（Start 装配，Stop 调用）：停机后不得再有
	// 通知入账（内核契约「Stop 后无副作用」）
	stopWatch context.CancelFunc
}

// NewModule 创建更新模块（version 由组合根声明式传入，与 system.NewModule
// 的 rt.Version 同源——自动检查用它对比 ReleaseInfo；"dev"/空 = 无对比语义）
func NewModule(version string) *Module {
	v := strings.TrimSpace(version)
	return &Module{
		currentVerGen: func() string { return v },
		dataDirGen:    config.DataDir,
	}
}

func (m *Module) Name() string        { return "update" }
func (m *Module) DependsOn() []string { return nil }

// autoCheckInterval 自动检查周期。检查结果走 manager 的 1h 缓存；通知按版本
// 进程内去重——重启后同版本至多再推一次
const autoCheckInterval = 24 * time.Hour

// Init 装配更新源（与设置保存热化共用 ApplySource 同一语义，防双处漂移）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	ApplySource(store.Get().Settings.Get())
	return nil
}

// ApplySource 装配（或重接线）更新检查源——启动 Init 与设置保存（P-20261106
// 热化：开关保存即生效，无须重启）共用同一入口：URL 空=官方仓内置
// （P-20261103-1 零配置自更新，「不更新」语义由 UpdateChecks 开关承接）；
// 源非法（非 https / 指向内网）时留痕并停用——更新通道是供应链入口，
// 宁可不更新也不放宽；通道（stable/prerelease）随设置即时生效。
// 出站代理（P-20261109-12）同点装配：显式设置项 > 环境变量 > 直连；代理串
// 非法时留痕回直连（env 感知仍在）——宁降级不阻断，保存期校验挡住常规入口
func ApplySource(cfg *config.Config) {
	updateURL := strings.TrimSpace(cfg.Server.UpdateURL)
	if updateURL == "" {
		updateURL = config.UpdateURLOfficial
	}
	sourceHost := hostOfSourceURL(updateURL)
	if proxy := strings.TrimSpace(cfg.Server.UpdateProxy); proxy != "" {
		if err := SetOutbound(proxy, sourceHost); err != nil {
			slog.Warn("update: outbound proxy rejected — falling back to direct/env", "err", err)
			_ = SetOutbound("", sourceHost)
		}
	} else {
		_ = SetOutbound("", sourceHost)
	}
	source, err := NewGitHubSource(updateURL)
	if err != nil {
		slog.Warn("update source rejected — update check disabled", "url", updateURL, "err", err)
		GetManager().SetSource(nil)
		return
	}
	// 预发布通道（P-20261103-3）：设置 updateChannel=prerelease 时跟进 beta/rc
	//（默认 stable 只认最新正式版）。通道属检查口径，自更新应用链与校验链零特例
	if strings.EqualFold(strings.TrimSpace(cfg.Server.UpdateChannel), "prerelease") {
		source.IncludePrerelease = true
		slog.Info("update: prerelease channel enabled — beta/rc releases visible to checks")
	}
	GetManager().SetSource(source)
}

// Start 启动期清理：旧备份、过期更新结果、serve 临时缓存；挂结果观察窗
// （P-20261109-10：换包/回滚后的完成通知由本进程推送）与定时检查
// （定时器无条件注册，UpdateChecks 开关由 autoCheck 每次 tick 实读——
// P-20261106 热化：开关保存即生效，不必重启）
func (m *Module) Start(ctx context.Context, k kernel.Kernel) error {
	exePath, _ := os.Executable()
	CleanupBackup(exePath)
	dd := m.dataDirGen()
	ClearOldUpdateResult(dd)
	CleanupServeCache(dd)
	slog.Debug("update: startup cleanup done")

	wctx, cancel := context.WithCancel(ctx)
	m.stopWatch = cancel
	go m.watchUpdateResult(wctx, dd)

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
	// 开关实读（P-20261106 热化）：设置关闭即静默，保存即时生效
	if !store.Get().Settings.Get().Server.UpdateChecks {
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

// watchUpdateResult 结果观察窗（时序与窗口取值见 notify.go publishUpdateResult
// 段注）：每 resultWatchInterval 读一次结果文件，可判定即收工，窗口到期或
// 停机即退出
func (m *Module) watchUpdateResult(ctx context.Context, dd string) {
	deadline := time.Now().Add(resultWatchWindow)
	for {
		if publishUpdateResult(dd, strings.TrimSpace(m.currentVerGen()), time.Now()) {
			return
		}
		if !time.Now().Before(deadline) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(resultWatchInterval):
		}
	}
}

// Stop 停机（调度器任务由内核统一停；结果观察窗经 stopWatch 收口，幂等）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	if m.stopWatch != nil {
		m.stopWatch()
	}
	return nil
}
