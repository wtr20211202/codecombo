package update

// P-20261122-6 定向验证：launchd 形态在线更新换包后旧实例终结（restartService
// 正向路径空操作的补位）与「健康 200 + PID 文件版本行」证据性成功判据。
// P-20261122-8 回归补强：终结判据从「版本行非空即跳过」改为「版本 == 目标才
// 跳过」（中心链以 prevVersion 否决）+ 无活实例有界等待。
//
// 覆盖矩阵：
//  1. terminateStaleLaunchdInstance 单元面——PID 取自 PID 文件 / 无活实例有界
//     等待后报错（替代原「PID≤0 幂等零操作」）/ 空残缺 PID 文件等待中出现活
//     实例即重试 / SIGTERM 后优雅退出 / 残活 SIGKILL 兜底 / 两次等待仍活（含
//     kill 报错）如实报错 / 版本 == 目标跳过（缺陷钉子：版本 ≠ 目标必杀）/
//     中心链 prevVersion 否决与「≠ 换包前版本」跳过
//  2. DoUpdate 正向路径——launchd 必调 terminate 且先于健康等待 / 旧版本行实例
//     必被终结（P-20261122-8 全链回归：旧判据在此静默跳过→10 分钟 runaway）/
//     终结失败走回滚如实失败 / replace 失败的回滚路径不杀健康旧实例（评审落点
//     修订的负断言）/ 非 launchd 形态零 terminate / 健康 200 但无版本证据不判
//     成功（旧实例常驻形态端到端回滚）
//  3. waitForHealthy 版本门控——版本相符放行 / 不符与缺行继续等（runaway 兜底）
//     / 中心链 "center" 目标不可知时版本行在场放行（但 == 换包前版本即否决）
//
// 全部经取值口注入（restart_route_test.go stubRestartSeams 同款纪律）：绝不
// 真实向进程投信号、绝不真实 spawn 换包进程、不碰真实 SCM 与 systemctl；健康
// 端点为本测试内 httptest 桩，PID 文件落 t.TempDir() 且 CC_DATA_DIR 钉空目录
// 隔离宿主实况。本包测试无 t.Parallel，包级插桩安全

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// 终结判据的固定入参（自更新链形态：目标=env 版本、换包前=env prev 版本）
const (
	testTargetVersion = "0.0.2-new"
	testPrevVersion   = "0.0.1-old"
)

// pidRead 一次 (pid, 版本行) 同源读取的注入结果（有界等待用例按序喂入）
type pidRead struct {
	pid     int
	version string
}

// terminateProbe 终结链外呼口实况（signalTermFn / terminateWaitFn / killByPIDFn
// / readRunningPidVersionFn）
type terminateProbe struct {
	signalled []int
	killed    []int
	waits     []time.Duration
	// waitErrs 依序消费：第 i 次等待返回该错误（耗尽后恒 nil=进程已退）
	waitErrs  []error
	signalErr error
	killErr   error
	onSignal  func(pid int)
	// pidReads 依序消费的 PID 文件读取结果（耗尽后走真实 readRunningPidVersion
	// ——DoUpdate 全链用例依赖真实落盘文件）；pidReadN 记录读取次数
	pidReads []pidRead
	pidReadN int
}

// stubTerminateSeams 接管终结链全部外呼口并记录调用，测试结束还原
func stubTerminateSeams(t *testing.T) *terminateProbe {
	t.Helper()
	p := &terminateProbe{}
	origSignal, origWait, origKill := signalTermFn, terminateWaitFn, killByPIDFn
	origRead := readRunningPidVersionFn
	t.Cleanup(func() {
		signalTermFn, terminateWaitFn, killByPIDFn = origSignal, origWait, origKill
		readRunningPidVersionFn = origRead
	})
	signalTermFn = func(pid int) error {
		p.signalled = append(p.signalled, pid)
		if p.onSignal != nil {
			p.onSignal(pid)
		}
		return p.signalErr
	}
	terminateWaitFn = func(pid int, timeout time.Duration) error {
		p.waits = append(p.waits, timeout)
		if len(p.waitErrs) > 0 {
			err := p.waitErrs[0]
			p.waitErrs = p.waitErrs[1:]
			return err
		}
		return nil
	}
	killByPIDFn = func(pid int) error {
		p.killed = append(p.killed, pid)
		return p.killErr
	}
	readRunningPidVersionFn = func(dd string) (int, string) {
		p.pidReadN++
		if len(p.pidReads) > 0 {
			r := p.pidReads[0]
			p.pidReads = p.pidReads[1:]
			return r.pid, r.version
		}
		return origRead(dd)
	}
	return p
}

