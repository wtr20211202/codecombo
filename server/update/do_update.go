package update

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var updateLogger *log.Logger

// 三文件职责头注（P-20261116-1-S3 双文件版 → P-20261122-9 升三文件；用户实测
// 混淆案例——运维追「更新为什么回滚」时翻的是 update-restart.log，而该文件只是
// bare 重启形态的进程输出，systemd 形态进程输出走 journal、该文件根本不会被
// 创建）：update.log=更新决策时间线（换包/健康等待/回滚证据），
// update-subprocess.log=换包子进程 stdout/stderr + 父进程活性裁决行（P-20261122-9；
// initLogger 之前的 runtime/迁移/panic 输出落这里），update-restart.log=重启进程
// stdout/stderr。三文件头各一行注记防再混；O_APPEND 多轮更新串接，头注仅首次
// 创建时写防刷屏（openAppendLog），故措辞面向「打开此文件的人」，中英混排以
// 英文为主与既有日志行一致
const (
	updateLogHeader = "# update.log — update decision timeline (backup/replace/health-wait/rollback evidence per update run). Swap-subprocess stdout/stderr + parent verdicts live in update-subprocess.log; restarted-process output lives in update-restart.log"
	// updateSubprocessLogHeader 换包子进程诊断面头注（P-20261122-9）：与 update.log
	// 严格分离，runbook #26/#27 的「update.log 不存在 ⇒ 组杀/未进 DoUpdate」
	// 判别式依赖 update.log 保持纯决策时间线
	updateSubprocessLogHeader = "# update-subprocess.log — swap-subprocess stdout/stderr (runtime/migration/panic bytes before initLogger) + parent liveness verdict lines. Update decisions live in update.log; restarted-process output lives in update-restart.log"
	restartLogHeader          = "# update-restart.log — restarted process stdout/stderr (bare/detached form only; systemd form logs to journal and this file is never created). Update decisions live in update.log; swap-subprocess output lives in update-subprocess.log"
)

// openAppendLog 打开 O_APPEND 日志文件，首次创建时写一行职责头注（P-20261116-1-S3）。
// 「仅首次创建」探测=打开前 Stat 不在场即视为新建（并发双建至多重复一行头注，
// 更新链单实例串行无此竞态面）；Stat 出非 NotExist 错误时不写（保守不刷屏），
// 头注写失败忽略（best-effort 诊断面，绝不影响打开结果）
func openAppendLog(path, header string) (*os.File, error) {
	fresh := false
	if _, err := os.Stat(path); os.IsNotExist(err) {
		fresh = true
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, err
	}
	if fresh {
		_, _ = f.WriteString(header + "\n")
	}
	return f, nil
}

// updateContext 更新子进程的上下文，避免函数间传递大量参数
type updateContext struct {
	currentBinary string
	backup        string
	port          int
	dd            string
	version       string
	prevVersion   string
	// spawnedPID 本轮 restartService 拉起的新版本进程 PID（精确回滚击杀用）
	spawnedPID int
}

func initLogger(dd string) {
	_ = os.MkdirAll(filepath.Join(dd, "logs"), 0755)
	f, err := openAppendLog(updateLogPath(dd), updateLogHeader)
	if err != nil {
		updateLogger = log.New(os.Stderr, "[update] ", log.LstdFlags)
		return
	}
	updateLogger = log.New(f, "", log.Ldate|log.Ltime)
}

