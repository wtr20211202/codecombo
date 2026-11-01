package watch

// 降级轮询兜底（P-20261003-140）：inotify 配额耗尽后（P-20261002-67 告警已
// 落地，但告警后功能仍是坏的——受影响子树文件变更不再被感知，文件树/变更
// 面板陈旧直到手动刷新）。这里让功能「降级而非失效」：
//
//   - 配额耗尽事实（inotifyGuard check 的 ENOSPC 计数）触发自动启用服务端
//     轮询扫描：按固定间隔对全部已跟踪项目做「浅层」指纹比对，变化即广播
//     与 fsnotify 同一条 file.changed 管道（事件总线 → WS），前端零改动；
//   - 浅层 = 项目根 + 一级子目录（跳过 skipDirs、条目上限封顶），深层变更
//     靠目录 mtime 部分覆盖——轮询是降级态的尽力而为，不做全仓扫（防 N 万
//     条目级 Lstat 每 5s 重演）；
//   - 每 probeEveryTicks 轮探测一次配额是否释放（临时目录 Add 探针）：释放
//     则重挂全部项目监听，重挂零 ENOSPC 即自动切回实时 watcher 并通知；
//   - 告警通知携「切换轮询」动作（手动亦可），经 /api/watch/fallback 手动
//     开关（手动开启属用户显式选择，不参与自动恢复，重启回落关闭）。
//
// 状态为进程内存态：重启后 watcher 重新建立，若配额仍耗尽，ENOSPC 会再次
// 触发自动降级——自愈循环不需要持久化（与端口注册表同类的内存态 MVP）。

import (
	"hash/fnv"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"codecombo/server/model"
	"codecombo/server/notification"
)

const (
	// fallbackPollInterval 轮询间隔（提案锚点 5s）：降级态可用性下限与
	// 扫描开销的折中——间隔内变更延迟可见，5s 对文件树/变更面板足够及时
	fallbackPollInterval = 5 * time.Second

	// fallbackProbeEvery 每 N 轮轮询做一次配额释放探测（5s×12=60s）：探测
	// 本身廉价（一次临时目录 mkdir+Add+Remove），重挂才是全树 walk，60s 粒度
	// 足够感知「用户调大 max_user_watches / 大量 watch 被释放」
	fallbackProbeEvery = 12

	// fallbackDepth 浅层深度：根目录 + 一级子目录（深度 2 的条目进指纹）。
	// 更深的变更中，「直接子目录的 mtime」仍能覆盖其下 create/delete/rename，
	// 已改文件的内容修改不覆盖——降级态的诚实边界
	fallbackDepth = 2

	// fallbackMaxEntries 单项目单轮指纹条目上限：超宽根目录（依赖扁平化仓
	// 库等）封顶扫描量，超出部分不进指纹（确定性截断——ReadDir 有序，指纹
	// 仍稳定，只是覆盖面收窄）
	fallbackMaxEntries = 2000
)

// 降级来源：auto=配额耗尽自动启用（参与自动恢复）；manual=用户手动开启
// （尊重显式选择，不自动切回，重启回落关闭）
const (
	fallbackSrcAuto   = "auto"
	fallbackSrcManual = "manual"
)

// fallbackStateEvent 降级状态迁移的 WS 广播消息类型（通知 WS 自由载荷通道，
// sync.progress 同先例）。白名单纪律：代码内常量，不开放用户输入
const fallbackStateEvent = "watch.fallback"

// fallbackEvent 降级状态广播载荷（GET /api/watch/fallback 响应体 Status 同形
// ——同一事实两个面：REST 答快照，WS 推迁移；前端加载拉一次快照兜底 +
// 事件驱动显隐，见 P-20261006-34）
type fallbackEvent struct {
	Enabled bool   `json:"enabled"`
	Source  string `json:"source,omitempty"` // auto / manual；未启用省略
	Since   string `json:"since,omitempty"`  // RFC3339，本段降级开始时刻
}

// startFallbackLocked 启用降级并拉起扫描循环（调用方须持有 fallbackMu）
func (rw *RepoWatcher) startFallbackLocked(src string) {
	rw.fallbackOn = true
	rw.fallbackSrc = src
	rw.fallbackSince = time.Now()
	stop := make(chan struct{})
	rw.fallbackStop = stop
	go rw.runFallbackLoop(stop)
}

