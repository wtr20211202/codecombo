package update

import (
	"log/slog"
	"sync/atomic"
	"time"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// 自更新生命周期通知（P-20261109-10）：服务端单一发射者——开始/失败由受理
// 进程（StartUpdate）入账，完成/回滚/子进程失败由换包后的新进程（或回滚拉
// 起的旧进程）启动观察窗读结果文件入账。此前四类通知全由前端组件局部轮询
// 回调发射：面板一关/页面一刷/主进程一退即失声，且多标签/多设备各发一份。
//
// 文案走 titleKey/bodyKey 模板（前端按界面语言渲染）；Title 中文原文是无模板
// 消费方（webhook 外发、API 直读）的回退（与 agentcron/configCorrupt 同惯例）。
// Body 只承载语言中立明细（失败原因原文），渲染于翻译摘要行之后——不写摘要
// 回退文本，否则通知中心会摘要+原文重复两遍
const (
	notifyStartedTitleKey       = "update.notify.startedTitle"
	notifyStartedBodyKey        = "update.notify.startedBody"
	notifyFailedTitleKey        = "update.notify.failedTitle"
	notifyFailedTitleBareKey    = "update.notify.failedTitleBare"
	notifyFailedBodyKey         = "update.notify.failedBody"
	notifySuccessTitleKey       = "update.notify.successTitle"
	notifySuccessTitleBareKey   = "update.notify.successTitleBare"
	notifySuccessBodyKey        = "update.notify.successBody"
	notifyRolledBackTitleKey    = "update.notify.rolledBackTitle"
	notifyRolledBackBodyKey     = "update.notify.rolledBackBody"
	notifyRolledBackBodyBareKey = "update.notify.rolledBackBodyBare"

	// ActionUpdatePanel 通知动作：点击回到版本面板（设置 → 关于，前端
	// notification store handleClick 就地分流，不经项目页路由桥）
	ActionUpdatePanel = "update-panel"
)

// publishNotification 通知入账口：经 store 落库后由出站口广播（WS + webhook）。
// 刻意不直发事件总线（autoCheck「发现新版本」那条只广播不落库）——完成通知
// 产生于新进程启动观察窗，此刻浏览器 WS 尚未重连，只广播的通知无人接收即丢；
// 落库后前端重连补拉（runReconnectRefetches → GET /notifications）必达。
// store 未装配（单测/裸装配）静默跳过。包级变量供测试替换捕获
var publishNotification = func(n notification.Notification) {
	if st := store.Get(); st != nil {
		st.Notification.Add(n)
	}
}

// realVersion 可展示的版本号：中心链结果文件的 version 恒为字面量 "center"，
// 开发构建为 "dev"——两者插进「vX」模板都是错话，退回无版本号文案
func realVersion(v string) bool {
	return v != "" && v != "center" && v != "dev"
}

// notifyUpdateStarted 受理点入账「开始」（info）：动作回版本面板看进度
func notifyUpdateStarted(version string) {
	publishNotification(notification.Notification{
		Type:      "info",
		Category:  notification.CategorySystem,
		TitleKey:  notifyStartedTitleKey,
		BodyKey:   notifyStartedBodyKey,
		Title:     "开始更新到 v" + version,
		MsgParams: map[string]any{"version": version},
		Action:    ActionUpdatePanel,
	})
}

// notifyUpdateFailed 受理后本进程内失败（下载/校验/拉起子进程）入账「失败」
// （error，webhook important 默认外发集合）：Body = 状态机 errMsg 原文
func notifyUpdateFailed(version, reason string) {
	publishNotification(failedNotification(version, reason))
}

func failedNotification(version, reason string) notification.Notification {
	n := notification.Notification{
		Type:      "error",
		Category:  notification.CategorySystem,
		TitleKey:  notifyFailedTitleBareKey,
		BodyKey:   notifyFailedBodyKey,
		Title:     "更新失败",
		Body:      reason,
		MsgParams: map[string]any{"version": version},
		Action:    ActionUpdatePanel,
	}
	if realVersion(version) {
		n.TitleKey = notifyFailedTitleKey
		n.Title = "更新到 v" + version + " 失败"
	}
	return n
}

// resultNotification 结果文件 → 通知。running = 本进程（新版本或回滚后的旧
// 版本）的构建版本：成功时它就是已生效的版本（中心链结果文件的 version 是
// "center" 字面量，不可用）；回滚时它是被恢复的版本。未知状态值返回 false
func resultNotification(r *UpdateResult, running string) (notification.Notification, bool) {
	switch r.Status {
	case string(StatusSuccess):
		v := running
		if !realVersion(v) {
			v = r.Version
		}
		n := notification.Notification{
			Type:      "success",
			Category:  notification.CategorySystem,
			TitleKey:  notifySuccessTitleBareKey,
			BodyKey:   notifySuccessBodyKey,
			Title:     "更新已完成",
			MsgParams: map[string]any{"version": v},
		}
		if realVersion(v) {
			n.TitleKey = notifySuccessTitleKey
			n.Title = "已更新到 v" + v
		}
		return n, true
	case string(StatusRolledBack):
		n := notification.Notification{
			Type:      "warning",
			Category:  notification.CategorySystem,
			TitleKey:  notifyRolledBackTitleKey,
			BodyKey:   notifyRolledBackBodyBareKey,
			Title:     "更新未成功，已自动回滚",
			Body:      r.Error,
			MsgParams: map[string]any{"version": running},
			Action:    ActionUpdatePanel,
		}
		if realVersion(running) {
			n.BodyKey = notifyRolledBackBodyKey
		}
		return n, true
	case string(StatusFailed):
		// 子进程侧失败（等旧进程退出超时/备份失败）：由监管者重拉的旧进程观察窗送达
		return failedNotification(r.Version, r.Error), true
	}
	return notification.Notification{}, false
}

// 结果观察窗（启动后）：换包子进程在新进程健康检查通过后才落盘结果（回滚
// 路径在重拉旧进程之后落盘）——两者都晚于本进程模块 Start，启动时只读一次
// 必然扑空（原方案「Start 读结果文件」的时序缺口）。窗口覆盖健康检查 15s +
// 回滚重拉余量；无结果文件的常规启动只付出窗口内的 stat 级轮询。包级变量供
// 测试压缩——取值口为原子形态（P-20261110-1 S6 入 race 门禁时暴露的存量测试
// 竞争：前一用例经 Module.Start 起的观察窗 goroutine 收尾期仍在逐轮读间隔，
// 后一用例压缩窗口即并发写；生产从不改写，取值与读取点零变化）
var (
	resultWatchWindow   = newAtomicDuration(2 * time.Minute)
	resultWatchInterval = newAtomicDuration(2 * time.Second)
)

// atomicDuration 可并发读写的时长取值口（仅测试改写，观察窗 goroutine 并发读）
type atomicDuration struct{ ns atomic.Int64 }

func newAtomicDuration(d time.Duration) *atomicDuration {
	a := &atomicDuration{}
	a.ns.Store(int64(d))
	return a
}

func (a *atomicDuration) Load() time.Duration   { return time.Duration(a.ns.Load()) }
func (a *atomicDuration) Store(d time.Duration) { a.ns.Store(int64(d)) }

// resultFreshWindow 结果新鲜窗：与启动期 ClearOldUpdateResult 的 5 分钟同口径
// ——超窗的结果不补推（迟到的「更新完成」是噪声，通知中心也已有当时的记录）
const resultFreshWindow = 5 * time.Minute

// publishUpdateResult 观察窗单步：返回 true = 本轮已处置（已推送 / 早已推送 /
// 陈旧不推 / 未知状态），观察窗可收工；false = 尚无可判定结果（未落盘，或
// 撞上子进程半写读到坏 JSON），继续等
func publishUpdateResult(dataDir, running string, now time.Time) bool {
	r, err := LoadUpdateResult(dataDir)
	if err != nil || r == nil {
		return false
	}
	if r.NotifiedAt != "" {
		return true
	}
	ts, perr := time.Parse(time.RFC3339, r.Timestamp)
	if perr != nil || now.Sub(ts) > resultFreshWindow {
		return true
	}
	n, ok := resultNotification(r, running)
	if !ok {
		return true
	}
	publishNotification(n)
	if err := MarkUpdateResultNotified(dataDir, now); err != nil {
		// 回写失败只影响跨重启防重（5 分钟窗内再重启会重推一次），不阻断
		slog.Warn("update: mark result notified failed", "err", err)
	}
	slog.Info("update: result notification published", "status", r.Status, "version", r.Version)
	return true
}
