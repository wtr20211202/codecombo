package watch

import (
	"codecombo/server/model"
	"codecombo/server/store"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// 需要跳过的目录名：.git/IDE/依赖/构建产物目录。
// 构建产物目录（target/build/bin/out/vendor/.next 等）单次构建可产生每分钟数万
// FS 事件，既耗 inotify 配额又制造广播风暴，且对"源码变更"信号毫无价值
var skipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"dist":         true,
	".idea":        true,
	".vscode":      true,
	".cache":       true,
	"target":       true,
	"vendor":       true,
	"bin":          true,
	"build":        true,
	"out":          true,
	".next":        true,
	".nuxt":        true,
	"__pycache__":  true,
	".gradle":      true,
}

// SkipPath 报告路径是否落在 skipDirs 范围（任一路径段命中即真，含末段——
// 目录创建事件本身也是该目录副作用的一部分）。单一事实源：watcher 不监听
// 这些目录，fsattribution（P-20261005-170）等下游消费方按同一清单防御性
// 同判——降级轮询/项目接入前已存在的目录竞态窗口仍可能漏进事件。
// 代价注记：根下恰有与目录同名的普通文件（如名为 build 的源文件）会被
// 一并排除，属罕见形态的过度排除，宁窄勿宽
func SkipPath(path string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(path), "/") {
		if skipDirs[seg] {
			return true
		}
	}
	return false
}

// opString fsnotify 事件形态归一为小写短标记（create/write/remove/rename/
// chmod，复合事件以 | 连接）——file.changed 载荷的信息性字段（fsattribution
// 账面展示用），不承诺跨平台精确语义
func opString(op fsnotify.Op) string {
	var parts []string
	for _, pair := range []struct {
		bit  fsnotify.Op
		name string
	}{
		{fsnotify.Create, "create"},
		{fsnotify.Write, "write"},
		{fsnotify.Remove, "remove"},
		{fsnotify.Rename, "rename"},
		{fsnotify.Chmod, "chmod"},
	} {
		if op&pair.bit != 0 {
			parts = append(parts, pair.name)
		}
	}
	if len(parts) == 0 {
		return "unknown"
	}
	return strings.Join(parts, "|")
}

// projIndex 用于快速查找项目路径的预构建索引
type projIndex struct {
	id   string
	path string
	len  int
}

// BroadcastFunc 广播回调类型，由上层注入以解耦 watch 和 api 包
type BroadcastFunc func(projectID string, msg model.WSMessage)

type RepoWatcher struct {
	watcher *fsnotify.Watcher
	done    chan struct{}
	bcFunc  BroadcastFunc
	// stopOnce 保证 Stop 幂等（kernel 契约：重复 Stop 不得 panic/副作用）
	stopOnce sync.Once

	// projMu 保护项目路径索引。索引必须支持运行期增量维护：
	// 只在启动时构建一次的话，运行期添加的项目永远不会被关联到事件
	projMu  sync.RWMutex
	projIdx []projIndex

	// inotify 配额看护（P-20261002-67）：Add 错误 ENOSPC 分类计数 + 一次性
	// 告警（配额耗尽事实 / 接近上限预判）。零值可用（去重集合懒初始化），
	// 投递/探测口可注入供单测断言
	inotify inotifyGuard

	// 降级轮询兜底（P-20261003-140）状态域，fallbackMu 串行化全部读写；
	// fingerprint 为空 map/nil 表示基线未建（下一轮 pollOnce 全量广播对齐）
	fallbackMu    sync.Mutex
	fallbackOn    bool
	fallbackSrc   string            // auto / manual
	fallbackSince time.Time         // 本段降级开始时刻
	fallbackStop  chan struct{}     // 非 nil = 扫描循环在跑；关闭即退出
	fingerprints  map[string]string // projectID → 上轮浅层指纹
	// fallbackBroadcast 降级状态迁移的 WS 广播口（P-20261006-34）：nil 缺省 =
	// notification.BroadcastEvent，单测注入断言迁移事件（notify/bcFunc 同款缝）
	fallbackBroadcast func(msgType string, payload any)

	// 敏感文件工作台外写入观测（P-20261005-15）状态域：节流/自环标记表 +
	// 测试注入口，判定链见 external.go
	external externalGuard
}

func NewRepoWatcher(bc BroadcastFunc) (*RepoWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	rw := &RepoWatcher{
		watcher: w,
		done:    make(chan struct{}),
		bcFunc:  bc,
	}
	// 降级自动启用接线（P-20261003-140）：配额耗尽事实 → 轮询兜底。
	// 钩子触发不依赖通知投递口装配（降级不能因通知不可用而失效）
	rw.inotify.onExhausted = rw.enableFallbackAuto
	return rw, nil
}