// stopFallbackLocked 关闭降级（调用方须持有 fallbackMu）；扫描循环经 stop
// 信号退出，RepoWatcher.Stop 关闭的 rw.done 是兜底退出路径
func (rw *RepoWatcher) stopFallbackLocked() {
	if rw.fallbackStop != nil {
		close(rw.fallbackStop)
		rw.fallbackStop = nil
	}
	rw.fallbackOn = false
	rw.fallbackSrc = ""
	rw.fallbackSince = time.Time{}
}

// runFallbackLoop 降级扫描主循环：每 tick 对全部项目做浅层指纹比对（变化即
// 广播 file.changed）；auto 来源下每 probeEveryTicks 轮探测配额释放并尝试
// 自动恢复
func (rw *RepoWatcher) runFallbackLoop(stop <-chan struct{}) {
	ticker := time.NewTicker(fallbackPollInterval)
	defer ticker.Stop()
	tick := 0
	for {
		select {
		case <-stop:
			return
		case <-rw.done:
			return
		case <-ticker.C:
			rw.fallbackMu.Lock()
			on, src := rw.fallbackOn, rw.fallbackSrc
			rw.fallbackMu.Unlock()
			if !on {
				return
			}
			rw.pollOnce()
			tick++
			if src == fallbackSrcAuto && tick%fallbackProbeEvery == 0 {
				rw.probeAndMaybeRestore()
			}
		}
	}
}

// enableFallbackAuto 配额耗尽钩子（inotifyGuard.onExhausted）：自动启用降级。
// 已启用时幂等 no-op；通知与首轮广播在锁外做（store I/O 不持锁）
func (rw *RepoWatcher) enableFallbackAuto() {
	rw.fallbackMu.Lock()
	if rw.fallbackOn {
		rw.fallbackMu.Unlock()
		return
	}
	rw.startFallbackLocked(fallbackSrcAuto)
	rw.fallbackMu.Unlock()
	slog.Warn("inotify quota exhausted — degraded polling fallback enabled (shallow scan, 5s interval)")
	rw.broadcastFallbackState()
	if notify := rw.notifyOutlet(); notify != nil {
		notify(fallbackEnabledNotification())
	}
	rw.pollOnce() // 首轮立即广播：前端全量拉取对齐现实（耗尽窗口内的漂移一次清账）
}

// SetFallback 手动开关降级（/api/watch/fallback 写入口）。enable nil = 翻转；
// 返回开关后的状态（enabled, source, since）供响应体与前端反馈
func (rw *RepoWatcher) SetFallback(enable *bool) (bool, string, time.Time) {
	rw.fallbackMu.Lock()
	want := !rw.fallbackOn
	if enable != nil {
		want = *enable
	}
	switch {
	case want && !rw.fallbackOn:
		rw.fingerprints = map[string]string{} // 重置基线：开启首轮全量广播对齐
		rw.startFallbackLocked(fallbackSrcManual)
		rw.fallbackMu.Unlock()
		rw.pollOnce()
		slog.Info("watch fallback polling enabled manually")
		rw.broadcastFallbackState()
	case !want && rw.fallbackOn:
		rw.stopFallbackLocked()
		rw.fingerprints = nil
		rw.fallbackMu.Unlock()
		slog.Info("watch fallback polling disabled")
		rw.broadcastFallbackState()
	default:
		rw.fallbackMu.Unlock()
	}
	return rw.FallbackStatus()
}

// FallbackStatus 当前降级状态（enabled, source, since）
func (rw *RepoWatcher) FallbackStatus() (bool, string, time.Time) {
	rw.fallbackMu.Lock()
	defer rw.fallbackMu.Unlock()
	return rw.fallbackOn, rw.fallbackSrc, rw.fallbackSince
}

