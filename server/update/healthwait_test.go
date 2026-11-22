package update

// P-20261116-1-S1 健康等待活性驱动单测：PID 基线播种 / crash-loop 秒级判失败 /
// runaway 兜底语义 / 诊断行证据。waitForHealthy 的 HTTP 探测指向本测试内起的
// httptest 服务，PID 文件落 t.TempDir() 并把 CC_DATA_DIR 钉空隔离宿主实况
//（restart_route_test.go 同款护栏）——绝不探测真实实例端口、绝不真实 spawn。
// 「存活 PID」一律用测试进程自身 os.Getpid()（三平台真实存活），「死 PID」用
// 超出 pid_max 的 2147483000（restart_route_test.go 同款取值口径）

import (
	"bytes"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// deadPid 远超 pid_max 的必然不存在 PID（三平台一致：Linux pid_max 默认 ~4M、
// Windows PID 亦远小于此），保证 processAlive 恒假
const deadPid = 2147483000

// syncBuffer 并发安全日志缓冲：waitForHealthy 在 goroutine 里写日志、测试主
// 协程按内容同步等待，bytes.Buffer 非并发安全故自包一层（stubUpdateLogger
// 的缓冲为顺序断言场景，两helper并存各司其职）
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// stubSyncLogger 把包级 updateLogger 指向并发安全缓冲（测试结束还原）
func stubSyncLogger(t *testing.T) *syncBuffer {
	var buf syncBuffer
	orig := updateLogger
	updateLogger = log.New(&buf, "", 0)
	t.Cleanup(func() { updateLogger = orig })
	return &buf
}

// shrinkHealthTiming 压缩等待节奏（包级变量插桩，包测试无 t.Parallel 安全——
// supervise_test.go 头注同款纪律）：生产恒默认值，仅测试内生效
func shrinkHealthTiming(t *testing.T, poll, report, guard time.Duration) {
	t.Helper()
	origPoll, origReport, origGuard := healthPollInterval, healthReportEvery, healthRunawayGuard
	healthPollInterval, healthReportEvery, healthRunawayGuard = poll, report, guard
	t.Cleanup(func() { healthPollInterval, healthReportEvery, healthRunawayGuard = origPoll, origReport, origGuard })
}

// newHealthStub 本测试内的 /api/health 桩（healthy 翻转前恒 503）：waitForHealthy
// 探测的唯一真实端点，端口取 httptest 随机空闲口，绝不碰宿主真实实例
func newHealthStub(t *testing.T) (port int, healthy *atomic.Bool) {
	t.Helper()
	var flag atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if flag.Load() {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)
	addr, ok := srv.Listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("health stub listener is not TCP: %T", srv.Listener.Addr())
	}
	return addr.Port, &flag
}

// isolateDataDir 数据目录钉空目录隔离宿主实况（readRunningPid 第三候选回落
// config.DataDir()，restart_route_test.go 同款），并返回 dd
func isolateDataDir(t *testing.T) string {
	t.Helper()
	t.Setenv("SC_DATA_DIR", "")
	t.Setenv("CC_DATA_DIR", t.TempDir())
	return t.TempDir()
}

// writePidFile 落两行形态 PID 文件（首行=pid 为 readRunningPid 读取目标；第三行
// 回环口缺省 → waitForHealthy 探测主端口=健康桩端口）
func writePidFile(t *testing.T, dd string, pid int) {
	t.Helper()
	content := strconv.Itoa(pid) + "\n9999\n"
	if err := os.WriteFile(filepath.Join(dd, "codecombo.pid"), []byte(content), 0644); err != nil {
		t.Fatalf("write pid file: %v", err)
	}
}

// waitLogContains 轮询等待日志出现子串（与被测 goroutine 的推进同步，免睡眠
// 赛跑）；超时带全文失败
func waitLogContains(t *testing.T, b *syncBuffer, substr string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(b.String(), substr) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("log never contained %q within %v; got:\n%s", substr, timeout, b.String())
}

