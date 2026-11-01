package watch

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// inotify 配额告警（P-20261002-67）：Linux 的 fs.inotify.max_user_watches 耗尽时
// fsnotify Add 以 ENOSPC 静默失败——受影响子树的文件变更不再被感知，文件树/
// 变更面板悄悄停止刷新而用户侧零信号（历史上仅服务日志一行预判）。这里把
// Add 错误按 ENOSPC 特征分类计数，配额实际耗尽（或按真实 sysctl 值预判接近
// 上限）时经通知中心发一次性 warning。Windows/macOS 无 inotify 配额：ENOSPC
// 不会发生、/proc 探测必失败，两条路径天然不触发——单一代码路径自适应平台。

const (
	// inotifyWatchesPath 内核参数读取路径（仅 Linux 存在；读不到 = 平台无此限制）
	inotifyWatchesPath = "/proc/sys/fs/inotify/max_user_watches"

	// inotifyNearRatio 预判线：已注册目录数超过真实上限的 80% 即预警
	//（常见默认值 8192（老内核）/524288（新内核）差异大，故以探测值为准）
	inotifyNearRatio = 0.8
)

// 告警类别（一次性去重的 key）：配额已耗尽的事实 / 接近上限的预判
const (
	inotifyFiredExhausted = "exhausted"
	inotifyFiredNear      = "near"
)

// isENOSPC 识别 inotify 配额耗尽的内核错误特征：错误链中含 ENOSPC
// （fsnotify 透传 unix.InotifyAddWatch 的 syscall.Errno，errors.Is 可穿透
// os.SyscallError / fmt.Errorf %w 等包装）。ENOSPC 是所有平台的通用 errno
// 常量，本文件无需平台分支——非 Linux 的 Add 错误恒不匹配，天然自适应
func isENOSPC(err error) bool {
	return err != nil && errors.Is(err, syscall.ENOSPC)
}