// broadcastFallbackState 降级状态迁移广播（P-20261006-34）：降级是持续态，
// 可见性不靠一次性通知记忆——前端状态栏「轮询降级中」微标以本事件驱动显隐，
// 页面加载时拉一次 GET 快照兜底，不做高频轮询。经通知 WS 自由载荷通道
// （notification.BroadcastEvent，hub 未装配时自 nil 短路——降级功能不受通知
// 面可用性影响）；广播口实例域可注入（notify/bcFunc 同款单测缝）
func (rw *RepoWatcher) broadcastFallbackState() {
	broadcast := rw.fallbackBroadcast
	if broadcast == nil {
		broadcast = notification.BroadcastEvent
	}
	on, src, since := rw.FallbackStatus()
	ev := fallbackEvent{Enabled: on, Source: src}
	if on && !since.IsZero() {
		ev.Since = since.Format(time.RFC3339)
	}
	broadcast(fallbackStateEvent, ev)
}

// pollOnce 一轮浅层指纹比对：项目根缺失/读失败跳过本轮（项目删除中/暂时
// 不可达，不误广播）；指纹变化即广播 file.changed（每项目每轮至多一条——
// 前端消费是全量刷新，逐文件广播只会放大风暴）
func (rw *RepoWatcher) pollOnce() {
	for _, p := range rw.projectSnapshot() {
		root := filepath.FromSlash(p.path)
		fp, ok := shallowFingerprint(root)
		if !ok {
			continue
		}
		rw.fallbackMu.Lock()
		if rw.fingerprints == nil {
			rw.fingerprints = map[string]string{} // 自动启用路径未预建基线表
		}
		prev := rw.fingerprints[p.id]
		rw.fingerprints[p.id] = fp
		rw.fallbackMu.Unlock()
		if prev == fp || rw.bcFunc == nil {
			continue
		}
		// op 缺省：轮询指纹只知道「根下有变化」，具体形态不可考——fsattribution
		// 账面按无 op 记录（诚实边界）
		rw.bcFunc(p.id, model.WSMessage{
			Type: "file.changed",
			Data: map[string]string{"path": root},
		})
	}
}

// probeAndMaybeRestore 配额释放探测 + 自动恢复（仅 auto 来源调用）：
// 临时目录 Add 探针失败（仍 ENOSPC）保持降级；成功则重挂全部项目监听，
// 重挂零 ENOSPC 即切回实时 watcher 并发恢复通知。手动开启不参与——那是
// 用户的显式选择，切回与否应由用户再按一次开关
func (rw *RepoWatcher) probeAndMaybeRestore() {
	probe, err := os.MkdirTemp("", "sc-watch-probe-")
	if err != nil {
		return // 无法探测（临时目录不可写等），保持降级下轮再试
	}
	freed := false
	if addErr := rw.watcher.Add(probe); addErr == nil {
		freed = true
	} else if !isENOSPC(addErr) {
		slog.Debug("watch fallback probe failed non-ENOSPC", "err", addErr)
	}
	_ = rw.watcher.Remove(probe)
	_ = os.Remove(probe)
	if !freed {
		return
	}

	stillExhausted := false
	for _, p := range rw.projectSnapshot() {
		if enospc, _ := rw.addDirRecursive(filepath.FromSlash(p.path)); enospc > 0 {
			stillExhausted = true
		}
	}
	if stillExhausted {
		return // 配额又满了（释放窗口极短），保持降级
	}

	rw.fallbackMu.Lock()
	if !rw.fallbackOn || rw.fallbackSrc != fallbackSrcAuto {
		// 探测/重挂期间被手动关闭或来源变化：尊重现状不抢切
		rw.fallbackMu.Unlock()
		return
	}
	rw.stopFallbackLocked()
	rw.fingerprints = nil
	rw.fallbackMu.Unlock()
	slog.Info("inotify quota freed — watcher re-established, degraded polling fallback removed")
	rw.broadcastFallbackState()
	if notify := rw.notifyOutlet(); notify != nil {
		notify(fallbackRestoredNotification())
	}
}

// projectSnapshot 已跟踪项目快照（id + slash 路径），锁内拷贝锁外遍历
func (rw *RepoWatcher) projectSnapshot() []projIndex {
	rw.projMu.RLock()
	defer rw.projMu.RUnlock()
	out := make([]projIndex, len(rw.projIdx))
	copy(out, rw.projIdx)
	return out
}

