package sync

import (
	"encoding/json"
	"fmt"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	"codecombo/server/config"
	"codecombo/server/store"
)

// 设置块投影/回写（P-20261003-147 方案②③）：MigrationPortableSettings 是
// ServerConfig 的策展白名单——导出投影（portableSettingsFromConfig）与导入
// 回写（applyPortableToConfig）是同一字段集的两个方向，新增可迁字段两处同改
//（文件头注记即对账提示）。机器/网络拓扑绑定字段刻意不进白名单（见模型注记）。

// portableSettingsFromConfig ServerConfig → 白名单投影（导出侧）
func portableSettingsFromConfig(s config.ServerConfig) *MigrationPortableSettings {
	return &MigrationPortableSettings{
		AutoFetch:               s.AutoFetch,
		FetchInterval:           s.FetchInterval,
		TerminalBackend:         s.TerminalBackend,
		TerminalScrollbackLines: s.TerminalScrollbackLines,
		TerminalMaxSessions:     s.TerminalMaxSessions,
		TerminalTheme:           s.TerminalTheme,
		TerminalFont:            s.TerminalFont,
		UIDensity:               s.UIDensity,
		SessionContext:          s.SessionContext,
		TerminalHistoryEnabled:  s.TerminalHistoryEnabled,
		TerminalPastePrecheck:   s.TerminalPastePrecheckEnabled,
		TerminalRemoteTmux:      s.TerminalRemoteTmux,
		// P-20261109-7：终端行为偏好随包迁移（指针三态，nil=未配置跨机保持）
		TerminalTmuxMouseEnabled: s.TerminalTmuxMouseEnabled,
		TerminalIdleTimeoutMin:   s.TerminalIdleTimeoutMin,
		TerminalDefaultShell:     s.TerminalDefaultShell,
		AgentProvider:            s.AgentProvider,
		AgentNamingNoteEnabled:   s.AgentNamingNoteEnabled,
		AgentLaunchCommands:      s.AgentLaunchCommands,
		CustomAgents:             s.CustomAgents,
		AgentGuard:               s.AgentGuard,
		AgentApprovalMode:        s.AgentApprovalMode,
		AgentApprovalRules:       s.AgentApprovalRules,
		AgentApprovalTimeoutMin:  s.AgentApprovalTimeoutMin,
		ApprovalRecording:        s.ApprovalRecording,
		CustomSensitivePatterns:  s.CustomSensitivePatterns,
		UISnapshotEnabled:        s.UISnapshotEnabled,
		SensitiveExternalWatch:   s.SensitiveExternalWatch,
		AuditRetentionDays:       s.AuditRetentionDays,
		LogRetentionDays:         s.LogRetentionDays,
		GitNetworkTimeoutSec:     s.GitNetworkTimeoutSec,
		HookURLAllowHosts:        s.HookURLAllowHosts,
		DshWebBase:               s.DshWebBase,
		DshProxyPort:             s.DshProxyPort,
		DshExposeAll:             s.DshExposeAll,
		DshAllowStandalone:       s.DshAllowStandalone,
		DshLaunchCommand:         s.DshLaunchCommand,
		DshNpmCommand:            s.DshNpmCommand,
	}
}