// shrinkTerminateWait 压缩有界等待（包级变量插桩，shrinkHealthTiming 同款）；
// 等待超时用例传 0/0 即单次读取后立刻判超时，不真睡
func shrinkTerminateWait(t *testing.T, wait, step time.Duration) {
	t.Helper()
	origWait, origStep := terminatePIDWait, terminatePIDStep
	terminatePIDWait, terminatePIDStep = wait, step
	t.Cleanup(func() { terminatePIDWait, terminatePIDStep = origWait, origStep })
}

// isolateTerminateDataDir 数据目录钉空目录（readRunningPid 第三候选回落
// config.DataDir()，restart_route_test.go 同款护栏），返回 dd
func isolateTerminateDataDir(t *testing.T) string {
	t.Helper()
	t.Setenv("SC_DATA_DIR", "")
	t.Setenv("CC_DATA_DIR", t.TempDir())
	return t.TempDir()
}

// writePidFileLines PID 文件原样落盘（行形态由用例自定：旧实例无版本行 /
// 新实例五行形态）
func writePidFileLines(t *testing.T, dd, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dd, "codecombo.pid"), []byte(content), 0644); err != nil {
		t.Fatalf("write pid file: %v", err)
	}
}

// TestTerminateStaleLaunchdInstanceTargetsPidFromFile 正向单元面：PID 取自
// PID 文件首行、SIGTERM 后优雅退出即收工（零 SIGKILL）；无版本行 = beta.10
// 之前的实例，立即终结（不等待）
func TestTerminateStaleLaunchdInstanceTargetsPidFromFile(t *testing.T) {
	p := stubTerminateSeams(t)
	buf := stubUpdateLogger(t)
	dd := isolateTerminateDataDir(t)
	self := os.Getpid()                                              // 活 PID 才进信号路径（终结入口先做存活判定；桩接信号不真投递）
	writePidFileLines(t, dd, strconv.Itoa(self)+"\n9999\n0\nhttp\n") // 旧实例形态：无版本行

	if err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.signalled) != 1 || p.signalled[0] != self {
		t.Fatalf("signalled = %v, want [%d] (pid from pid file)", p.signalled, self)
	}
	if len(p.killed) != 0 {
		t.Fatalf("killed = %v, graceful exit must not escalate to SIGKILL", p.killed)
	}
	if len(p.waits) != 1 || p.waits[0] != terminateGrace {
		t.Fatalf("waits = %v, want one wait of terminateGrace", p.waits)
	}
	if !strings.Contains(buf.String(), "no version line (pre-version-line instance)") {
		t.Fatalf("kill cause must be the pre-version-line instance, log:\n%s", buf.String())
	}
}

// TestTerminateStaleLaunchdInstanceErrorsWhenNoLiveInstance 无活实例不是成功态
// （P-20261122-8 评审阻断级补充）：PID 文件缺失/不可解析/死 PID → 有界等待 →
// 仍无活实例 → 报错走回滚（旧实现的「幂等零操作」把「还没写盘」当「无需终结」）
func TestTerminateStaleLaunchdInstanceErrorsWhenNoLiveInstance(t *testing.T) {
	p := stubTerminateSeams(t)
	stubUpdateLogger(t)
	shrinkTerminateWait(t, 0, 0) // 单次读取后立刻判超时，不真睡
	dd := isolateTerminateDataDir(t)

	// 缺失 → 等待 → 报错
	err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion)
	if err == nil || !strings.Contains(err.Error(), "no live instance appeared") {
		t.Fatalf("missing pid file must fail honestly, got %v", err)
	}
	// 不可解析 → 同上
	writePidFileLines(t, dd, "not-a-pid\n9999\n")
	if err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion); err == nil {
		t.Fatal("unparsable pid must fail honestly")
	}
	// 文件的 PID 指向已死进程（陈旧文件）→ 同上（旧实现是幂等 no-op）
	writePidFileLines(t, dd, pidFileContent(deadPid, 9999, ""))
	if err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion); err == nil {
		t.Fatal("dead pid must fail honestly (no live instance appeared)")
	}
	if len(p.signalled) != 0 || len(p.killed) != 0 || len(p.waits) != 0 {
		t.Fatalf("give-up path made external calls: signal=%v kill=%v waits=%v", p.signalled, p.killed, p.waits)
	}
}

// TestTerminateStaleLaunchdInstanceWaitsForRelaunch 空/残缺 PID 文件 + 等待中
// 活实例出现 → 重试读取并按版本判据处置（P-20261122-8「孩子先返回、旧实例
// 后写盘」常见序）。注入序列：空 → 空 → 活实例（旧版本号）
func TestTerminateStaleLaunchdInstanceWaitsForRelaunch(t *testing.T) {
	p := stubTerminateSeams(t)
	stubUpdateLogger(t)
	shrinkTerminateWait(t, time.Second, time.Millisecond) // 步进 1ms：真睡也不拖慢
	dd := isolateTerminateDataDir(t)
	self := os.Getpid()
	p.pidReads = []pidRead{{}, {}, {pid: self, version: testPrevVersion}}

	if err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.pidReadN != 3 {
		t.Fatalf("pid file reads = %d, want 3 (two empty then live)", p.pidReadN)
	}
	if len(p.signalled) != 1 || p.signalled[0] != self {
		t.Fatalf("signalled = %v, want [%d] after the relaunch appeared", p.signalled, self)
	}
}