// TestWaitForHealthyBaselineSeedsBeforeAnyFailure 事故回归钉子（beta.7→beta.8
// 形态）：起点 PID 文件是已死旧 PID（旧进程退出不清理），基线未播种期间无论
// 读到死旧 PID 还是另一个死 PID 都绝不判死、绝不返回——只有「新 PID 且存活」
// 播种基线后，健康翻绿才放行。朴素活性循环（读到死 PID 即失败）在此必挂
func TestWaitForHealthyBaselineSeedsBeforeAnyFailure(t *testing.T) {
	shrinkHealthTiming(t, 10*time.Millisecond, time.Hour, time.Hour)
	port, healthy := newHealthStub(t)
	dd := isolateDataDir(t)
	buf := stubSyncLogger(t)
	writePidFile(t, dd, deadPid) // 起点：死旧 PID 在文件里（退出无清理形态）

	ctx := &updateContext{port: port, dd: dd}
	done := make(chan error, 1)
	go func() { done <- ctx.waitForHealthy(deadPid) }()

	// 基线未播种期：换上另一个死 PID 也必须继续等（不判死不返回）
	time.Sleep(50 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("waitForHealthy returned while baseline unseeded — naive liveness misfire: %v", err)
	default:
	}
	writePidFile(t, dd, deadPid+1)
	time.Sleep(50 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("waitForHealthy returned on dead pid while baseline unseeded: %v", err)
	default:
	}

	// 存活新 PID 播种基线（留痕），随后健康翻绿放行
	writePidFile(t, dd, os.Getpid())
	waitLogContains(t, buf, "baseline seeded pid="+strconv.Itoa(os.Getpid()), 3*time.Second)
	healthy.Store(true)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("waitForHealthy = %v, want nil after baseline seeded + healthy", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("waitForHealthy never returned after healthy flip; log:\n%s", buf.String())
	}
}

// TestWaitForHealthyCrashLoopFailsFast 基线确立后 PID 变化 ≥2 次秒级判
// crash-loop 失败（消解 unit Restart=on-failure ~100ms 重拉使活性永真的盲区，
// 优于旧 15s 死线与 10 分钟兜底）；变化值=换包前旧 PID 时不计次（防陈旧文件
// 在新进程首次改写前被计为一次重启）
func TestWaitForHealthyCrashLoopFailsFast(t *testing.T) {
	shrinkHealthTiming(t, 10*time.Millisecond, time.Hour, 5*time.Second)
	port, _ := newHealthStub(t) // 健康恒 503：crash-loop 判定不依赖端点
	dd := isolateDataDir(t)
	buf := stubSyncLogger(t)
	writePidFile(t, dd, os.Getpid()) // 存活新 PID，首次轮询即播种基线

	ctx := &updateContext{port: port, dd: dd}
	done := make(chan error, 1)
	go func() { done <- ctx.waitForHealthy(deadPid) }()

	waitLogContains(t, buf, "baseline seeded", 3*time.Second)

	// 旧 PID 回写不计数：陈旧文件瞬态（新进程改写前的窗口）不是重启证据
	writePidFile(t, dd, deadPid)
	time.Sleep(50 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("old pid rewrite must not count as restart, got early return: %v", err)
	default:
	}

	// 两次真实变化 → crash-loop 立即失败（不吊到 5s runaway）
	writePidFile(t, dd, deadPid+1)
	waitLogContains(t, buf, "pid changed", 3*time.Second)
	writePidFile(t, dd, deadPid+2)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("crash-loop must fail the wait, got nil")
		}
		if !strings.Contains(err.Error(), "crash-loop") {
			t.Fatalf("err = %v, want crash-loop cause", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("crash-loop never detected; log:\n%s", buf.String())
	}
}

