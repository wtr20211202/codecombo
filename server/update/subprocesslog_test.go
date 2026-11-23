package update

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 换包子进程诊断面（P-20261122-9 必改A/必改8）：update-subprocess.log 承载
//   - 子进程 stdout/stderr（Start 成功、initLogger 之前的字节——修复前全丢）；
//   - 父进程活性裁决行（PID/outcome/原因，必改1 的 durable 面）；
//   - 按次轮转（.1 只留上一次）。
//
// 护栏同 handshake_test.go：newUpdateCmdFn 注入跑在测试二进制 helper 上，
// 绝不执行 _do_update 任何换包动作

// diagHelperEnv helper 子进程 env：值为期望退出码（stdout/stderr 各写一行后
// os.Exit）。非 helper 形态直接 Skip 不占时长
const diagHelperEnv = "CODECOMBO_SUBPROCESS_DIAG_HELPER"

func TestHelperSubprocessDiag(t *testing.T) {
	raw := os.Getenv(diagHelperEnv)
	if raw == "" {
		t.Skip("helper process only")
	}
	// 模拟「initLogger 之前」的输出：stdout 走 fmt、stderr 走 panic/运行时面
	_, _ = os.Stdout.WriteString("diag-stdout-marker\n")
	_, _ = os.Stderr.WriteString("diag-stderr-marker\n")
	code, err := strconv.Atoi(raw)
	if err != nil {
		code = 1
	}
	os.Exit(code)
}

// stubDiagCmd 注入带 stdio 输出的 helper 子进程；返回的取值器在
// LaunchUpdateSubprocess 调用后取回被组装的 *exec.Cmd（断言 Stdout/Stderr 接线）
func stubDiagCmd(t *testing.T, exitCode int) func() *exec.Cmd {
	t.Helper()
	orig := newUpdateCmdFn
	var captured *exec.Cmd
	newUpdateCmdFn = func(string, string, int, int, string, string, string, superviseForm, []string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=TestHelperSubprocessDiag", "-test.timeout=60s")
		cmd.Env = append(os.Environ(), diagHelperEnv+"="+strconv.Itoa(exitCode))
		captured = cmd
		return cmd
	}
	t.Cleanup(func() { newUpdateCmdFn = orig })
	return func() *exec.Cmd { return captured }
}

// readSubprocessLog 读取诊断日志（不存在即测试失败——诊断面缺席属缺陷）
func readSubprocessLog(t *testing.T, dataDir string) string {
	t.Helper()
	b, err := os.ReadFile(updateSubprocessLogPath(dataDir))
	if err != nil {
		t.Fatalf("read update-subprocess.log: %v", err)
	}
	return string(b)
}

// 两形态一次验收：stdout/stderr 同接同一文件、退出码进错误文本、父进程裁决行
// 落盘（含 outcome=exited(exit status 3)）、cmd.Stdout/Stderr 接线非 nil
func TestSubprocessLogCapturesStdioAndVerdict(t *testing.T) {
	m := testManager(t)
	compressHandshake(t, 5*time.Second)
	captured := stubDiagCmd(t, 3)

	err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1")
	if !errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("err = %v, want ErrSubprocessDied", err)
	}
	// ProcessState 捕获（必改A）：死因进错误文本，不再是笼统「10s 没动静」
	if !strings.Contains(err.Error(), "exit status 3") {
		t.Fatalf("err must carry the exit status, got %q", err.Error())
	}

	cmd := captured()
	if cmd == nil || cmd.Stdout == nil || cmd.Stderr == nil {
		t.Fatalf("subprocess stdio must be wired, got %#v", cmd)
	}
	if cmd.Stdout != cmd.Stderr {
		t.Fatal("stdout and stderr must share the same *os.File (panic trace goes to stderr)")
	}

	logBody := readSubprocessLog(t, m.dataDir)
	if !strings.Contains(logBody, "# update-subprocess.log") {
		t.Fatalf("responsibility header missing, got %q", logBody)
	}
	for _, want := range []string{
		"diag-stdout-marker", // stdout 字节（早期 fmt/运行时）
		"diag-stderr-marker", // stderr 字节（panic/运行时）
		"[parent] handshake failed pid=",
		"outcome=exited (exit status 3, exitCode=3) before startup",
	} {
		if !strings.Contains(logBody, want) {
			t.Fatalf("update-subprocess.log missing %q, got %q", want, logBody)
		}
	}

	// 职责分离钉子：诊断面绝不并入 update.log——runbook #26/#27 的
	// 「update.log 不存在 ⇒ 组杀/未进 DoUpdate」判别式依赖它保持纯决策时间线
	if _, err := os.Stat(updateLogPath(m.dataDir)); !os.IsNotExist(err) {
		t.Fatalf("update.log must not be created by the subprocess diagnostics path, stat err = %v", err)
	}
}

// alive but silent 形态：窗满仍无证据——裁决行如实写「活着但无声」，不冒充秒死
func TestSubprocessLogAliveButSilentOutcome(t *testing.T) {
	m := testManager(t)
	compressHandshake(t, 250*time.Millisecond)
	stubUpdateCmd(t, "alive")

	err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1")
	if !errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("err = %v, want ErrSubprocessDied", err)
	}
	if !strings.Contains(err.Error(), "alive but silent within") {
		t.Fatalf("err must state alive-but-silent, got %q", err.Error())
	}
	logBody := readSubprocessLog(t, m.dataDir)
	if !strings.Contains(logBody, "outcome=alive but silent within") {
		t.Fatalf("verdict line must carry the alive-but-silent outcome, got %q", logBody)
	}
}

// 按次轮转：spawn 前非空即改名 .1，只留上一次——两轮之后的两个文件各是
// 哪一轮的现场可辨（诊断面有界）
func TestSubprocessLogRotatesPerRun(t *testing.T) {
	m := testManager(t)
	compressHandshake(t, 2*time.Second)
	logPath := updateSubprocessLogPath(m.dataDir)
	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	if err := os.WriteFile(logPath, []byte("previous-run-bytes\n"), 0644); err != nil {
		t.Fatalf("seed log: %v", err)
	}

	stubDiagCmd(t, 0)
	if err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1"); !errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("err = %v, want ErrSubprocessDied (no marker)", err)
	}

	rotated, err := os.ReadFile(logPath + ".1")
	if err != nil {
		t.Fatalf("rotated log missing: %v", err)
	}
	if !strings.Contains(string(rotated), "previous-run-bytes") {
		t.Fatalf(".1 must hold the previous run, got %q", rotated)
	}
	current := readSubprocessLog(t, m.dataDir)
	if strings.Contains(current, "previous-run-bytes") {
		t.Fatalf("current log must be fresh for this run, got %q", current)
	}
	if !strings.Contains(current, "diag-stdout-marker") {
		t.Fatalf("current log must hold this run's stdio, got %q", current)
	}
}
