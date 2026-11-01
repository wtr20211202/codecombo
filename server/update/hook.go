package update

import (
	"sync"
	"time"
)

// 自更新重启钩子：ApplyUpdate 拉起 `_do_update` 子进程后，本服务进程必须退出，
// 子进程的 waitForProcess(pid) 才能继续替换二进制。
// 历史缺陷：只拉起子进程不退出 → 等待 30s 必超时 → 更新状态 failed 并回滚。
// 钩子由组合根（server/app）注册为与 /api/shutdown 同一优雅关闭动作——
// update 包不反向依赖 api/system，避免环。

var (
	restartHookMu sync.RWMutex
	restartHookFn func()
)

// SetRestartHook 注册优雅关闭动作（组合根装配期调用一次）
func SetRestartHook(fn func()) {
	restartHookMu.Lock()
	defer restartHookMu.Unlock()
	restartHookFn = fn
}

func restartHook() func() {
	restartHookMu.RLock()
	defer restartHookMu.RUnlock()
	return restartHookFn
}

// RestartViaHook 拉起换包子进程后由调用方触发：略缓于 HTTP 响应写出（确保
// 前端先拿到响应），经组合根注册的钩子优雅关闭本进程——子进程随即检测到
// 旧进程退出并替换二进制。所有自更新入口（ApplyUpdate / ApplyUpdateFromCenter）
// 都必须调用，否则子进程 waitForProcess 30s 必超时（历史缺陷见文件头注释）。
// 钩子未注册（单测/裸装配）时保持原行为
func RestartViaHook() {
	if hook := restartHook(); hook != nil {
		go func() {
			time.Sleep(500 * time.Millisecond)
			hook()
		}()
	}
}