// 更新子进程内部 env 契约（LaunchUpdateSubprocess 下发）。P-20261025-1 起正名
// CODECOMBO_UPDATE_*；SIMPLE_CODING_UPDATE_* 旧名回落双读一个版本期——跨版本
// 矩阵「旧中心二进制下载新二进制后以 _do_update 拉起它」时，env 由旧代码下发
// 旧名，新代码必须能读到（dd 缺失会退化为按本机默认目录健康检查，TLS 形态下
// 误回滚）
const (
	envUpdateDataDir    = "CODECOMBO_UPDATE_DATA_DIR"
	envUpdateVersion    = "CODECOMBO_UPDATE_VERSION"
	envUpdatePrevVer    = "CODECOMBO_UPDATE_PREV_VERSION"
	envUpdateDataDirOld = "SIMPLE_CODING_UPDATE_DATA_DIR"
	envUpdateVersionOld = "SIMPLE_CODING_UPDATE_VERSION"
	envUpdatePrevVerOld = "SIMPLE_CODING_UPDATE_PREV_VERSION"
	// envUpdateSupervise 主进程下发的监管形态提示（可选字段，P-20261112-1-S1）：
	// 值域见 superviseForm。此前自更新链的 restartService 只认 systemd 自查，
	// Windows 服务/launchd 形态换包后按裸进程 spawn——服务形态打成 SCM 记
	// STOPPED 的孤儿进程、launchd 与 KeepAlive 重拉赛跑抢端口。systemd 不在
	// 值域内：更新子进程经 /proc/self/cgroup 自查且自查优先（restart.go
	// superviseFromEnv），主进程对 systemd 形态下发 bare（中性值，自查覆盖，
	// 不算两源不一致）。无旧名双写：旧主进程在本字段诞生前不存在任何名字的
	// 下发——缺省（env 不存在）即「旧主进程+新 _do_update 二进制」矩阵，回落
	// bare=现状语义不劣化；反向矩阵「新主进程+旧 _do_update 二进制」旧代码
	// 忽略未知 env，亦无影响
	envUpdateSupervise = "CODECOMBO_UPDATE_SUPERVISE"
	// envUpdateArgvN / envUpdateArgvPrefix 主进程原参数 argv 列式契约（可选
	// 字段，P-20261112-1-S2）：N=计数，ARGV_<i> 逐键承载主进程 os.Args[1:]，
	// bare/前台形态 restartService 按原参数原样 spawn（含 --host/--data-dir/
	// --tls-* 等全部旗标——历史只传 --port 静默丢参，且 host 无 env 回写面）。
	// 逐键 env 防分隔符歧义（参数内空白/引号/= 原样承载，不经 shell）；读侧
	// LookupEnv 区分「空串参数」与「缺键」。缺省（旧主进程不下发）回落现状
	// 语义（--serve --port），旧 _do_update 忽略未知 env——跨版本双向矩阵
	// 安全，无旧名双写（同 envUpdateSupervise 缘由）
	envUpdateArgvN      = "CODECOMBO_UPDATE_ARGV_N"
	envUpdateArgvPrefix = "CODECOMBO_UPDATE_ARGV_"
)

// superviseForm 监管形态（env 契约值域 + 自查补充值）。systemd 仅由更新子
// 进程自查产出（restart.go systemdUnit），不是 env 契约值——主进程对 systemd
// 形态发 bare，由子进程自查覆盖
type superviseForm string

const (
	superviseWindowsService superviseForm = "windows-service"
	superviseLaunchd        superviseForm = "launchd"
	superviseBare           superviseForm = "bare"
	superviseSystemd        superviseForm = "systemd"
)

func getenvOr(canonical, legacy string) string {
	if v := os.Getenv(canonical); v != "" {
		return v
	}
	return os.Getenv(legacy)
}