// TestTerminateStaleLaunchdInstanceEscalatesToKill SIGTERM 宽限期后残活 →
// SIGKILL 兜底（复用回滚链同一精确击杀口），杀后等到退出即成功
func TestTerminateStaleLaunchdInstanceEscalatesToKill(t *testing.T) {
	p := stubTerminateSeams(t)
	stubUpdateLogger(t)
	dd := isolateTerminateDataDir(t)
	self := os.Getpid() // 活 PID 才进信号路径（终结入口先做存活判定）
	writePidFileLines(t, dd, strconv.Itoa(self)+"\n9999\n")
	p.waitErrs = []error{fmt.Errorf("timeout waiting for process %d", self)} // 第二次等待默认 nil

	if err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.killed) != 1 || p.killed[0] != self {
		t.Fatalf("killed = %v, want [%d]", p.killed, self)
	}
	if len(p.waits) != 2 || p.waits[0] != terminateGrace || p.waits[1] != terminateKillGrace {
		t.Fatalf("waits = %v, want grace then kill grace", p.waits)
	}
}

// TestTerminateStaleLaunchdInstanceFailsWhenPidSurvives SIGTERM+SIGKILL 后仍活
// → 如实报错（调用方据此走回滚；kill 本身报错只留痕不吞失败）
func TestTerminateStaleLaunchdInstanceFailsWhenPidSurvives(t *testing.T) {
	p := stubTerminateSeams(t)
	stubUpdateLogger(t)
	dd := isolateTerminateDataDir(t)
	self := os.Getpid()
	writePidFileLines(t, dd, strconv.Itoa(self)+"\n9999\n")
	p.waitErrs = []error{fmt.Errorf("timeout"), fmt.Errorf("timeout")}
	p.killErr = errors.New("operation not permitted")

	err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion)
	if err == nil {
		t.Fatal("surviving stale instance must surface an error")
	}
	if !strings.Contains(err.Error(), "still running") || !strings.Contains(err.Error(), strconv.Itoa(self)) {
		t.Fatalf("err = %v, want surviving-pid cause", err)
	}
	if len(p.killed) != 1 {
		t.Fatalf("killed = %v, want one SIGKILL attempt", p.killed)
	}
}

// TestTerminateStaleLaunchdInstanceSkipsOnlyOnTargetMatch 判据正向半：活实例的
// 版本行逐字等于目标 = KeepAlive 恰好拉起的是新二进制 → 跳过击杀（零信号）。
// PID 必须是活进程：无活实例一律走有界等待/诚实失败，不存在「跳过」
// （死 PID + 版本行=目标 也不是成功态——没人可服务）
func TestTerminateStaleLaunchdInstanceSkipsOnlyOnTargetMatch(t *testing.T) {
	p := stubTerminateSeams(t)
	buf := stubUpdateLogger(t)
	dd := isolateTerminateDataDir(t)
	writePidFileLines(t, dd, pidFileContent(os.Getpid(), 9999, testTargetVersion))

	if err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.signalled) != 0 || len(p.killed) != 0 || len(p.waits) != 0 {
		t.Fatalf("swapped instance must not be terminated: signal=%v kill=%v waits=%v", p.signalled, p.killed, p.waits)
	}
	if !strings.Contains(buf.String(), "already runs the swapped binary") {
		t.Fatalf("skip cause must be stated truthfully, log:\n%s", buf.String())
	}
}

// TestTerminateStaleLaunchdInstanceKillsMismatchedVersion **缺陷钉子**
// （P-20261122-8）：版本行非空但 ≠ 目标 = KeepAlive 重拉的旧实例自己写的旧版本
// 号（任何含 P-6 修复的构建启动即写行）。旧实现「非空即跳过」在此静默跳过 →
// 旧实例常驻 → 健康门控必不认 → 10 分钟 runaway → 每次在线更新必回滚。
// 本用例在旧实现下必挂（信号列表为空）
func TestTerminateStaleLaunchdInstanceKillsMismatchedVersion(t *testing.T) {
	p := stubTerminateSeams(t)
	buf := stubUpdateLogger(t)
	dd := isolateTerminateDataDir(t)
	self := os.Getpid()
	// 换包前版本 = beta.10 形态：旧实例自己写的版本行恰好等于 prevVersion
	writePidFileLines(t, dd, pidFileContent(self, 9999, testPrevVersion))

	if err := terminateStaleLaunchdInstance(dd, testTargetVersion, testPrevVersion); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.signalled) != 1 || p.signalled[0] != self {
		t.Fatalf("signalled = %v, want [%d] (version line %q != target must be terminated)",
			p.signalled, self, testPrevVersion)
	}
	if !strings.Contains(buf.String(), "!= target") {
		t.Fatalf("kill cause must name the version mismatch, log:\n%s", buf.String())
	}
}