// readInotifyWatchesLimit 读取当前 fs.inotify.max_user_watches 值。
// 非 Linux / 读取失败返回 ok=false（调用方跳过预判，不猜默认值）
func readInotifyWatchesLimit() (int, bool) {
	b, err := os.ReadFile(inotifyWatchesPath)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// inotifyGuard inotify 配额看护：一轮目录注册结束后评估，两类告警均进程内
// 一次性去重——配额耗尽不会自愈，重复告警只是打扰（进程重启重新武装，
// 与磁盘水位看护 reset 同语义）。投递口与探测口可注入：单测造 ENOSPC
// 错误/固定上限值断言通知构造（真实配额耗尽在测试环境造不出来）
type inotifyGuard struct {
	mu    sync.Mutex
	fired map[string]bool // 告警类别 → 已发过（懒初始化，零值可用）

	// notify 通知投递口；nil → store 统一投递口（类别偏好过滤/出站广播在
	// store.Notification.Add 内），store 未装配时静默跳过且不消耗去重状态
	notify func(notification.Notification)
	// limit 上限读取口；nil → 读 /proc
	limit func() (int, bool)
	// onExhausted 配额耗尽钩子（P-20261003-140）：ENOSPC 实际发生即触发
	//（先于通知投递口解析——降级启用不能依赖通知装配）；NewRepoWatcher
	// 接线到轮询兜底自动启用，零值 nil 安全
	onExhausted func()
}

// notifyFn 解析投递口：注入优先，否则 store 统一投递口；都不可用返回 nil
func (g *inotifyGuard) notifyFn() func(notification.Notification) {
	if g.notify != nil {
		return g.notify
	}
	if store.Get() == nil {
		return nil
	}
	return store.Get().Notification.Add
}

// limitFn 解析上限读取口：注入优先，否则读 /proc
func (g *inotifyGuard) limitFn() (int, bool) {
	if g.limit != nil {
		return g.limit()
	}
	return readInotifyWatchesLimit()
}

// fireOnce 一次性去重：类别首次调用返回 true 并记档，此后恒 false。
// 零值（fired 未初始化）懒建 map，支持 &RepoWatcher{} 直构的测试路径
func (g *inotifyGuard) fireOnce(category string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.fired == nil {
		g.fired = map[string]bool{}
	}
	if g.fired[category] {
		return false
	}
	g.fired[category] = true
	return true
}

// check 一轮目录注册结束后评估（addDirRecursive 收口处调用）：
//   - ENOSPC 实际发生（enospc > 0）→ 事实告警并收口（配额已耗尽时
//     「接近上限」预判冗余，同轮不再叠加）；同时触发降级钩子（轮询兜底
//     自动启用，P-20261003-140）——钩子先于投递口解析，通知不可用不影响降级
//   - 否则按探测到的真实上限预判：注册总数 > 上限×80% → 一次性预警
//
// watched/total/enospc 分别为成功注册数/尝试注册总数/ENOSPC 失败数
func (g *inotifyGuard) check(watched, total, enospc int) {
	if enospc > 0 && g.onExhausted != nil {
		g.onExhausted()
	}
	notify := g.notifyFn()
	if notify == nil {
		return
	}
	if enospc > 0 {
		if g.fireOnce(inotifyFiredExhausted) {
			limit, limitOK := g.limitFn()
			notify(inotifyExhaustedNotification(enospc, limit, limitOK))
			slog.Warn("inotify watch quota exhausted: some directories failed to register, changes under them will not be noticed",
				"failed", enospc, "watched", watched, "limit", limitString(limit, limitOK))
		}
		return
	}
	if limit, ok := g.limitFn(); ok && float64(total) > float64(limit)*inotifyNearRatio {
		if g.fireOnce(inotifyFiredNear) {
			notify(inotifyNearLimitNotification(total, limit))
			slog.Warn("watching dirs close to inotify limit", "count", total, "limit", limit)
		}
	}
}

// limitString 上限值的语言中立呈现（未知时显式标注，不假装可读）
func limitString(limit int, ok bool) string {
	if !ok {
		return "unknown"
	}
	return strconv.Itoa(limit)
}

// inotifyExhaustedNotification 配额耗尽通知：文案走 i18n 模板
// （notify.inotify.exhausted.*），Title/Body 中文/语言中立原文为无模板消费方
// （webhook 外发、桌面通知）的回退，与磁盘水位通知同惯例。
// Action 携「切换轮询」手动降级入口（P-20261003-140）：前端通知中心按
// watch-fallback 分支调 /api/watch/fallback 翻转兜底态
func inotifyExhaustedNotification(failed, limit int, limitOK bool) notification.Notification {
	return notification.Notification{
		Type:     "warning",
		Category: notification.CategorySystem,
		TitleKey: "notify.inotify.exhausted.title",
		BodyKey:  "notify.inotify.exhausted.body",
		Title:    "文件监听配额耗尽",
		Body: fmt.Sprintf("%d dirs failed to register for watching; fs.inotify.max_user_watches = %s",
			failed, limitString(limit, limitOK)),
		Action:        "watch-fallback",
		ActionPayload: "toggle",
		MsgParams: map[string]any{
			"n":     failed,
			"limit": limitString(limit, limitOK),
		},
	}
}

// inotifyNearLimitNotification 接近上限预警：同 exhausted 的模板惯例，
// type 仍为 warning（与磁盘水位 >80% warn 档一致——预判级也值得弹一次，
// 且一次性去重后不构成打扰）
func inotifyNearLimitNotification(count, limit int) notification.Notification {
	pct := math.Round(float64(count) / float64(limit) * 100)
	return notification.Notification{
		Type:     "warning",
		Category: notification.CategorySystem,
		TitleKey: "notify.inotify.near.title",
		BodyKey:  "notify.inotify.near.body",
		Title:    "文件监听接近配额上限",
		Body: fmt.Sprintf("%d dirs registered, %d%% of fs.inotify.max_user_watches (%d)",
			count, int(pct), limit),
		MsgParams: map[string]any{
			"count": count,
			"limit": strconv.Itoa(limit),
			"pct":   int(pct),
		},
	}
}