func DoUpdate(currentBinary, newBinary string, port int, pid int) error {
	dd := getenvOr(envUpdateDataDir, envUpdateDataDirOld)
	version := getenvOr(envUpdateVersion, envUpdateVersionOld)
	prevVersion := getenvOr(envUpdatePrevVer, envUpdatePrevVerOld)
	if dd == "" {
		dd = configDataDir()
	}

	initLogger(dd)
	updateLogger.Printf("update started: %s -> %s (pid=%d, port=%d)", prevVersion, version, pid, port)
	// 监管形态裁决留痕（自查优先、缺省回落 bare，语义见 superviseFromEnv）；
	// S2 起 restartService 按此路由（restartService 内部自裁决，此处留痕与
	// 成功结果注记复用同一裁决值）
	form := superviseFromEnv()
	updateLogger.Printf("supervise form: %s", form)

	ctx := &updateContext{
		currentBinary: currentBinary,
		backup:        currentBinary + ".bak",
		port:          port,
		dd:            dd,
		version:       version,
		prevVersion:   prevVersion,
	}

	updateLogger.Printf("waiting for old process %d to exit...", pid)
	if err := waitForProcess(pid, 30*time.Second); err != nil {
		updateLogger.Printf("wait failed: %v", err)
		ctx.saveResult("failed", err.Error())
		return err
	}
	updateLogger.Printf("old process exited")

	updateLogger.Printf("backing up %s -> %s", currentBinary, ctx.backup)
	if err := os.Rename(currentBinary, ctx.backup); err != nil {
		updateLogger.Printf("backup failed: %v", err)
		ctx.saveResult("failed", "backup failed: "+err.Error())
		return err
	}

	updateLogger.Printf("copying new binary %s -> %s", newBinary, currentBinary)
	if err := CopyFile(newBinary, currentBinary); err != nil {
		_ = ctx.rollback("replace failed: " + err.Error())
		return fmt.Errorf("replace failed: %s", err)
	}
	_ = os.Chmod(currentBinary, 0755)

	updateLogger.Printf("starting new version on port %d", port)
	spawned, err := restartService(currentBinary, port, dd)
	ctx.spawnedPID = spawned
	if err != nil {
		_ = ctx.rollback("start new version failed: " + err.Error())
		return fmt.Errorf("start new version failed: %s", err)
	}

	// launchd 正向路径独占动作（P-20261122-6）：restartService 的 launchd 分支
	// 不 spawn，KeepAlive 才是拉起者——但它在换包窗口已经无条件重拉过一次旧盘
	// 上二进制，那个旧实例正占着全部端口常驻。不终结它，新版永不上线（健康
	// 探测的 200 恒来自内存旧版：误判成功或误回滚，两条都到不了新版）。
	// 落点刻意在此而非 restartService：该函数被 rollback/killAndRollback 共用，
	// 回滚时 KeepAlive 拉起的旧实例是期望终态，放进分支会误杀健康旧实例
	if form == superviseLaunchd {
		// 判据两项入参（P-20261122-8）：目标版本 + 换包前版本——「版本 == 目标
		// 才跳过」，中心链（目标恒字面量 "center"）以 prevVersion 否决
		if err := terminateStaleLaunchdInstance(dd, ctx.version, ctx.prevVersion); err != nil {
			// 旧实例仍活=旧版在跑的安全态，按回滚链如实收口（恢复盘面 + 结果文件）
			_ = ctx.rollback("terminate stale launchd instance failed: " + err.Error())
			return fmt.Errorf("terminate stale launchd instance failed: %s", err)
		}
	}

	// 健康等待活性驱动（P-20261116-1-S1，判据详见 waitForHealthy）：恢复时间
	// 是用户环境的函数，不设时间死线；PID 基线播种防起点死旧 PID 误回滚（本
	// 进程 PID=换包前旧 PID 作基线对照），变化 ≥2 判 crash-loop 秒级失败，
	// 稳定存活持续等 /api/health，10 分钟 runaway 兜底原因未定。
	// 地址派生：TLS 默认开启后主端口是 https（自签），明文 GET 必失败——新
	// 进程重写 PID 文件后，第三行的明文回环辅助端口即本机可靠的明文入口
	updateLogger.Printf("health check (liveness-driven wait, runaway guard %v)", healthRunawayGuard)
	if err := ctx.waitForHealthy(pid); err != nil {
		ctx.killAndRollback("health check failed: " + err.Error())
		return err
	}

	updateLogger.Printf("update successful, cleaning up")
	os.Remove(ctx.backup)
	os.RemoveAll(filepath.Dir(newBinary))
	// 盘上二进制名归一（P-20261025-1）：旧名二进制（simple-coding[.exe] 或
	// simple-coding-<os>-<arch>）原位替换成功 + 健康检查通过后，原子换名至
	// codecombo 同名形态。约束三条：
	//   - systemd 托管不换（unit ExecStart 钉着旧路径，换名会让下一次
	//     systemctl restart 落空——那些实例由部署器装新 unit 收口）
	//   - Windows 上新进程正从该文件运行时 rename 会失败（映像句柄锁定），
	//     失败仅记日志保持旧名（原位替换语义不劣化）
	//   - 只认本产品旧名前缀（e2e 的 polish-e2e-9999.exe 等 harness 名不动）
	canonicalizeBinaryName(ctx.currentBinary)
	// bare/前台形态的成功结果注记（P-20261112-1-S2）：spawn 已脱离终端会话，
	// 前台形态 stdout 不再入终端、start 形态原为 /dev/null——stdout/stderr
	// 统一落数据目录日志（restartBare daemonStdout），如实告知去哪看。
	// 仅 bare 形态注记：windows-service/launchd/systemd 由各自监管者接管，
	// stdio 归属未变。走 UpdateResult.Error 通道（成功通知渲染忽略该字段，
	// 版本面板结局块在原因行透出——唯一自由文本通道）
	resultNote := ""
	if form == superviseBare {
		resultNote = "restarted as detached background daemon; stdout/stderr captured to logs/update-restart.log under the data dir"
	}
	ctx.saveResult("success", resultNote)
	return nil
}

