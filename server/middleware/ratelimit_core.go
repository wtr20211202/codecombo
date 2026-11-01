package middleware

import (
	"sync"
	"time"
)

// rateLimitEntry 单 key 的固定窗口限流状态
//
// 同时供 auth.go 的 IP 限流与 ratelimit.go 的通用限流复用，
// 避免两个文件各自维护等价结构。
//
// 字段：
//   - count：当前窗口内已计入的请求数
//   - expireAt：当前窗口结束时间（到期后下一次访问会重置）
//
// 注意：字段名保留 expireAt（而非 windowEnd），与原 auth.go / ratelimit.go
// 中字段名一致，避免无谓的全量 rename。
type rateLimitEntry struct {
	count    int
	expireAt time.Time
}

// RateLimiter 通用固定窗口限流器
//
// 抽出此类型前，auth.go 的 IP 限流（sync.Map + failCounter）与 ratelimit.go 的
// device_code 限流（sync.Mutex + entries map）各自独立维护等价机制：
//   - 5min GC goroutine
//   - 1min 窗口
//   - entry 结构
//
// 合并后两处都走统一实现，行为完全等价但代码量减半。
//
// 并发安全：单个 RateLimiter 实例可被多个 goroutine 并发调用所有方法。
type RateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rateLimitEntry
	max     int
	window  time.Duration
}

// NewRateLimiter 构造限流器
//
// 参数：
//   - max：每窗口内允许的最大请求数；超出即被限流
//   - window：窗口长度（auth.go IP 限流为 time.Minute）
//
// 构造时启动后台 GC goroutine（每 5 分钟清理已过期条目）防止 map 无限增长。
// GC goroutine 随进程生命周期运行，无需显式停止——进程退出即回收。
func NewRateLimiter(max int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		entries: make(map[string]*rateLimitEntry),
		max:     max,
		window:  window,
	}
	go rl.gcLoop(5 * time.Minute)
	return rl
}

// Hit 命中一次：递增 key 的 count，返回递增后的 count（>max 表示已超阈值）
//
// 语义等价于原 auth.go 的 checkRateLimit + recordFailure 合并路径：
//   - 首次访问 / 窗口已过期 → 重置为 1，返 1
//   - 窗口内 → count++ 后返 count
//
// 调用方根据返回值与 max 比较决定是否限流。
//
// 注意：本方法始终递增，不论是否已达上限——与原 auth.go 行为一致。
// ratelimit.go 路径需要"达上限后不再递增"语义时，由调用方先 Hit 再判断。
func (r *RateLimiter) Hit(key string) int {
	if key == "" {
		return 0
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	e, ok := r.entries[key]
	if !ok || now.After(e.expireAt) {
		r.entries[key] = &rateLimitEntry{count: 1, expireAt: now.Add(r.window)}
		return 1
	}
	e.count++
	return e.count
}

// ExpireAt 返回 key 当前窗口的剩余时间（秒），用于构造 Retry-After 头
//
// 未命中或已过期时返 0。
func (r *RateLimiter) ExpireAt(key string) time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()

	e, ok := r.entries[key]
	if !ok {
		return time.Time{}
	}
	return e.expireAt
}

// IsLimited 查询 key 是否已处于限流状态（纯查询，不递增计数）
//
// 判定：窗口未过期 && count > max。供"仅失败计数"语义的调用方在请求前置检查——
// 成功请求不计数，避免高频成功流量（如实例代理的机器间调用）误触发限流。
func (r *RateLimiter) IsLimited(key string) bool {
	if key == "" {
		return false
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	e, ok := r.entries[key]
	if !ok {
		return false
	}
	return time.Now().Before(e.expireAt) && e.count > r.max
}

// gcLoop 后台惰性 GC：定期清理已过期条目
//
// 与原 auth.go / ratelimit.go 中的 GC 逻辑等价：每 5 分钟遍历 entries，
// 删除 expireAt 已过的条目。锁内遍历 + 删除避免并发问题。
func (r *RateLimiter) gcLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		r.mu.Lock()
		now := time.Now()
		for k, e := range r.entries {
			if now.After(e.expireAt) {
				delete(r.entries, k)
			}
		}
		r.mu.Unlock()
	}
}