// TestTerminateStaleLaunchdInstanceCenterChain 中心链（目标恒字面量 "center"）：
// prevVersion 否决——版本 == 换包前版本 = 旧实例必杀；版本 ≠ 换包前版本 =
// 已换装跳过（仍非「一律 kill」，省一次多余重启）
func TestTerminateStaleLaunchdInstanceCenterChain(t *testing.T) {
	t.Run("vetoes pre-update version", func(t *testing.T) {
		p := stubTerminateSeams(t)
		buf := stubUpdateLogger(t)
		dd := isolateTerminateDataDir(t)
		self := os.Getpid()
		writePidFileLines(t, dd, pidFileContent(self, 9999, testPrevVersion))

		if err := terminateStaleLaunchdInstance(dd, "center", testPrevVersion); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(p.signalled) != 1 || p.signalled[0] != self {
			t.Fatalf("signalled = %v, want [%d] (got == prevVersion must be terminated)", p.signalled, self)
		}
		if !strings.Contains(buf.String(), "still runs the pre-update version") {
			t.Fatalf("kill cause must name the prevVersion veto, log:\n%s", buf.String())
		}
	})
	t.Run("skips other version", func(t *testing.T) {
		p := stubTerminateSeams(t)
		stubUpdateLogger(t)
		dd := isolateTerminateDataDir(t)
		writePidFileLines(t, dd, pidFileContent(os.Getpid(), 9999, testTargetVersion))

		if err := terminateStaleLaunchdInstance(dd, "center", testPrevVersion); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(p.signalled) != 0 || len(p.killed) != 0 || len(p.waits) != 0 {
			t.Fatalf("center chain must skip a version differing from prevVersion: signal=%v kill=%v waits=%v",
				p.signalled, p.killed, p.waits)
		}
	})
	t.Run("dev chain cannot compare", func(t *testing.T) {
		// 目标与换包前版本都不可知（dev）：只剩「有行」这一层，kill 是安全方向
		p := stubTerminateSeams(t)
		buf := stubUpdateLogger(t)
		dd := isolateTerminateDataDir(t)
		self := os.Getpid()
		writePidFileLines(t, dd, pidFileContent(self, 9999, "dev"))

		if err := terminateStaleLaunchdInstance(dd, "dev", "dev"); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(p.signalled) != 1 || p.signalled[0] != self {
			t.Fatalf("signalled = %v, want [%d] (unverifiable version must be terminated)", p.signalled, self)
		}
		if !strings.Contains(buf.String(), "unverifiable") {
			t.Fatalf("kill cause must state unverifiability, log:\n%s", buf.String())
		}
	})
}

// TestClassifyPIDVersion 判据纯函数矩阵（terminate 与健康门控共用同一口径）
func TestClassifyPIDVersion(t *testing.T) {
	cases := []struct {
		name    string
		got     string
		target  string
		prev    string
		want    pidVersionClass
		wantStr string
	}{
		{"no line", "", testTargetVersion, testPrevVersion, pidVersionAbsent, "absent"},
		{"target match", testTargetVersion, testTargetVersion, testPrevVersion, pidVersionNew, "new"},
		{"target mismatch (relaunched old)", testPrevVersion, testTargetVersion, testPrevVersion, pidVersionPrev, "prev"},
		{"target mismatch (other build)", "0.0.3-x", testTargetVersion, testPrevVersion, pidVersionPrev, "prev"},
		{"center vetoes prev", testPrevVersion, "center", testPrevVersion, pidVersionPrev, "prev"},
		{"center accepts other", testTargetVersion, "center", testPrevVersion, pidVersionNew, "new"},
		{"dev both unknowable", "dev", "dev", "dev", pidVersionLineOnly, "line-only"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyPIDVersion(tc.got, tc.target, tc.prev)
			if got != tc.want {
				t.Fatalf("classifyPIDVersion(%q, %q, %q) = %d, want %s", tc.got, tc.target, tc.prev, got, tc.wantStr)
			}
		})
	}
}

