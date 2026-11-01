package auth

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"codecombo/server/config"
	"codecombo/server/store"
)

// SSHInjection 是给 git 子进程注入的 SSH 配置
//
// 调用方按 Env 注入环境变量；若 PreExec / PostExec 非 nil 则在 git 调用前后分别执行
//
// 设计意图：
//   - KeyPathSSHResolver（默认）：Env=[GIT_SSH_COMMAND=ssh -i ...]，PreExec/PostExec 为 nil（tmp 文件由 LRU 管理生命周期）
//   - 未来 AgentForwardSSHResolver：PreExec 启 ssh-agent，PostExec 关 ssh-agent，Env=[SSH_AUTH_SOCK=...]
//   - 未来 DeployKeySSHResolver：根据 repoPath 选 deploy key，PreExec 写 .ssh/config，PostExec 清理
type SSHInjection struct {
	Env      []string // e.g. ["GIT_SSH_COMMAND=ssh -i ..."]
	PreExec  func() error
	PostExec func() error
}

// SSHKeyLRU 进程级 LRU 缓存：cacheKey → tmp key path
//
// 避免同 host 频繁 git op（auto-fetch 60s/次）反复解密 PEM 写删 tmp 文件
//
// cacheKey 格式为 "<host>:<key.ID>"，保证同一 host 切换不同 key 时不会复用错误文件
//
// 并发安全：所有公开方法加锁；tmp 文件由 LRU 管理生命周期，LRU 淘汰或 Cleanup 时删除
type SSHKeyLRU struct {
	mu    sync.Mutex
	cache map[string]string // cacheKey → tmp key path
	order []string          // LRU 顺序（首部最旧，尾部最新）
	cap   int
}

// NewSSHKeyLRU 构造指定容量的 SSH key LRU
// cap <= 0 时退化为默认值 16
// main.go 启动期调用，注入到 KeyPathSSHResolver.Cache
func NewSSHKeyLRU(cap int) *SSHKeyLRU {
	if cap <= 0 {
		cap = 16
	}
	return &SSHKeyLRU{
		cache: make(map[string]string, cap),
		cap:   cap,
	}
}

// GetOrWrite 命中返回已存在 path；未命中解密 PEM 写新 tmp 文件
//
// tmp 文件位于 <DataDir>/cache/sc-key-<randomSuffix>（权限 0600）
// 同一 key 多次调用返回稳定 path（命中即复用），并刷新 LRU 顺序到尾部
//
// 注意：key 为 nil 时返回 ("", nil)，由调用方决定如何处理（通常视为无 key，让 git 走默认 ssh）
//
// 并发：内部加锁；解密 + 写文件在锁内完成（避免并发请求同 key 时多次写文件）
// 单次解密约 100us / 写文件约 1ms，可接受；命中路径不进 I/O，直接返回
func (l *SSHKeyLRU) GetOrWrite(key *store.SSHKey) (string, error) {
	if key == nil {
		return "", nil
	}
	cacheKey := key.Host + ":" + key.ID

	l.mu.Lock()
	defer l.mu.Unlock()

	// Cleanup() 后可能 cache/order 为 nil；写 nil map 会 panic，这里重建
	if l.cache == nil {
		l.cache = make(map[string]string, l.cap)
		l.order = make([]string, 0, l.cap)
	}

	// 命中：刷新 LRU 顺序到尾部
	if path, ok := l.cache[cacheKey]; ok {
		l.moveToBackLocked(cacheKey)
		return path, nil
	}

	// 未命中：解密 PEM
	if key.PrivatePem == "" {
		return "", fmt.Errorf("ssh key private_pem empty: %s", cacheKey)
	}
	pem, err := config.DecryptToken(key.PrivatePem)
	if err != nil {
		return "", fmt.Errorf("decrypt ssh key: %w", err)
	}

	// 写 tmp 文件
	path, err := writeSSHKeyTmp(pem)
	if err != nil {
		return "", err
	}

	// 容量超限：淘汰最旧条目（先删文件再清 map，避免泄漏）
	if len(l.order) >= l.cap {
		oldest := l.order[0]
		if oldPath, ok := l.cache[oldest]; ok {
			_ = os.Remove(oldPath)
		}
		delete(l.cache, oldest)
		l.order = l.order[1:]
	}

	l.cache[cacheKey] = path
	l.order = append(l.order, cacheKey)
	return path, nil
}