// updateLogf 更新链日志（updateLogger 仅在 DoUpdate 的 initLogger 之后非 nil——
// 独立调用方如 canonicalizeBinaryName 单测路径 nil 安全回退 stderr）
func updateLogf(format string, args ...any) {
	if updateLogger != nil {
		updateLogger.Printf(format, args...)
		return
	}
	log.New(os.Stderr, "[update] ", log.LstdFlags).Printf(format, args...)
}

// canonicalizeBinaryName 更新成功后的盘上名归一（best-effort，任何失败静默留旧名）
func canonicalizeBinaryName(currentBinary string) {
	if systemdUnitOurs() != "" {
		updateLogf("systemd-managed: keep on-disk binary name (unit ExecStart pins the path)")
		return
	}
	base := filepath.Base(currentBinary)
	if !strings.HasPrefix(base, "simple-coding") {
		return
	}
	newBase := "codecombo" + strings.TrimPrefix(base, "simple-coding")
	newPath := filepath.Join(filepath.Dir(currentBinary), newBase)
	if err := os.Rename(currentBinary, newPath); err != nil {
		updateLogf("canonical rename %s -> %s failed (kept legacy name): %v", base, newBase, err)
		return
	}
	updateLogf("canonical rename done: %s -> %s", base, newBase)
}

// restoreRenameFn 回滚盘面恢复的 rename 取值口（P-20261116-1-S2）：单测注入
// rename 故障以验证 CopyFile 回退链与响亮失败路径——跨平台无法用纯文件系统
// 手段可靠构造「rename 失败而复制可用」（两者同需目录写权限，Windows 映像
// 句柄锁则连复制一起挡），默认即 os.Rename
var restoreRenameFn = os.Rename

// restoreBackup 回滚的盘面恢复段（旧二进制归位），rollback/killAndRollback
// 共用——回滚 restartService 一律走形态路由（与正向启动同构），本函数只管盘面。
// P-20261116-1-S2 加固（用户实测误回滚把 ExecStart 路径二进制整个弄丢的事故
// 根治面）：
//   - 防丢失窗顺序：坏新包先 rename 到 .stale-tmp（路径换名而非清空，任意
//     时刻 ExecStart 路径都有文件），备份再 rename 归位，最后清 .stale-tmp
//     ——旧实现先 Remove 再 Rename，两步之间路径空窗，且 Rename 失败被
//     `_ =` 吞掉＝「无二进制」盘面无人知晓，重拉即 203/EXEC 且无法自愈
//   - 备份归位 rename 失败不再静默：fallback CopyFile(.bak→当前)+Chmod 0755
//     （CopyFile 不保权限位，显式补执行位）；copy 路径成功后 .bak 有意保留
//     （复制语义弱于 rename——保住最后一份旧包，防复制内容损坏时无处可回；
//     下轮更新的 backup rename 会覆盖旧 .bak，不撞名）
//   - 备份缺席双态：当前文件在场＝上轮已恢复（收尾校验触发的再恢复轮），
//     幂等成功；两者皆缺席＝事故盘面，响亮报错如实透出
//
// 失败返回错误由调用方并入 errMsg 随 saveResult 透出（结果落盘单一出口在
// 调用方，本函数只留痕不写结果文件防覆盖）
func (c *updateContext) restoreBackup() error {
	if _, err := os.Stat(c.backup); err != nil {
		if _, curErr := os.Stat(c.currentBinary); curErr == nil {
			updateLogf("rollback restore: backup %s absent, %s present — already restored, nothing to do", c.backup, c.currentBinary)
			return nil
		}
		err := fmt.Errorf("rollback restore failed: backup %s and ExecStart path %s both absent, no binary to restore", c.backup, c.currentBinary)
		updateLogf("%v", err)
		return err
	}
	// 坏新包挪开（失败不阻断：事故盘面当前文件本就缺席时照样继续归位备份；
	// Windows 映像句柄锁定时本步与归位都会失败，原因经下方统一透出）
	stale := c.currentBinary + ".stale-tmp"
	if err := restoreRenameFn(c.currentBinary, stale); err != nil {
		updateLogf("rollback restore: move swapped binary aside %s -> %s failed (%v) — continuing with backup restore", c.currentBinary, stale, err)
	}
	if err := restoreRenameFn(c.backup, c.currentBinary); err != nil {
		updateLogf("rollback restore: rename %s -> %s failed (%v) — falling back to copy", c.backup, c.currentBinary, err)
		if copyErr := CopyFile(c.backup, c.currentBinary); copyErr != nil {
			err := fmt.Errorf("rollback restore failed: rename %s -> %s (%v) and copy fallback (%v) both errored — ExecStart path may be missing a runnable binary", c.backup, c.currentBinary, err, copyErr)
			updateLogf("%v", err)
			return err
		}
		if err := os.Chmod(c.currentBinary, 0755); err != nil {
			err := fmt.Errorf("rollback restore failed: copied %s -> %s but chmod 0755 errored (%v)", c.backup, c.currentBinary, err)
			updateLogf("%v", err)
			return err
		}
	}
	// 清挪开的坏包（best-effort：Windows 上坏包进程未退净时映像句柄锁定会
	// 失败——残留 .stale-tmp 无害，备份名固定 .bak，后续更新与回滚不撞名）
	if err := os.Remove(stale); err != nil && !os.IsNotExist(err) {
		updateLogf("rollback restore: cleanup %s failed (%v) — leftover is harmless, nothing depends on that name", stale, err)
	}
	return nil
}