// TestWaitForHealthyRunawayGuardUndeterminedCause 失控兜底语义：超时兜底、
// 原因未定（慢恢复或死锁均可）——错误文案不得断言「真死锁」；基线未播种
// （PID 文件恒死旧值）形态下触发即兜底收口
func TestWaitForHealthyRunawayGuardUndeterminedCause(t *testing.T) {
	shrinkHealthTiming(t, 10*time.Millisecond, time.Hour, 150*time.Millisecond)
	port, _ := newHealthStub(t)
	dd := isolateDataDir(t)
	stubSyncLogger(t)
	writePidFile(t, dd, deadPid)

	ctx := &updateContext{port: port, dd: dd}
	start := time.Now()
	err := ctx.waitForHealthy(deadPid)
	if err == nil {
		t.Fatal("runaway guard must fail the wait, got nil")
	}
	if !strings.Contains(err.Error(), "runaway guard") || !strings.Contains(err.Error(), "cause undetermined") {
		t.Fatalf("err = %v, want runaway guard with undetermined-cause semantics", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("runaway guard fired at %v, want ~guard value", elapsed)
	}
}

// TestWaitForHealthyDiagnosticEvidence 诊断行证据化：等待期每 report 间隔落一行
// 真实进展（存活态/已等时长/数据目录日志字节增量），而非臆测性叙述
func TestWaitForHealthyDiagnosticEvidence(t *testing.T) {
	shrinkHealthTiming(t, 10*time.Millisecond, 30*time.Millisecond, 150*time.Millisecond)
	port, _ := newHealthStub(t)
	dd := isolateDataDir(t)
	buf := stubSyncLogger(t)
	writePidFile(t, dd, os.Getpid())
	// 新进程侧日志痕迹：主进程按天滚动日志 + bare 形态 stdout（update-restart.log），
	// 诊断行的字节增量证据读的就是它们
	logs := filepath.Join(dd, "logs")
	if err := os.MkdirAll(logs, 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(logs, "codecombo-20990101.log"), []byte("startup line\n"), 0644); err != nil {
		t.Fatalf("write main log: %v", err)
	}
	if err := os.WriteFile(filepath.Join(logs, "update-restart.log"), []byte("daemon stdout\n"), 0644); err != nil {
		t.Fatalf("write restart log: %v", err)
	}

	ctx := &updateContext{port: port, dd: dd}
	_ = ctx.waitForHealthy(deadPid) // 恒 503 → 以 runaway 兜底收口（150ms）

	waitLogContains(t, buf, "health wait:", time.Second)
	waitLogContains(t, buf, "dd logs", time.Second)
	waitLogContains(t, buf, "waited", time.Second)
	// 基线在首个诊断点前已播种（存活 PID 在文件里），进展行必须是真实存活证据
	waitLogContains(t, buf, fmt.Sprintf("pid %d alive=true", os.Getpid()), time.Second)
}

// TestProcessAlivePlatformContract 存活探测平台契约：本进程真、不存在假、
// 非正值假（Windows 无 Signal(0) 的缺口由 OpenProcess 分支闭合，proc_windows.go
// 同款机制——三平台同一断言面）
func TestProcessAlivePlatformContract(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Fatal("own pid must be alive")
	}
	if processAlive(deadPid) {
		t.Fatalf("pid %d must be dead on any platform", deadPid)
	}
	if processAlive(0) || processAlive(-1) {
		t.Fatal("non-positive pid must be dead")
	}
}

// TestLogsSizeExcludesOwnUpdateLog 诊断字节增量的口径：合计 dd/logs/*.log 但
// 排除本子进程自有 update.log（诊断行写它，不排除则增量自证恒真）
func TestLogsSizeExcludesOwnUpdateLog(t *testing.T) {
	dd := t.TempDir()
	logs := filepath.Join(dd, "logs")
	if err := os.MkdirAll(logs, 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	if err := os.WriteFile(filepath.Join(logs, "update.log"), []byte("0123456789"), 0644); err != nil { // 10B 自证面
		t.Fatalf("write update.log: %v", err)
	}
	if err := os.WriteFile(filepath.Join(logs, "codecombo-20990101.log"), []byte("12345"), 0644); err != nil { // 5B
		t.Fatalf("write main log: %v", err)
	}
	if err := os.WriteFile(filepath.Join(logs, "update-restart.log"), []byte("123"), 0644); err != nil { // 3B
		t.Fatalf("write restart log: %v", err)
	}
	if err := os.WriteFile(filepath.Join(logs, "notes.txt"), []byte("12345678"), 0644); err != nil { // 非 .log 不计
		t.Fatalf("write notes.txt: %v", err)
	}
	if got := logsSize(dd); got != 8 {
		t.Fatalf("logsSize = %d, want 8 (main 5B + restart 3B, update.log 10B excluded)", got)
	}
	if got := logsSize(filepath.Join(dd, "no-such-dir")); got != 0 {
		t.Fatalf("logsSize on missing dir = %d, want 0", got)
	}
}
