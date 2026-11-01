package filestore

import (
	"os"
	"path/filepath"
)

// 跨进程写互斥：kind 级锁文件 <dataDir>/<kind>.lock（放在 kind 目录外——
// Clear 会 RemoveAll kind 目录，锁文件不能随之消失，否则清库瞬间两个进程
// 可能各自建出新锁文件、互斥失效）。
//
// 只锁变更类操作：读路径依赖 atomicWrite 的 tmp+rename 原子性（读者要么看到
// 旧文档要么看到新文档），无需加锁；写路径在进程内 per-kind RWMutex 之上
// 再叠加进程间 flock，防两个进程（如 git credential-helper 子进程与主进程、
// 或误起的双服务实例）整文件读改写互相覆盖（持久化纪律债务：snippets all /
// terminal_history 这类 RMW store 的第二写者隐患）。
//
// 锁不可得（目录不可建/系统不支持）时退化为无锁——与历史行为一致，不阻断。
// 未来换 SQLite 后由数据库文件锁接替，本机制随文件实现退役
func (s *fileDocStore) lockKindDir(kind string) (release func()) {
	lockPath := filepath.Join(s.dir, "data", kind+".lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0755); err != nil {
		return func() {}
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return func() {}
	}
	if err := lockFD(f); err != nil {
		_ = f.Close()
		return func() {}
	}
	return func() {
		_ = unlockFD(f)
		_ = f.Close()
	}
}
