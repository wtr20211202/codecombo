package update

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// 换包子进程活性握手（P-20261122-5）：LaunchUpdateSubprocess 在 Start() 成功后、
// 调用方置 restarting/触发退出钩子之前，对子进程做一次有界活性确认——
// spawn 前记录 update.log 尺寸，轮询「文件增长且新增字节含
// `update started: <旧版本> -> <目标版本>`」（DoUpdate 首句 initLogger 后落的第一行，
// do_update.go）。判据与通道是评审定案：存在性检查被 openAppendLog 的 O_APPEND
// 跨轮持久化废掉（update.log 可能早已存在，只能做尺寸/内容增量）；结果文件写
// ready 记录被否决（publishUpdateResult 对未知状态返回 true 会吞观察窗的真实结局
// 通知，且跨版本矩阵子进程不认新协议）；pipe EOF 只证死不证活；Signal(0) Windows
// 不可移植。
//
// 背景（用户 mac beta.8→beta.9 在线升级实测）：二进制带 com.apple.quarantine 的
// 实例上 syspolicyd 对后台 spawn 静默 kill——Start() 成功、子进程一行未跑即死、
// 结果文件永无人写，主进程照常退出（launchd KeepAlive 同秒重拉旧版）→ 前端无限
// 「等待新版本就绪」零诊断。握手失败即放弃退出（不触发 RestartViaHook：主进程
// 不退出则监管者不重拉，服务维持安全态；备份 rename 在父进程退出后才发生，盘面
// 零触碰）——两向误判代价均已界定：假阳性（子进程其实活着只是没落日志）由子进程
// 自身 30s waitForProcess 超时自写 failed 收口；假阴性不可能（marker 写入
// happens-before 进程退出，退出后的复查必能读到）。

// subprocessHandshakeDefault 活性窗上界：正常形态下子进程首行日志在毫秒级落盘，
// 10s 只在慢盘/重载环境下兜底；假阳性代价（放弃后子进程自写 failed）远轻于
// 假阴性代价（回到零诊断静默失败）。包级变量供测试压缩（stallTimeout/
// resultWatchWindow 同款原子形态——race 门禁下普通变量会被收尾期的改写踩出竞争）
const subprocessHandshakeDefault = 10 * time.Second

var subprocessHandshakeTimeout = newAtomicDuration(subprocessHandshakeDefault)

// handshakePollInterval 轮询步长：stat+定向读是微秒级 IO，100ms 步长在 10s 窗内
// 至多 100 轮，量级可忽略
const handshakePollInterval = 100 * time.Millisecond

// handshakeReadCap 单轮新增字节读取上限：marker 是子进程落的第一行日志，只可能
// 出现在新增区头部；防异常场景（日志被外部灌大）把轮询读变成无界拷贝
const handshakeReadCap = 64 * 1024

// ErrSubprocessDied 换包子进程秒死判定（spawn 本身成功、活性窗内无 update started）。
// errmarkers 注册表不收录：这是携带平台自救指引的多行诊断原文，走 errMsg 原文
// 承载（P-20261122-5 评审裁定零新增 i18n 键），判型只走 errors.Is
var ErrSubprocessDied = errors.New("update subprocess exited immediately")

// updateLogPath 更新决策日志路径（initLogger 与主进程握手共用同一形态——两边
// 指向同一文件，路径表达分叉会造成探测指向错误文件的隐疾）
func updateLogPath(dataDir string) string {
	return filepath.Join(dataDir, "logs", "update.log")
}

// updateLogSize spawn 前的日志尺寸标记：NotExist（首装首更常态）记 0；其他 stat
// 错误如实上抛——标记不可信时继续 spawn 会让增量轮询从 0 读起、误配上一轮更新
// 的旧 marker（假成功比假失败更糟：假成功会照常退出主进程，回到本案治理的静默
// 失败）
func updateLogSize(dataDir string) (int64, error) {
	info, err := os.Stat(updateLogPath(dataDir))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("probe update log size failed: %w", err)
	}
	return info.Size(), nil
}