// moveToBackLocked 将 cacheKey 移到 LRU 尾部（最近使用）
// 调用方必须已持有 l.mu
func (l *SSHKeyLRU) moveToBackLocked(cacheKey string) {
	for i, k := range l.order {
		if k == cacheKey {
			// 已在尾部则无需移动
			if i == len(l.order)-1 {
				return
			}
			l.order = append(l.order[:i], l.order[i+1:]...)
			l.order = append(l.order, cacheKey)
			return
		}
	}
}

// Cleanup 进程退出时调用，删除所有缓存的 tmp key 文件
// 在 main.go 注册 atexit 或显式调用
//
// 注意：cleanup 后清空 map 但不置 nil；GetOrWrite 会检查并在需要时重建
func (l *SSHKeyLRU) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, path := range l.cache {
		_ = os.Remove(path)
	}
	for k := range l.cache {
		delete(l.cache, k)
	}
	l.order = l.order[:0]
}

// Invalidate 按 keyID 失效对应的所有缓存条目并删除 tmp 文件
//
// 用于 SSH key 被用户删除时（admin/sshkey.go DeleteSshKey），立即清理
// 缓存内对应的明文 PEM tmp 文件，避免磁盘残留敏感数据
//
// cacheKey 格式为 "<host>:<keyID>"，因此按后缀 ":<keyID>" 匹配可同时
// 清掉该 key 在多 host 下挂载的所有条目
func (l *SSHKeyLRU) Invalidate(keyID string) {
	if keyID == "" {
		return
	}
	suffix := ":" + keyID
	l.mu.Lock()
	defer l.mu.Unlock()
	for cacheKey, path := range l.cache {
		if strings.HasSuffix(cacheKey, suffix) {
			_ = os.Remove(path)
			delete(l.cache, cacheKey)
			l.order = removeFromSlice(l.order, cacheKey)
		}
	}
}

// removeFromSlice 返回去掉首个 v 的新 slice（不修改原 slice 顺序）
// 与 append 拼合实现 O(n)，LRU 容量通常 16，性能可忽略
func removeFromSlice(s []string, v string) []string {
	for i, x := range s {
		if x == v {
			return append(s[:i], s[i+1:]...)
		}
	}
	return s
}

// CleanupStaleSSHKeyCache 扫描 <dataDir>/cache 目录下 sc-key-* 残留文件并删除
//
// 用途：main.go 启动期调用，清理上次进程异常退出（SIGKILL / panic / os.Exit）
// 遗留的 tmp key 文件——defer 不保证执行，这类残留属正常预期
//
// 实现要点：
//   - 目录不存在视为无残留（首次启动 / 用户清理过）
//   - 仅删除 sc-key-* 前缀的文件，避免误删 cache 目录其他用途
//   - 单文件失败不中断流程，记录到 stderr（此时 slog 可能尚未初始化）
func CleanupStaleSSHKeyCache(dataDir string) error {
	dir := filepath.Join(dataDir, "cache")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "sc-key-") {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
	return nil
}

// Size 返回当前缓存条目数（测试用）
func (l *SSHKeyLRU) Size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.cache)
}

// lookupForTest 仅供测试使用的内部查询（不暴露给生产代码）
//
//go:noinline
func (l *SSHKeyLRU) lookupForTest(cacheKey string) (string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	p, ok := l.cache[cacheKey]
	return p, ok
}

// writeSSHKeyTmp 写 PEM 内容到 <DataDir>/cache/sc-key-<randomSuffix>（权限 0600）
//
// 文件路径随机化（不包含 host/id）避免：
//   - 路径猜测攻击（host 暴露在文件名里）
//   - 多进程并发同名覆盖（即便单进程，host 字符可能含非法字符）
func writeSSHKeyTmp(pem string) (string, error) {
	dir := filepath.Join(config.DataDir(), "cache")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("mkdir cache: %w", err)
	}
	suffix := randomSuffix(8)
	path := filepath.Join(dir, "sc-key-"+suffix)
	if err := os.WriteFile(path, []byte(pem), 0600); err != nil {
		return "", fmt.Errorf("write key: %w", err)
	}
	return path, nil
}

// randomSuffix 生成 hex 随机后缀
// rand.Read 失败的极端情况下退化到 PID 前缀（不安全但保证可运行）
func randomSuffix(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("pid%d", os.Getpid())
	}
	return hex.EncodeToString(b)
}