// ensureRollbackBinary 回滚收尾校验（P-20261116-1-S2）：restoreBackup 返回后
// 以实盘状态为准收口——ExecStart 路径必须有存在且可执行（0755）的文件，是
// 事故「误回滚后 ExecStart 二进制消失」的最后一道网。缺失时从备份再恢复一轮
// （restoreBackup 幂等：备份已消耗且当前在场按已恢复）；在场即补 0755 归一
// （Windows 上只影响只读位，三平台行为一致）。任何一步不达成都响亮留痕并把
// 原因并回 errMsg，随调用方 saveResult 透出（「回滚盘面恢复失败」必须能在
// 结果文件里读到，不再无声留坑）
func (c *updateContext) ensureRollbackBinary(errMsg string) string {
	if _, err := os.Stat(c.currentBinary); err != nil {
		updateLogf("rollback verify: ExecStart path %s absent (%v) — re-restoring from backup %s", c.currentBinary, err, c.backup)
		if rerr := c.restoreBackup(); rerr != nil {
			return errMsg + "; " + rerr.Error()
		}
	}
	if err := os.Chmod(c.currentBinary, 0755); err != nil {
		msg := fmt.Sprintf("rollback restore failed: ExecStart path %s present but chmod 0755 errored (%v)", c.currentBinary, err)
		updateLogf("%s", msg)
		return errMsg + "; " + msg
	}
	return errMsg
}

func (c *updateContext) rollback(errMsg string) error {
	updateLogger.Printf("rollback: %s", errMsg)
	// 盘面恢复失败并入 errMsg 随结果文件透出（P-20261116-1-S2）：restoreBackup
	// 不再静默，恢复失败时重拉大概率 203/EXEC——结果必须如实携带两层原因
	if err := c.restoreBackup(); err != nil {
		errMsg += "; " + err.Error()
	}
	// 形态路由重启（P-20261112-1-S2）：windows-service 恢复备份后再 sc start、
	// launchd 交 KeepAlive、bare 原参数 spawn——与正向启动同一 restartService。
	// 重拉失败=服务停在「盘面已回旧版但没有进程在跑」，必须留痕（P-20261122-12
	// 审计）：errMsg 仍只承载原始失败原因（结果文件语义与既有测试契约不变），
	// 二次失败落 update.log 供事故追溯
	if _, rerr := restartService(c.currentBinary, c.port, c.dd); rerr != nil {
		updateLogf("rollback: relaunch after restore failed: %v — service is down until next supervisor restart", rerr)
	}
	c.saveResult("rolled_back", errMsg)
	return fmt.Errorf("%s", errMsg)
}