// logGrewWithMarker 增量判定：文件在标记尺寸之上增长、且从标记偏移读到的新增
// 字节（封顶 handshakeReadCap）含 marker。文件未创建/未增长/读失败一律返回
// false（未到判死时刻，继续等下一轮——读偶发失败不构成死亡证据）
func logGrewWithMarker(dataDir string, mark int64, marker string) bool {
	path := updateLogPath(dataDir)
	info, err := os.Stat(path)
	if err != nil || info.Size() <= mark {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	n := info.Size() - mark
	if n > handshakeReadCap {
		n = handshakeReadCap
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, mark); err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	return strings.Contains(string(buf), marker)
}

// subprocessDiedError 失败原因（errMsg 原文承载）：outcome 如实区分两形态
// （P-20261122-9）——`exited(<state>) before startup`（ProcessState.String()：
// "exit status 2"/"signal: killed"）vs `alive but silent within 10s`（子进程还
// 活着只是没落日志，慢盘/大目录 EnsureDataDirMigrated 递归 merge 可越过窗）。
// 通用死因 + darwin 条件化自救指引（quarantine 是 #24 实测根因；其余平台
// 通用诱因=AV/权限/磁盘）。runtime.GOOS 分支两分支同文件可编译（全平台纪律），
// 仅文案分叉。哨兵 ErrSubprocessDied 本身不动（manager/update.go 两处 errors.Is
// 消费，判型口径不变；字面量仅作 errMsg 前缀）
func subprocessDiedError(outcome string) error {
	if runtime.GOOS == "darwin" {
		return fmt.Errorf(`%w: %s — on macOS the binary is likely quarantined (com.apple.quarantine xattr, e.g. copied from a browser download): inspect with "xattr -l <binary>", clear with "xattr -d com.apple.quarantine <binary>", or reinstall via the install script`,
			ErrSubprocessDied, outcome)
	}
	return fmt.Errorf(`%w: %s — common causes: antivirus blocking, missing execute permission, or disk full`,
		ErrSubprocessDied, outcome)
}

// exitedBeforeStartupOutcome 子进程已退出的裁决文案：ProcessState.String() 是
// 跨平台的死因原语（exit status N / signal: killed），ExitCode() 另列便于机器
// 判读（信号死亡时 ExitCode()=-1 无意义，省略）；ps 为 nil（Wait 本身出错）
// 时如实标注 unknown 不编造状态
func exitedBeforeStartupOutcome(ps *os.ProcessState) string {
	if ps == nil {
		return `exited (unknown status) before startup, no "update started" marker logged`
	}
	state := ps.String()
	if code := ps.ExitCode(); code >= 0 {
		state = fmt.Sprintf("%s, exitCode=%d", state, code)
	}
	return fmt.Sprintf(`exited (%s) before startup, no "update started" marker logged`, state)
}

// silentOutcome 活性窗满仍无证据的裁决文案：不宣称子进程已死（它可能只是慢）
func silentOutcome() string {
	return fmt.Sprintf(`alive but silent within %s, no "update started" marker logged`, subprocessHandshakeTimeout.Load())
}

// awaitSubprocessLiveness 有界活性窗：轮询日志增量证据；进程退出即刻终审（证据
// 在轮询间隙落盘的竞态由退出后的一次复查兜住——marker 写入 happens-before 退出，
// Process.Wait 返回后盘面即定）；窗满仍无证据按未确认启动判。cmd.Process.Wait
// 由专职 goroutine 执行：既当死亡哨兵，也顺带收割死子进程（本包从不 cmd.Wait，
// 历史上秒死子进程在主进程退出前以僵尸态滞留）；存活子进程绝不被触碰——放弃
// 路径交由其自身 30s waitForProcess 超时自写 failed（假阳性代价的既定设计）。
//
// 返回 outcome（P-20261122-9 必改A）：父进程把「exited(<state>) before startup」
// 或「alive but silent within 10s」连同 PID 落主日志 + update-subprocess.log——
// P-5 判死只能说「没动静」，说不出「怎么死的」，这是补上的死因面
func awaitSubprocessLiveness(cmd *exec.Cmd, dataDir string, mark int64, prevVersion, version string) (string, error) {
	marker := fmt.Sprintf("update started: %s -> %s", prevVersion, version)
	// 容量 1：窗满放弃后 goroutine 仍可能在子进程稍后退出时投递，缓冲保证其
	// 不永久阻塞（无人接收即被 GC 回收）
	exited := make(chan *os.ProcessState, 1)
	go func() {
		ps, _ := cmd.Process.Wait()
		exited <- ps
	}()
	deadline := time.After(subprocessHandshakeTimeout.Load())
	for {
		if logGrewWithMarker(dataDir, mark, marker) {
			return "", nil
		}
		select {
		case ps := <-exited:
			if logGrewWithMarker(dataDir, mark, marker) {
				return "", nil
			}
			outcome := exitedBeforeStartupOutcome(ps)
			return outcome, subprocessDiedError(outcome)
		case <-deadline:
			outcome := silentOutcome()
			return outcome, subprocessDiedError(outcome)
		case <-time.After(handshakePollInterval):
		}
	}
}