// TestReadPIDVersion PID 文件第五行读取：五行命中 / 缺行与坏值回落空串
func TestReadPIDVersion(t *testing.T) {
	dd := isolateTerminateDataDir(t)
	if got := readPIDVersion(dd); got != "" {
		t.Fatalf("missing pid file: got %q, want empty", got)
	}
	writePidFileLines(t, dd, "4321\n9999\n0\nhttp\n0.0.2-new")
	if got := readPIDVersion(dd); got != "0.0.2-new" {
		t.Fatalf("version line = %q, want 0.0.2-new", got)
	}
	writePidFileLines(t, dd, "4321\n9999\n0\nhttp")
	if got := readPIDVersion(dd); got != "" {
		t.Fatalf("four-line file: got %q, want empty (pre-version-line instance)", got)
	}
}

// TestReadRunningPidVersion 同源读取 (pid, 版本行)：五行命中 / 缺行返回 pid+""
// （不跨文件续找）/ 空与残缺首行按「尚未写出」返回 0（osa.WriteFile 非原子窗口）
func TestReadRunningPidVersion(t *testing.T) {
	dd := isolateTerminateDataDir(t)
	if pid, ver := readRunningPidVersion(dd); pid != 0 || ver != "" {
		t.Fatalf("missing pid file: got (%d, %q), want (0, \"\")", pid, ver)
	}
	writePidFileLines(t, dd, "4321\n9999\n0\nhttp\n0.0.2-new")
	if pid, ver := readRunningPidVersion(dd); pid != 4321 || ver != "0.0.2-new" {
		t.Fatalf("five-line file: got (%d, %q), want (4321, 0.0.2-new)", pid, ver)
	}
	writePidFileLines(t, dd, "4321\n9999\n0\nhttp")
	if pid, ver := readRunningPidVersion(dd); pid != 4321 || ver != "" {
		t.Fatalf("four-line file: got (%d, %q), want (4321, \"\")", pid, ver)
	}
	// 空文件（O_TRUNC 后、write 前的窗口）与残缺首行（截断自 "12345"）都不能
	// 冒充活 PID——后者若可解析会指向无关进程，误杀面不可接受
	for _, content := range []string{"", "12", "\n9999\n"} {
		writePidFileLines(t, dd, content)
		if pid, _ := readRunningPidVersion(dd); pid != 0 {
			t.Fatalf("partial content %q: got pid %d, want 0 (must wait for the next poll)", content, pid)
		}
	}
	// 首行为非数字但换行完整：坏文件，回落 0（readPidFile 家族同口径）
	writePidFileLines(t, dd, "not-a-pid\n9999\n")
	if pid, _ := readRunningPidVersion(dd); pid != 0 {
		t.Fatalf("bad pid line: got %d, want 0", pid)
	}
}

// ------------- DoUpdate 全链夹具（正向路径 / 回滚路径两形态复用） -------------

// doUpdateHarness DoUpdate 全链夹具：dd 与二进制均为临时目录实文件，健康端点
// 为测试内 httptest 桩（newHealthStub），换包/重启外呼口由 stubRestartSeams +
// stubTerminateSeams 接管
type doUpdateHarness struct {
	dd      string
	current string
	newBin  string
	port    int
	healthy *atomic.Bool
	route   *routeProbe
	termin  *terminateProbe
}

