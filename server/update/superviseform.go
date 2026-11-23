package update

import (
	"fmt"
	"runtime"

	"codecombo/server/servicectx"
)

// 服务形态判定（P-20261122-10 诊断包必改B「服务形态判定」）：
// 把 app.go 重启链分叉用的那套形态判据收成一个只读投影——诊断包里
// 「这台机器上它是怎么跑起来的」决定了读日志的第一站（systemd → journal、
// launchd → KeepAlive 语义、SCM → 事件查看器、bare → update-restart.log）。
//
// 零副作用：只读 env / /proc/self/cgroup / ppid，不触发重启也不改路由。
// 判定顺序与 app.go RegisterRestart 的分支顺序一致（Windows 服务 > npm
// wrapper > systemd > launchd > bare），保证「诊断包写的形态」就是「重启
// 会走的那条链」。
func SuperviseForm() (form, detail string) {
	if servicectx.IsService() {
		return "windows-service", "SCM (sc failure-recovery relaunches on non-zero exit)"
	}
	if WrapperRestartRequested() {
		return "npm-wrapper", fmt.Sprintf("npm wrapper is the parent (ppid=%d, %s set)", getppidFn(), EnvWrapperPid)
	}
	if unit := systemdUnit(); unit != "" {
		// 注：cgroup 末段 .service 只说明「某个 systemd 单元在本进程祖先链上」
		// ——宿主自身就是 systemd 服务（CI runner 等）时同样命中；诊断包如实
		// 给出单元名，由读包人判断是不是 codecombo.service
		return "systemd", unit
	}
	if runtime.GOOS == "darwin" && getppidFn() == 1 {
		// launchd 托管（KeepAlive=true）：优雅退出即被拉起（app.go 同款启发式）
		return "launchd", "ppid=1 (launchd job)"
	}
	return "bare", "foreground / detached process — no external supervisor"
}