// killAndRollback 健康检查失败回滚：先终止运行中的坏新进程再恢复盘面重拉。
// 运行中进程的 PID 来源按形态分叉——bare 是本子进程 spawn 的 spawnedPID；
// windows-service/launchd 非本子进程拉起（SCM sc start / KeepAlive 重拉），
// spawnedPID 恒 0，唯一 PID 来源是数据目录 PID 文件（新进程启动即重写）
func (c *updateContext) killAndRollback(errMsg string) {
	updateLogger.Printf("kill and rollback: %s", errMsg)
	switch superviseFromEnv() {
	case superviseWindowsService:
		// SCM 优雅停（sc stop）而非硬杀：服务进程退出码非零会触发 SCM
		// failure-recovery（install.ps1 actions=restart/5000）与回滚 sc start
		// 赛跑。停毕（waitForProcess）才能换回旧二进制——Windows 映像句柄锁定
		// 运行中 exe；等不到（服务挂死）也继续，后续失败由结果文件如实记录
		if pid := readRunningPid(c.dd); pid > 0 {
			_ = stopWindowsServiceFn()
			_ = waitForProcess(pid, 12*time.Second)
		}
	case superviseLaunchd:
		// 顺序关键：先恢复旧二进制再杀——launchd 检测到退出即刻重拉，杀完
		// 再恢复会让重拉捡到坏新包；恢复后杀则重拉必捡旧包。杀完不再
		// restartService（KeepAlive 是该形态唯一拉起者，重复 spawn 会赛跑抢端口）
		if err := c.restoreBackup(); err != nil {
			errMsg += "; " + err.Error()
		}
		// 收尾校验夹在恢复与击杀之间（校验耗时 stat+chmod 微秒级）：KeepAlive
		// 重拉捡到的必是校验过的旧包
		errMsg = c.ensureRollbackBinary(errMsg)
		if pid := readRunningPid(c.dd); pid > 0 {
			// 击杀失败=坏新进程仍占端口，而结果文件只会写 rolled_back 本因
			// （P-20261122-12 审计）：二次失败必须进 update.log 才能区分
			// 「回滚成功」与「盘面已回旧版但坏进程还在跑」
			if kerr := killByPIDFn(pid); kerr != nil {
				updateLogf("rollback: kill stale new-version process %d failed: %v — it may still hold the port", pid, kerr)
			}
		}
		c.saveResult("rolled_back", errMsg)
		return
	default:
		// bare/systemd：bare 击杀本子进程 spawn 的坏新进程（systemd 时恒 0
		// no-op），交由下方 restoreBackup + 形态路由收尾；击杀失败留痕同
		// launchd 分支（P-20261122-12）
		if kerr := killByPIDFn(c.spawnedPID); kerr != nil {
			updateLogf("rollback: kill spawned new-version process %d failed: %v", c.spawnedPID, kerr)
		}
	}
	if err := c.restoreBackup(); err != nil {
		errMsg += "; " + err.Error()
	}
	// 收尾校验在重拉之前：restartService 拉起的必是实盘校验过的旧包
	// （P-20261116-1-S2——事故链里重拉 203/EXEC 的直接根治点之一）
	errMsg = c.ensureRollbackBinary(errMsg)
	spawned, err := restartService(c.currentBinary, c.port, c.dd)
	if err == nil {
		c.spawnedPID = spawned
	} else {
		// 同 rollback：回滚后重拉失败=服务无进程，留痕（P-20261122-12）
		updateLogf("rollback: relaunch after restore failed: %v — service is down until next supervisor restart", err)
	}
	c.saveResult("rolled_back", errMsg)
}

// logExecStartSnapshot 失败结案快照（P-20261116-1-S3）：把 ExecStart 路径实盘
// 状态（存在/权限/大小）落一行 update.log——事故后一眼可诊（beta.7→beta.8
// 事故若有此行，当时即知 ENOENT，不必进 shell stat）。与 S2 收尾校验衔接：
// 各结案点（rollback/killAndRollback→saveResult）都在 restoreBackup/
// ensureRollbackBinary 之后，快照天然反映恢复后的盘面终态
func (c *updateContext) logExecStartSnapshot() {
	info, err := os.Stat(c.currentBinary)
	if err != nil {
		updateLogf("case closed: ExecStart path %s ABSENT (%v)", c.currentBinary, err)
		return
	}
	updateLogf("case closed: ExecStart path %s present, mode=%s size=%d bytes", c.currentBinary, info.Mode().Perm(), info.Size())
}

func (c *updateContext) saveResult(status, errMsg string) {
	// 失败结案先落盘面快照再写结果文件（P-20261116-1-S3）：成功结案无盘面
	// 疑点，不落（防每次更新噪声行）
	if status != "success" {
		c.logExecStartSnapshot()
	}
	// 结果文件是整条更新观察链的唯一事实源（主进程/前端只读它判定结局），
	// 写失败必须留痕（P-20261122-12）：否则用户只能看到「更新无结局」而
	// update.log 里没有任何解释——与结果文件丢失同形态的静默失败
	if err := SaveUpdateResult(c.dd, &UpdateResult{Status: status, Version: c.version, PreviousVersion: c.prevVersion, Error: errMsg}); err != nil {
		updateLogf("write update result failed (status=%s): %v — update outcome will not be observable via update-result.json", status, err)
	}
}