func newDoUpdateHarness(t *testing.T, form superviseForm, withNewBinary bool) *doUpdateHarness {
	t.Helper()
	// 数据目录隔离：DoUpdate 的 dd 取 env 契约；readRunningPid 第三候选回落
	// config.DataDir()，一并钉空目录
	t.Setenv("SC_DATA_DIR", "")
	t.Setenv("CC_DATA_DIR", t.TempDir())
	h := &doUpdateHarness{dd: t.TempDir()}
	t.Setenv(envUpdateDataDir, h.dd)
	t.Setenv(envUpdateVersion, "0.0.2-new")
	t.Setenv(envUpdatePrevVer, "0.0.1-old")
	t.Setenv(envUpdateSupervise, string(form))

	h.route = stubRestartSeams(t)
	h.termin = stubTerminateSeams(t)

	// DoUpdate 会 initLogger 覆盖包级 updateLogger（指向 dd/logs 实文件）——
	// stubUpdateLogger 的 cleanup 按本行调用时的取值（宿主原值）还原，使
	// DoUpdate 期间的日志落内存缓冲、跨用例不写临时目录亦不漏句柄。
	// 文件句柄单独在 cleanup 里关闭（LIFO：先于上面的还原执行，此时
	// updateLogger 仍是 initLogger 的文件 logger；Windows 上未关的句柄会让
	// t.TempDir 清理报 "being used by another process"）
	stubUpdateLogger(t)
	t.Cleanup(func() {
		if updateLogger == nil {
			return
		}
		if f, ok := updateLogger.Writer().(*os.File); ok {
			_ = f.Close()
		}
	})

	h.current = filepath.Join(h.dd, "bin", "codecombo")
	if err := os.MkdirAll(filepath.Dir(h.current), 0755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	if err := os.WriteFile(h.current, []byte("OLD-BINARY"), 0755); err != nil {
		t.Fatalf("write current binary: %v", err)
	}
	// 新二进制落独立目录：成功路径会 RemoveAll(filepath.Dir(newBinary))
	h.newBin = filepath.Join(h.dd, "tmp", "new", "codecombo")
	if withNewBinary {
		if err := os.MkdirAll(filepath.Dir(h.newBin), 0755); err != nil {
			t.Fatalf("mkdir new: %v", err)
		}
		if err := os.WriteFile(h.newBin, []byte("NEW-BINARY"), 0755); err != nil {
			t.Fatalf("write new binary: %v", err)
		}
	}

	port, healthy := newHealthStub(t)
	h.port = port
	h.healthy = healthy
	h.healthy.Store(true)
	return h
}

// pidFileContent 构造 PID 文件内容（version 为空时只写前四行 = 旧实例形态）
func pidFileContent(pid, port int, version string) string {
	content := fmt.Sprintf("%d\n%d\n0\nhttp", pid, port)
	if version != "" {
		content += "\n" + version
	}
	return content
}

// resultStatus 读更新结果文件（DoUpdate 结案落盘唯一出口）：返回状态与
// 失败原因（盘面断言各用例直接读二进制，不在此重复）
func resultStatus(t *testing.T, dd string) (string, string) {
	t.Helper()
	r, err := LoadUpdateResult(dd)
	if err != nil {
		t.Fatalf("load update result: %v", err)
	}
	if r == nil {
		t.Fatal("update result file missing")
	}
	return r.Status, r.Error
}

// TestDoUpdateLaunchdTerminatesStaleInstanceBeforeHealthWait 正向路径核心
// 断言（缺陷回归钉子）：launchd 形态 restartService 成功后必须终结 PID 文件
// 指的旧实例、且先于健康等待；旧实例退出后 KeepAlive 拉起的新实例写入版本行
// → 健康 200 + 版本证据 → 成功结案
func TestDoUpdateLaunchdTerminatesStaleInstanceBeforeHealthWait(t *testing.T) {
	h := newDoUpdateHarness(t, superviseLaunchd, true)
	// 旧实例 PID 用本进程（活）——终结入口先做存活判定，信号桩不真投递；
	// DoUpdate 的等旧进程退出参数仍用死 PID（快速返回）
	oldPID, newPID := os.Getpid(), deadPid+1
	writePidFileLines(t, h.dd, pidFileContent(oldPID, h.port, ""))
	// SIGTERM 后真实时序：旧实例优雅退出（删 PID 文件）→ KeepAlive 拉起新
	// 二进制 → 新实例重写 PID 文件（含第五行版本）
	h.termin.onSignal = func(int) {
		writePidFileLines(t, h.dd, pidFileContent(newPID, h.port, "0.0.2-new"))
	}

	if err := DoUpdate(h.current, h.newBin, h.port, deadPid); err != nil {
		t.Fatalf("DoUpdate = %v, want nil", err)
	}
	if len(h.termin.signalled) != 1 || h.termin.signalled[0] != oldPID {
		t.Fatalf("signalled = %v, want stale pid %d from pid file", h.termin.signalled, oldPID)
	}
	if len(h.termin.killed) != 0 {
		t.Fatalf("killed = %v, graceful exit must not escalate", h.termin.killed)
	}
	if h.route.spawnCalls != 0 {
		t.Fatalf("launchd forward path must not spawn (KeepAlive owns relaunch), spawn=%d", h.route.spawnCalls)
	}
	if content, _ := os.ReadFile(h.current); string(content) != "NEW-BINARY" {
		t.Fatalf("swapped binary = %q, want NEW-BINARY", content)
	}
	if status, _ := resultStatus(t, h.dd); status != "success" {
		t.Fatalf("result status = %q, want success", status)
	}
}

// TestDoUpdateLaunchdTerminatesOldVersionLineInstance P-20261122-8 全链回归：
// 换包当时运行中的旧实例是含 P-6 修复的构建（beta.10 形态）——它启动时自己写
// 第五行**旧版本号**（== prevVersion）。旧判据「版本行非空即跳过」在此跳过击杀
// → 旧实例常驻 → 版本门控读到旧版本 ≠ 目标 → 10 分钟 runaway → 每次在线更新
// 必回滚（beta.10→beta.11 起全灭形态）。本用例断言 terminate 确实杀掉它、
// KeepAlive 重拉的新实例（写目标版本行）带来成功结案；旧实现下 terminate 零
// 信号、健康等待以 runaway 收场，本用例必挂
func TestDoUpdateLaunchdTerminatesOldVersionLineInstance(t *testing.T) {
	h := newDoUpdateHarness(t, superviseLaunchd, true)
	oldPID, newPID := os.Getpid(), deadPid+1
	writePidFileLines(t, h.dd, pidFileContent(oldPID, h.port, testPrevVersion))
	h.termin.onSignal = func(int) {
		writePidFileLines(t, h.dd, pidFileContent(newPID, h.port, testTargetVersion))
	}

	if err := DoUpdate(h.current, h.newBin, h.port, deadPid); err != nil {
		t.Fatalf("DoUpdate = %v, want nil", err)
	}
	if len(h.termin.signalled) != 1 || h.termin.signalled[0] != oldPID {
		t.Fatalf("signalled = %v, want the pre-swap instance pid %d (old criterion skipped it)", h.termin.signalled, oldPID)
	}
	if status, detail := resultStatus(t, h.dd); status != "success" {
		t.Fatalf("result status = %q (%s), want success", status, detail)
	}
}

// TestDoUpdateLaunchdTerminateFailureRollsBack 终结失败 → 正向路径按回滚链
// 如实收口（盘面恢复旧包 + rolled_back 结果 + 错误上抛），绝不静默成功。
// 失败形态取「SIGTERM 宽限后残活 + SIGKILL 报错且仍等不到退出」——kill 调用
// 本身报错只留痕，进程确实仍活才判失败（ESRCH 类「已退出」错误不该硬失败）
func TestDoUpdateLaunchdTerminateFailureRollsBack(t *testing.T) {
	h := newDoUpdateHarness(t, superviseLaunchd, true)
	writePidFileLines(t, h.dd, pidFileContent(os.Getpid(), h.port, ""))
	h.termin.waitErrs = []error{errors.New("timeout"), errors.New("timeout")}
	h.termin.killErr = errors.New("operation not permitted")

	err := DoUpdate(h.current, h.newBin, h.port, deadPid)
	if err == nil {
		t.Fatal("terminate failure must surface an error")
	}
	if !strings.Contains(err.Error(), "terminate stale launchd instance failed") {
		t.Fatalf("err = %v, want terminate failure cause", err)
	}
	if len(h.termin.killed) != 1 {
		t.Fatalf("killed = %v, want one SIGKILL attempt before giving up", h.termin.killed)
	}
	if content, _ := os.ReadFile(h.current); string(content) != "OLD-BINARY" {
		t.Fatalf("rollback must restore old binary, got %q", content)
	}
	status, detail := resultStatus(t, h.dd)
	if status != "rolled_back" {
		t.Fatalf("result status = %q (%s), want rolled_back", status, detail)
	}
}

// TestDoUpdateReplaceFailureDoesNotKillHealthyInstance 评审落点修订的负断言：
// replace 失败的回滚路径不得终结 KeepAlive 拉起的健康旧实例（旧版在跑=期望
// 终态）；restartService 与 terminate 的落点分离在此钉死
func TestDoUpdateReplaceFailureDoesNotKillHealthyInstance(t *testing.T) {
	h := newDoUpdateHarness(t, superviseLaunchd, false) // newBinary 缺席 → CopyFile 失败
	writePidFileLines(t, h.dd, pidFileContent(os.Getpid(), h.port, ""))

	err := DoUpdate(h.current, h.newBin, h.port, deadPid)
	if err == nil {
		t.Fatal("replace failure must surface an error")
	}
	if len(h.termin.signalled) != 0 || len(h.termin.killed) != 0 {
		t.Fatalf("rollback path must not terminate the healthy old instance: signal=%v kill=%v",
			h.termin.signalled, h.termin.killed)
	}
	if content, _ := os.ReadFile(h.current); string(content) != "OLD-BINARY" {
		t.Fatalf("rollback must restore old binary, got %q", content)
	}
	if status, _ := resultStatus(t, h.dd); status != "rolled_back" {
		t.Fatalf("result status = %q, want rolled_back", status)
	}
}

// TestDoUpdateNonLaunchdFormsSkipTerminate 落点只在 launchd 正向路径：bare 形态
// 换包成功后零 terminate 外呼（其余形态语义不变）
func TestDoUpdateNonLaunchdFormsSkipTerminate(t *testing.T) {
	h := newDoUpdateHarness(t, superviseBare, true)
	writePidFileLines(t, h.dd, pidFileContent(os.Getpid(), h.port, "0.0.2-new"))

	if err := DoUpdate(h.current, h.newBin, h.port, deadPid); err != nil {
		t.Fatalf("DoUpdate = %v, want nil", err)
	}
	if h.route.spawnCalls != 1 {
		t.Fatalf("bare form must spawn the new version once, got %d", h.route.spawnCalls)
	}
	if len(h.termin.signalled) != 0 || len(h.termin.killed) != 0 {
		t.Fatalf("non-launchd form must not terminate: signal=%v kill=%v", h.termin.signalled, h.termin.killed)
	}
}

// TestDoUpdateHealth200FromOldInstanceIsNotSuccess 证据性门控的端到端语义：
// 旧实例常驻回 200（PID 文件无版本行）绝不判成功——健康等待最终以 runaway
// 兜底诚实回滚，而不是把「内存旧版 + 盘上新版」当成功交付
func TestDoUpdateHealth200FromOldInstanceIsNotSuccess(t *testing.T) {
	shrinkHealthTiming(t, 10*time.Millisecond, time.Hour, 150*time.Millisecond)
	h := newDoUpdateHarness(t, superviseLaunchd, true)
	// 旧实例不写版本行；terminate 桩不改变盘面（模拟终结后仍有残留旧实例）
	writePidFileLines(t, h.dd, pidFileContent(os.Getpid(), h.port, ""))

	err := DoUpdate(h.current, h.newBin, h.port, deadPid)
	if err == nil {
		t.Fatal("health 200 without version evidence must not be declared success")
	}
	if !strings.Contains(err.Error(), "runaway guard") {
		t.Fatalf("err = %v, want runaway-guard honest rollback", err)
	}
	status, detail := resultStatus(t, h.dd)
	if status != "rolled_back" {
		t.Fatalf("result status = %q (%s), want rolled_back", status, detail)
	}
}

// TestWaitForHealthyVersionGate 版本门控单元面：版本相符放行 / 不符与缺行
// 继续等（runaway 兜底）/ 中心链目标版本不可知（"center"）时版本行在场放行，
// 但 == 换包前版本即否决（P-20261122-8 回填：否则 P-6+ 旧实例在中心链恒放行=
// 静默假成功）
func TestWaitForHealthyVersionGate(t *testing.T) {
	cases := []struct {
		name       string
		target     string
		prev       string
		pidVersion string
		wantPass   bool
		wantLog    string
	}{
		{"match", "0.0.2-new", "0.0.1-old", "0.0.2-new", true, ""},
		{"mismatch", "0.0.2-new", "0.0.1-old", "0.0.1-old", false, `pid file version "0.0.1-old" != target "0.0.2-new"`},
		{"missing line", "0.0.2-new", "0.0.1-old", "", false, "no version line"},
		{"center accepts other version", "center", "0.0.1-old", "0.0.2-new", true, ""},
		{"center vetoes pre-update version", "center", "0.0.1-old", "0.0.1-old", false,
			`equals the pre-update version "0.0.1-old"`},
		{"dev chain line is the only evidence", "dev", "dev", "dev", true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 报告间隔压到毫秒级：诊断行（含 version gate pending）在 runaway 前落地
			shrinkHealthTiming(t, 10*time.Millisecond, 20*time.Millisecond, 250*time.Millisecond)
			port, healthy := newHealthStub(t)
			healthy.Store(true) // 恒 200：只有版本证据能区分放行/继续等
			dd := isolateDataDir(t)
			buf := stubSyncLogger(t)
			writePidFileLines(t, dd, pidFileContent(deadPid, port, tc.pidVersion))

			ctx := &updateContext{port: port, dd: dd, version: tc.target, prevVersion: tc.prev}
			done := make(chan error, 1)
			go func() { done <- ctx.waitForHealthy(deadPid) }()

			if tc.wantPass {
				select {
				case err := <-done:
					if err != nil {
						t.Fatalf("waitForHealthy = %v, want nil", err)
					}
				case <-time.After(3 * time.Second):
					t.Fatalf("version-confirmed health never released; log:\n%s", buf.String())
				}
				return
			}
			select {
			case err := <-done:
				if err == nil || !strings.Contains(err.Error(), "runaway guard") {
					t.Fatalf("waitForHealthy = %v, want runaway-guard error", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("gate never handed off to the guard; log:\n%s", buf.String())
			}
			waitLogContains(t, buf, tc.wantLog, time.Second)
			waitLogContains(t, buf, "version gate pending", time.Second)
		})
	}
}

// TestPidFileContentHelperSelfCheck 夹具自检：version 缺席时第四行为最后一行、
// 在场时第五行为版本（readPIDVersion 的读取形态与写侧格式成对）
func TestPidFileContentHelperSelfCheck(t *testing.T) {
	lines := strings.Split(pidFileContent(1, 2, ""), "\n")
	if len(lines) != 4 {
		t.Fatalf("no-version pid file lines = %v, want 4", lines)
	}
	lines = strings.Split(pidFileContent(1, 2, "v"), "\n")
	if len(lines) != 5 || lines[4] != "v" {
		t.Fatalf("version pid file lines = %v, want 5 with version last", lines)
	}
}