// fpEntry 浅层条目（depth 用于测试断言扫描覆盖边界；1=根直下，2=一级子目录直下）
type fpEntry struct {
	depth int
	name  string
	size  int64
	mtime int64
}

// shallowEntries 项目根浅层条目清单（根 + 一级子目录，跳过 skipDirs，条目
// 上限封顶）。ok=false 仅表示根目录不可读（项目删除中等）；单子目录读失败
// 跳过继续（权限受限子树不拖垮整体兜底）。ReadDir 有序 → 清单确定性
func shallowEntries(root string) ([]fpEntry, bool) {
	budget := fallbackMaxEntries
	out := make([]fpEntry, 0, 64)
	exhausted := false
	var walk func(dir string, depth int) bool
	walk = func(dir string, depth int) bool {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return depth != 1 // 根不可读整体失败（false）；子目录失败局部跳过（true）
		}
		for _, e := range entries {
			name := e.Name()
			if skipDirs[name] {
				continue
			}
			if budget <= 0 {
				exhausted = true
				return false
			}
			budget--
			info, err := e.Info()
			if err != nil {
				continue // 竞态删除等瞬时态：该条目本轮不进清单
			}
			out = append(out, fpEntry{
				depth: depth,
				name:  name,
				size:  info.Size(),
				mtime: info.ModTime().UnixNano(),
			})
			if e.IsDir() && depth < fallbackDepth {
				if !walk(filepath.Join(dir, name), depth+1) {
					return false
				}
			}
		}
		return true
	}
	if !walk(root, 1) && !exhausted {
		return nil, false // 非（条目上限触顶导致的）中止，即根不可读
	}
	return out, true
}

// shallowFingerprint 浅层条目清单的 fnv 哈希（pollOnce 的变化判定原语）。
// 注意 Windows Dev Drive/异步元数据文件系统上 mtime 会在写入后短暂漂移——
// 代价只是变更后多广播一轮刷新（前端全量拉取幂等），不影响正确性
func shallowFingerprint(root string) (string, bool) {
	entries, ok := shallowEntries(root)
	if !ok {
		return "", false
	}
	h := fnv.New64a()
	var numBuf [24]byte
	for _, e := range entries {
		// 定界写入消除变长字段前缀歧义（"1"+"2" ≠ "12"）；name 在同一目录
		// 内唯一、跨目录由行序区分——无需拼全路径
		_, _ = h.Write([]byte(e.name))
		_, _ = h.Write([]byte{0})
		_, _ = h.Write(strconv.AppendInt(numBuf[:0], e.size, 10))
		_, _ = h.Write([]byte{'\n'})
		_, _ = h.Write(strconv.AppendInt(numBuf[:0], e.mtime, 10))
		_, _ = h.Write([]byte{'\n'})
	}
	return string(h.Sum(nil)), true
}

// notifyOutlet 通知投递口：复用 inotify 告警同一装配（store 统一投递口，
// 注入口单测可替换）——降级状态迁移与配额告警是同一域的用户可见信号
func (rw *RepoWatcher) notifyOutlet() func(notification.Notification) {
	return rw.inotify.notifyFn()
}

// fallbackEnabledNotification 自动降级通知（info）：告知已切换轮询与边界
// （浅层 + 自动恢复），与配额告警同模板惯例（TitleKey/BodyKey + 中文回退）
func fallbackEnabledNotification() notification.Notification {
	return notification.Notification{
		Type:     "info",
		Category: notification.CategorySystem,
		TitleKey: "notify.watchfallback.enabled.title",
		BodyKey:  "notify.watchfallback.enabled.body",
		Title:    "文件监听已切换轮询模式",
		Body:     "inotify quota exhausted — shallow polling scan (5s) is now keeping the file tree fresh; will switch back automatically once the quota is freed",
	}
}

// fallbackRestoredNotification 恢复通知（success）：重挂成功回到实时监听
func fallbackRestoredNotification() notification.Notification {
	return notification.Notification{
		Type:     "success",
		Category: notification.CategorySystem,
		TitleKey: "notify.watchfallback.restored.title",
		BodyKey:  "notify.watchfallback.restored.body",
		Title:    "文件监听已恢复",
		Body:     "inotify quota freed and watches re-established — real-time watching is back, polling fallback removed",
	}
}
