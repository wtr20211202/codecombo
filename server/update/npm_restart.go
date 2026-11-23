package update

import (
	"os"
	"strconv"
	"strings"
)

// npm wrapper 前台形态的页面重启握手（P-20261122-2）。
//
// npm 安装有双子形态：前台（wrapper 直接子进程，终端附着）与守护（README 快捷
// 路径 `codecombo start`——main.go cmdStart 用 os.Executable 直接 spawn 平台
// 二进制，绕过 wrapper 且 stdio 脱终端；cmd.Env=nil 使 wrapper 下发的环境变量
// 被守护进程继承）。页面重启链按形态分链：
//   - 前台：wrapper（npm/cli/bin/codecombo.js）监听子进程退出码，收到
//     RestartExitCode 即重 resolve 平台二进制并同参数重 spawn（循环监管者）
//     ——重启所有权归 wrapper，Go 侧不自 spawn（防 wrapper 循环之外再起一份
//     孤儿实例抢端口）
//   - 守护：env 在场但父进程已非 wrapper——绝不能发 RestartExitCode（守护
//     形态无人监听退出码，75 退出=当场死亡且无人接手，比修复前更劣），落
//     RestartSelfExe 脱会话自 spawn 兜底
//
// 双守卫（env + ppid）一闸双解：env 缺省（旧 wrapper 未下发 / 非 npm 形态）
// 过渡期兼容；env 在场但 ppid 不符（守护形态继承 / wrapper 已死被收养）防
// 守护误判。os.Getppid 三平台原生语义。

const (
	// EnvWrapperPid wrapper spawn 平台二进制时下发的自身 PID
	// （npm/cli/bin/codecombo.js childEnv 同名键，Go 侧只读）
	EnvWrapperPid = "CODECOMBO_WRAPPER_PID"

	// RestartExitCode npm 前台形态的页面重启扳机退出码：wrapper 收到即重
	// spawn（其余退出码照旧透传）。取 75（EX_TEMPFAIL 惯例值域）——全仓 Go
	// 退出码仅 0/1 与 Windows 服务 uint32 1（SCM 语义），无冲突；与 SCM 非零
	// 退出码触发 failure-recovery 重启同型（退出码即重启扳机的既定模式）
	RestartExitCode = 75
)

// getppidFn 取父进程 PID（测试注入可控值——宿主进程树实况不可注入，
// systemdUnitFn 同款环境依赖探测的测试纪律）
var getppidFn = os.Getppid

// WrapperRestartRequested 页面重启链的 npm 前台形态裁决（app.go RegisterRestart
// 兜底自 spawn 分支前调用）：当前进程是 wrapper 直接子进程且 wrapper 下发了
// 自身 PID 时返回 true——调用方优雅停机后以 RestartExitCode 退出，重启所有权
// 归 wrapper 循环监管者；返回 false 调用方走 RestartSelfExe 脱会话自 spawn
// 兜底（守护 / 旧 wrapper / 裸进程 / 服务形态全落到兜底，混合版本三态由本
// 守卫兜住）
func WrapperRestartRequested() bool {
	raw := strings.TrimSpace(os.Getenv(EnvWrapperPid))
	if raw == "" {
		return false
	}
	pid, err := strconv.Atoi(raw)
	if err != nil || pid <= 0 {
		return false
	}
	return getppidFn() == pid
}
