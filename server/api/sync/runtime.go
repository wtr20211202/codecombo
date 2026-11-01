package sync

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"

	"codecombo/server/api/system"
	"codecombo/server/config"
	"codecombo/server/store"
	"codecombo/server/sysinfo"
)

// 运行时环境口：落位根/磁盘水位/构建版本 + 单元级互斥。

// buildVersion 构建版本（对端能力降级文案「对端实例需升级」的数据源）
func buildVersion() string {
	v, _, _ := system.BuildInfo()
	return v
}

// defaultSyncDestRootName 默认落位根尾段（用户主目录下）。
// P-20261025-1 运行时标识切换：~/simple-coding-sync/ → ~/codecombo-sync/。
// 旧前缀落位过的目录不在运行时迁移面内（多实例同步落位是可再生的交付目录，
// 非主数据）——存量主机下次推拉自然落新前缀，旧目录由用户自行处置
const defaultSyncDestRootName = "codecombo-sync"

// syncDestRoot 本端落位根（配置为空回落用户主目录下 codecombo-sync/）。
// 读 doc store 的 settings（config.Load() 是 legacy fallback 不含运行期写入，
// manager.go 同纪律）。返回绝对路径；主目录不可得时回落数据目录（宁有落点，
// 不因环境缺失拒绝服务——落位层还有逐文件错误兜底）
func syncDestRoot() string {
	if cfg := store.Get().Settings.Get(); cfg != nil && cfg.Server.SyncDestRoot != "" {
		return cfg.Server.SyncDestRoot
	}
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		return filepath.Join(home, defaultSyncDestRootName)
	}
	return filepath.Join(config.DataDir(), "sync-landed")
}

// diskFree 路径所在卷的非特权可写空间（写盘预检口径，sysinfo.Avail）。
// 探测失败返回 -1（调用方跳过预检，不盲拦——预检是提前量不是闸门本体）
func diskFree(path string) int64 {
	u, err := sysinfo.Usage(path)
	if err != nil {
		return -1
	}
	return int64(u.Avail)
}

// ── 单元级互斥（方案⑦并发同单元互斥）：同单元同时推拉会撕裂对端落位
//（一半新一半旧），per-key 信号量与 git 写队列 pathLocks 同模式。键 = 单元
// 键（跨实例稳定键），与方向无关——「推 project:X 到 B」与「从 B 拉 project:X」
// 串行化。tryLock 非阻塞：拿不到即该单元「忙」跳过并入账（失败隔离纪律），
// 不让一次手动操作挂在别人未完成的传输上

type keyLocks struct {
	mu    sync.Mutex
	locks map[string]chan struct{}
}

var unitLocks = &keyLocks{locks: map[string]chan struct{}{}}

// tryUnitLock 尝试持有单元锁；成功返回释放函数，失败返回 false
func tryUnitLock(key string) (func(), bool) {
	unitLocks.mu.Lock()
	ch, ok := unitLocks.locks[key]
	if !ok {
		ch = make(chan struct{}, 1)
		unitLocks.locks[key] = ch
	}
	unitLocks.mu.Unlock()
	select {
	case ch <- struct{}{}:
		var once sync.Once
		return func() { once.Do(func() { <-ch }) }, true
	default:
		return nil, false
	}
}

// ── 传输任务序号（进度任务 id 唯一性）──

var jobSeq atomic.Int64

func nextJobID() string {
	return "sync-" + strconv.FormatInt(jobSeq.Add(1), 10)
}