// applyPortableToConfig 白名单投影 → ServerConfig（导入侧）。直接字段赋值，
// 沿设置 API 同信任域（管理面鉴权已由路由组承担）；指针字段原样携带
// （nil=未配置语义跨机保持）
func applyPortableToConfig(in *MigrationPortableSettings, s *config.ServerConfig) {
	if in == nil || s == nil {
		return
	}
	s.AutoFetch = in.AutoFetch
	s.FetchInterval = in.FetchInterval
	s.TerminalBackend = in.TerminalBackend
	s.TerminalScrollbackLines = in.TerminalScrollbackLines
	s.TerminalMaxSessions = in.TerminalMaxSessions
	s.TerminalTheme = in.TerminalTheme
	s.TerminalFont = in.TerminalFont
	s.UIDensity = in.UIDensity
	s.SessionContext = in.SessionContext
	s.TerminalHistoryEnabled = in.TerminalHistoryEnabled
	s.TerminalPastePrecheckEnabled = in.TerminalPastePrecheck
	s.TerminalRemoteTmux = in.TerminalRemoteTmux
	s.TerminalTmuxMouseEnabled = in.TerminalTmuxMouseEnabled
	s.TerminalIdleTimeoutMin = in.TerminalIdleTimeoutMin
	s.TerminalDefaultShell = in.TerminalDefaultShell
	s.AgentProvider = in.AgentProvider
	s.AgentNamingNoteEnabled = in.AgentNamingNoteEnabled
	s.AgentLaunchCommands = in.AgentLaunchCommands
	s.CustomAgents = in.CustomAgents
	s.AgentGuard = in.AgentGuard
	s.AgentApprovalMode = in.AgentApprovalMode
	s.AgentApprovalRules = in.AgentApprovalRules
	// allow-24h 的到期时刻不随包迁移（源机的放行窗口拷到新机是无依据的授权
	// 延展）；非 allow-24h 档位该字段本就不消费，清零由既有巡检链收敛
	s.AgentApprovalExpiresAt = time.Time{}
	s.AgentApprovalTimeoutMin = in.AgentApprovalTimeoutMin
	s.ApprovalRecording = in.ApprovalRecording
	s.CustomSensitivePatterns = in.CustomSensitivePatterns
	s.UISnapshotEnabled = in.UISnapshotEnabled
	s.SensitiveExternalWatch = in.SensitiveExternalWatch
	s.AuditRetentionDays = in.AuditRetentionDays
	s.LogRetentionDays = in.LogRetentionDays
	s.GitNetworkTimeoutSec = in.GitNetworkTimeoutSec
	s.HookURLAllowHosts = in.HookURLAllowHosts
	s.DshWebBase = in.DshWebBase
	s.DshProxyPort = in.DshProxyPort
	s.DshExposeAll = in.DshExposeAll
	s.DshAllowStandalone = in.DshAllowStandalone
	s.DshLaunchCommand = in.DshLaunchCommand
	s.DshNpmCommand = in.DshNpmCommand
}

// zeroTimeIfAllow 已并入 applyPortableToConfig（allow-24h 到期时刻不随包迁移）

// settingsFieldsMap 投影 → 字段键值 map（预览 diff 的数据面；值为 JSON 串
// 便于跨类型统一比较与展示）
func settingsFieldsMap(in *MigrationPortableSettings) map[string]string {
	b, _ := json.Marshal(in)
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		vb, _ := json.Marshal(v)
		out[k] = string(vb)
	}
	return out
}

// settingsDiff 逐字段 old→new（old=本机投影，new=包内投影；值相同不进 diff）
func settingsDiff(local, incoming *MigrationPortableSettings) []migrationFieldDiff {
	lm, im := settingsFieldsMap(local), settingsFieldsMap(incoming)
	var out []migrationFieldDiff
	// 字段序确定性：白名单结构的 JSON 键序即声明序——遍历 incoming 的序列化
	// 键序不可靠，改为按本地 map 键排序输出
	keys := make([]string, 0, len(im))
	for k := range im {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		if lm[k] == im[k] {
			continue
		}
		out = append(out, migrationFieldDiff{Field: k, Local: truncField(lm[k]), Incoming: truncField(im[k])})
	}
	return out
}