func (rw *RepoWatcher) Start() {
	go func() {
		// 使用带过期清理的防抖映射，避免无限增长
		type debounceEntry struct {
			lastFire time.Time
		}
		debounce := make(map[string]*debounceEntry)
		const debounceInterval = 500 * time.Millisecond
		const cleanupInterval = 30 * time.Second
		lastCleanup := time.Now()

		// 项目路径索引：启动时从 store 构建，之后由 TrackProject/UntrackProject 增量维护
		rw.refreshIndex()

		for {
			select {
			case <-rw.done:
				return
			case event, ok := <-rw.watcher.Events:
				if !ok {
					return
				}
				if isDotGitPath(event.Name) {
					continue
				}
				// 防抖
				now := time.Now()
				entry := debounce[event.Name]
				if entry != nil && now.Sub(entry.lastFire) < debounceInterval {
					continue
				}
				debounce[event.Name] = &debounceEntry{lastFire: now}

				// 定期清理过期的防抖条目
				if now.Sub(lastCleanup) > cleanupInterval {
					for k, v := range debounce {
						if now.Sub(v.lastFire) > cleanupInterval {
							delete(debounce, k)
						}
					}
					lastCleanup = now
				}

				projectID := rw.findProjectID(event.Name)
				if projectID == "" {
					continue
				}

				// 敏感外部写入观测（P-20261005-15）：只看内容变更类事件
				//（Write=原地改写 / Create=新建或原子替换 rename-into-place；
				// Chmod/Remove 不在观测面——被删敏感文件是另一类信号，列为后续）。
				// 判定链内部自短路：非敏感名的事件成本一次 basename + 十来次 glob
				if event.Op&(fsnotify.Write|fsnotify.Create) != 0 {
					rw.observe(projectID, event.Name)
				}

				// 事件风暴场景（构建/依赖安装）下每条事件同步落盘会形成 IO 热点，降为 Debug
				slog.Debug("file changed", "path", event.Name)
				if rw.bcFunc != nil {
					// op（P-20261005-170）：fsnotify 形态随载荷下发（fsattribution
					// 账面消费；WS 侧未知字段，前端零改动）
					rw.bcFunc(projectID, model.WSMessage{
						Type: "file.changed",
						Data: map[string]string{"path": event.Name, "op": opString(event.Op)},
					})
				}

			case err, ok := <-rw.watcher.Errors:
				if !ok {
					return
				}
				slog.Error("watcher error", "err", err)
			}
		}
	}()
}

// findProjectID 使用索引快速查找项目ID
func (rw *RepoWatcher) findProjectID(path string) string {
	rw.projMu.RLock()
	defer rw.projMu.RUnlock()
	return findProjectIDFast(path, rw.projIdx)
}

// indexKeyPath 项目根 → 索引键：ToSlash + 去尾分隔符。尾斜杠会破坏 findProjectIDFast
// 的前缀边界判定（文件路径的前缀后首字符是文件名而非 '/'），两个建索引入口
// 共用本归一防漂移
func indexKeyPath(p string) string {
	return strings.TrimSuffix(filepath.ToSlash(p), "/")
}

// refreshIndex 从 store 全量重建索引（启动时调用）。store 未装配/项目仓储缺失
// 时直接返回：本函数在 Start 派生的 goroutine 里惰性调度，测试 teardown 把
// store 置 nil 后 goroutine 才被执行的竞态窗口会在此 panic（Linux 实测）——
// goroutine 生命周期不受 done 通道管辖（done 只关 select 循环），防御性守卫
func (rw *RepoWatcher) refreshIndex() {
	st := store.Get()
	if st == nil || st.Project == nil {
		return
	}
	projects, err := st.Project.List()
	if err != nil {
		projects = nil
	}
	idx := make([]projIndex, 0, len(projects))
	for _, p := range projects {
		slashPath := indexKeyPath(p.Path)
		idx = append(idx, projIndex{id: p.ID, path: slashPath, len: len(slashPath)})
	}
	rw.projMu.Lock()
	rw.projIdx = idx
	rw.projMu.Unlock()
}

// addIndexEntry 增量加入一个项目路径（运行期添加项目场景）
func (rw *RepoWatcher) addIndexEntry(id, path string) {
	slashPath := indexKeyPath(path)
	rw.projMu.Lock()
	defer rw.projMu.Unlock()
	for _, p := range rw.projIdx {
		if p.id == id {
			return // 已存在
		}
	}
	rw.projIdx = append(rw.projIdx, projIndex{id: id, path: slashPath, len: len(slashPath)})
}

// removeIndexEntry 移除一个项目的索引项
func (rw *RepoWatcher) removeIndexEntry(id string) {
	rw.projMu.Lock()
	defer rw.projMu.Unlock()
	for i, p := range rw.projIdx {
		if p.id == id {
			rw.projIdx = append(rw.projIdx[:i], rw.projIdx[i+1:]...)
			return
		}
	}
}

// findProjectIDFast 事件路径 → 归属项目：最长前缀 wins（嵌套项目语义——文件
// 归最具体的项目根。仓库根作项目 + 仓库内临时目录也注册成项目是 e2e 常态，
// 生产「同根多项目」同样现实；此前「索引序首个前缀命中即返回」让后建的内层
// 项目永远拿不到自己子树的事件（P-20261005-170 归因账因此整账落空），且行为
// 随建序漂移）。前缀边界显式判分隔符：repos/foo 与 repos/foobar 兄弟目录
// 不互串。多项目同根（罕见）保持索引序先到先得
func findProjectIDFast(path string, idx []projIndex) string {
	filePath := filepath.ToSlash(path)
	bestID := ""
	bestLen := 0
	for _, p := range idx {
		if p.len <= bestLen || len(filePath) < p.len || filePath[:p.len] != p.path {
			continue
		}
		if len(filePath) > p.len && filePath[p.len] != '/' {
			continue
		}
		bestID = p.id
		bestLen = p.len
	}
	return bestID
}

func isDotGitPath(path string) bool {
	parts := strings.Split(filepath.ToSlash(path), "/")
	for _, part := range parts {
		if part == ".git" {
			return true
		}
	}
	return false
}

// addDirRecursive 递归添加目录到watcher。Add 失败按 ENOSPC 特征分类计数，
// 收口处交 inotifyGuard 评估：配额实际耗尽 / 接近真实上限时经通知中心发
// 一次性告警（此前仅此处一行 slog.Debug，用户侧零信号——文件树/变更面板
// 悄悄停止刷新而无从归因）。返回本轮 ENOSPC 失败数（降级重挂后判定配额
// 是否仍耗尽用），err 为遍历本身的错误（权限等，不影响 ENOSPC 判定）
func (rw *RepoWatcher) addDirRecursive(root string) (int, error) {
	watched, total, enospc := 0, 0, 0
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || !info.IsDir() {
			return nil
		}
		if skipDirs[info.Name()] {
			return filepath.SkipDir
		}
		total++
		if e := rw.watcher.Add(path); e != nil {
			if isENOSPC(e) {
				enospc++
			}
			slog.Debug("watch add fail", "path", path, "err", e)
		} else {
			watched++
		}
		return nil
	})
	slog.Debug("watching dirs", "count", watched, "root", root)
	rw.inotify.check(watched, total, enospc)
	return enospc, err
}

// removeDirRecursive 尽力而为地移除 root 及其子目录的监听。
// 底层目录从磁盘消失时 fsnotify 会自行清理对应 watch，这里兜底显式移除
func (rw *RepoWatcher) removeDirRecursive(root string) {
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || !info.IsDir() {
			return nil
		}
		if e := rw.watcher.Remove(path); e != nil {
			slog.Debug("watch remove fail", "path", path, "err", e)
		}
		return nil
	})
}

// TrackProject 运行期接入一个项目：递归建立监听 + 增量维护索引。
// 启动期项目由 WatchAll 覆盖；此后新增项目必须走本方法，否则其文件事件
// 因索引缺失而被丢弃
func (rw *RepoWatcher) TrackProject(id, path string) error {
	if _, err := rw.addDirRecursive(path); err != nil {
		return err
	}
	rw.addIndexEntry(id, path)
	return nil
}

// UntrackProject 运行期摘除一个项目：移除监听与索引（降级指纹随项目生命周期清理）
func (rw *RepoWatcher) UntrackProject(id, path string) {
	rw.removeDirRecursive(path)
	rw.removeIndexEntry(id)
	rw.fallbackMu.Lock()
	delete(rw.fingerprints, id)
	rw.fallbackMu.Unlock()
}

func (rw *RepoWatcher) WatchProject(path string) error {
	_, err := rw.addDirRecursive(path)
	return err
}

func (rw *RepoWatcher) RemoveWatch(path string) error {
	return rw.watcher.Remove(path)
}

func (rw *RepoWatcher) Stop() {
	rw.stopOnce.Do(func() {
		close(rw.done)
		rw.watcher.Close()
	})
}

func (rw *RepoWatcher) WatchAll() {
	// store 未装配守卫：本函数由模块 Start 放进独立 goroutine（WatchAll 以秒计
	// 不占 HTTP 监听），与 refreshIndex 同一竞态暴露面——测试 teardown 置 nil
	// store 后才被调度时不得 panic
	st := store.Get()
	if st == nil || st.Project == nil {
		return
	}
	projects, err := st.Project.List()
	if err != nil {
		projects = nil
	}
	for _, p := range projects {
		if err := rw.WatchProject(p.Path); err != nil {
			slog.Error("failed to watch project", "path", p.Path, "err", err)
		}
	}
}