// truncField 预览值截断（diff 表单行展示；长数组类字段截断防预览载荷膨胀）
func truncField(s string) string {
	const max = 120
	if len(s) <= max {
		if s == "" {
			return ""
		}
		return s
	}
	return s[:max] + "…"
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// ── 导入侧应用（含锁配置与通知偏好）──

// applySettingsBlock 设置块整块应用（policy = package 才会走到这里）。
// 回写链：白名单字段 + 锁配置（保留本机 PasswordHash——包内不含哈希）+
// 通知偏好。返回 undo 闭包（整块回滚 = 快照恢复）
func applySettingsBlock(payload *MigrationPayload) (*migrationBlockReport, func(), error) {
	blk := payload.Settings
	if blk == nil {
		return &migrationBlockReport{}, func() {}, nil
	}
	// 整块快照（深拷贝经 JSON 往返——Config 是纯数据结构，往返无损）
	cfg := store.Get().Settings.Get()
	var snap config.Config
	if b, e := json.Marshal(cfg); e == nil {
		_ = json.Unmarshal(b, &snap)
	}
	oldPrefs := store.Get().Notification.GetPrefs()
	oldLock := store.Get().Lock.GetConfig()
	// allow-24h 到期时刻不在白名单投影内（apply 侧无条件清零），回滚须显式还原
	oldExpiry := cfg.Server.AgentApprovalExpiresAt

	// 落盘序：锁配置/通知偏好先行（各自独立文档），Server 白名单最后改内存+
	// 一次 Save——失败路径只发生在 in-memory 变更之前，无半态漂移窗口
	if blk.Lock != nil {
		lc := oldLock
		lc.Enabled = blk.Lock.Enabled
		lc.AutoLockEnabled = blk.Lock.AutoLockEnabled
		lc.AutoLockMinutes = blk.Lock.AutoLockMinutes
		lc.TokenTTLMinutes = blk.Lock.TokenTTLMinutes
		if err := store.Get().Lock.SaveConfig(lc); err != nil {
			return &migrationBlockReport{}, func() {}, fmt.Errorf("lock config save failed: %w", err)
		}
	}
	if blk.NotifyPrefs != nil {
		if err := store.Get().Notification.SavePrefs(*blk.NotifyPrefs); err != nil {
			_ = store.Get().Lock.SaveConfig(oldLock)
			return &migrationBlockReport{}, func() {}, fmt.Errorf("notify prefs save failed: %w", err)
		}
	}
	if blk.Server != nil {
		applyPortableToConfig(blk.Server, &cfg.Server)
		if err := store.Get().Settings.Save(); err != nil {
			// 落盘失败：就地还原 in-memory 白名单字段（锁配置/偏好已在上方
			// 各自回滚），不留漂移态
			applyPortableToConfig(portableSettingsFromConfig(snap.Server), &cfg.Server)
			cfg.Server.AgentApprovalExpiresAt = oldExpiry
			_ = store.Get().Notification.SavePrefs(oldPrefs)
			_ = store.Get().Lock.SaveConfig(oldLock)
			return &migrationBlockReport{}, func() {}, fmt.Errorf("settings save failed: %w", err)
		}
		// 自定义运行时注册表进程内同步（saveAndSyncSettings 同链——迁移导入
		// 后选型/Runtimes 清单即刻生效）
		agentops.SyncCustomAgents(cfg.Server.CustomAgents)
	}
	return &migrationBlockReport{Imported: 1}, func() {
		restored := snap
		if blk.Server != nil {
			live := store.Get().Settings.Get()
			applyPortableToConfig(portableSettingsFromConfig(restored.Server), &live.Server)
			live.Server.AgentApprovalExpiresAt = oldExpiry
			_ = store.Get().Settings.Save()
			agentops.SyncCustomAgents(live.Server.CustomAgents)
		}
		_ = store.Get().Notification.SavePrefs(oldPrefs)
		_ = store.Get().Lock.SaveConfig(oldLock)
	}, nil
}

// notifySettingsChanged 设置变更广播（导入落地后前端各分区重拉——与
// system.UpdateSettings 既有广播同一事件词表；广播失败不影响导入结果，
// 前端刷新页面兜底）
func notifySettingsChanged() {
	opschannel.BroadcastEvent(opschannel.EventSettingsChanged, nil)
}
