package update

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 换包子进程活性握手（P-20261122-5）三形态验收：spawn err（现状前缀）/ 秒死
// （ErrSubprocessDied 直陈，errMsg 不套 start-failed 前缀）/ 正常（marker 在窗内
// 即到 restarting）。另钉三面硬语义：
//   - O_APPEND 尺寸标记：update.log 跨轮持久化，上一轮的旧 marker 不得满足本轮
//     增量判定（本案核心判据——存在性检查被评审否决的根因）；
//   - 判死即快：秒死形态经进程退出哨兵毫秒级返回，不等满活性窗；
//   - 失败通知 reason = errMsg 原文（零新增 notify i18n 键的既定通道）。
//
// 护栏（launchUpdateSubprocessFn 注释同款）：真实握手链经 newUpdateCmdFn 注入
// 跑在无害子进程上——即刻退出形态（测试二进制 -test.list=^$）与存活窗形态
//（helper-process 模式睡 500ms），绝不执行 _do_update 任何换包动作

// handshakeHelperEnv 存活 helper 子进程的 env 哨兵
const handshakeHelperEnv = "CODECOMBO_HANDSHAKE_HELPER_ALIVE"

// TestHelperHandshakeAlive helper-process 模式的存活子进程（exec 包标准技巧）：
// env 哨兵在场才睡窗；常规测试进程跑到这里直接 Skip 不占时长
func TestHelperHandshakeAlive(t *testing.T) {
	if os.Getenv(handshakeHelperEnv) != "1" {
		t.Skip("helper process only")
	}
	time.Sleep(500 * time.Millisecond)
}

// compressHandshake 压缩活性窗（生产 10s 塞不进单测；原子取值口防 race 门禁
// 下收尾期改写与并发读的竞争）
func compressHandshake(t *testing.T, d time.Duration) {
	t.Helper()
	old := subprocessHandshakeTimeout.Load()
	subprocessHandshakeTimeout.Store(d)
	t.Cleanup(func() { subprocessHandshakeTimeout.Store(old) })
}

// stubUpdateCmd 把真实握手链的子进程替换为无害形态：kind=instant 即刻退出
// （秒死/Spawn-err 演练），kind=alive 存活 500ms（正常/超时演练）
func stubUpdateCmd(t *testing.T, kind string) {
	t.Helper()
	orig := newUpdateCmdFn
	newUpdateCmdFn = func(string, string, int, int, string, string, string, superviseForm, []string) *exec.Cmd {
		if kind == "alive" {
			cmd := exec.Command(os.Args[0], "-test.run=TestHelperHandshakeAlive", "-test.timeout=60s")
			cmd.Env = append(os.Environ(), handshakeHelperEnv+"=1")
			return cmd
		}
		return exec.Command(os.Args[0], "-test.list=^$")
	}
	t.Cleanup(func() { newUpdateCmdFn = orig })
}

// appendUpdateLogE 追加一行的错误面形态：marker 晚到场景在 goroutine 里调用，
// 不能经 *testing.T（t.Fatalf 只许测试 goroutine）——错误经 channel 交回主测试
func appendUpdateLogE(dataDir, line string) error {
	if err := os.MkdirAll(filepath.Join(dataDir, "logs"), 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(updateLogPath(dataDir), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line + "\n")
	return err
}

// appendUpdateLog 按 initLogger 的行形态追加一行（log.Ldate|log.Ltime 前缀 +
// DoUpdate 首句的 update started 行）；测试 goroutine 内的调用走 E 形态
func appendUpdateLog(t *testing.T, dataDir, line string) {
	t.Helper()
	if err := appendUpdateLogE(dataDir, line); err != nil {
		t.Fatalf("append update.log: %v", err)
	}
}

func handshakeStartedLine(prev, version string) string {
	return "2026/11/22 14:01:51 update started: " + prev + " -> " + version + " (pid=42, port=9999)"
}

// 秒死（真实握手链）：即刻退出子进程零日志——判 ErrSubprocessDied 且快于活性窗
func TestLaunchUpdateSubprocessHandshakeInstantDeath(t *testing.T) {
	m := testManager(t)
	// 窗放宽到 15s、阈值 5s：慢 runner 上子进程启动本身可耗 ~1s（win 实测
	// 1.3s），2s 阈值余量不足；5s « 15s 仍严格区分「哨兵快返」与「等满窗」
	compressHandshake(t, 15*time.Second)
	stubUpdateCmd(t, "instant")

	start := time.Now()
	err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1")
	if !errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("err = %v, want ErrSubprocessDied", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("instant death must fail fast via the exit sentinel, took %v", time.Since(start))
	}
}

// 旧 marker 不满足本轮（O_APPEND 尺寸标记端到端）：update.log 带上一轮完整
// 时间线，本轮子进程零日志——旧 `update started: 0.0.1 -> 9.9.9` 行不得让
// 本轮握手假成功
func TestLaunchUpdateSubprocessHandshakeStaleMarkerIgnored(t *testing.T) {
	m := testManager(t)
	compressHandshake(t, 2*time.Second)
	appendUpdateLog(t, m.dataDir, handshakeStartedLine("0.0.1", "9.9.9"))
	appendUpdateLog(t, m.dataDir, "2026/11/22 14:02:30 update successful")
	stubUpdateCmd(t, "instant")

	if err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1"); !errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("stale marker must not satisfy this round's handshake, err = %v", err)
	}
}

// 正常形态（真实握手链）：存活子进程 + 首行日志 100ms 后晚到——轮询路径在窗内
// 取证成功
func TestLaunchUpdateSubprocessHandshakeMarkerInWindow(t *testing.T) {
	m := testManager(t)
	compressHandshake(t, 5*time.Second)
	stubUpdateCmd(t, "alive")

	writeDone := make(chan error, 1)
	go func() {
		time.Sleep(100 * time.Millisecond)
		writeDone <- appendUpdateLogE(m.dataDir, handshakeStartedLine("0.0.1", "9.9.9"))
	}()

	if err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1"); err != nil {
		t.Fatalf("marker within window must pass handshake, got %v", err)
	}
	if err := <-writeDone; err != nil {
		t.Fatalf("append update.log: %v", err)
	}
}

// 窗满判死：存活子进程但始终无日志——压缩窗到点后按秒死判（压缩生效：远小于
// 生产 10s 即返回）
func TestLaunchUpdateSubprocessHandshakeTimeoutNoEvidence(t *testing.T) {
	m := testManager(t)
	compressHandshake(t, 250*time.Millisecond)
	stubUpdateCmd(t, "alive")

	start := time.Now()
	err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1")
	if !errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("err = %v, want ErrSubprocessDied after the compressed window", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("compressed window not in effect, took %v (production value would be 10s)", time.Since(start))
	}
}

// spawn err 不是秒死：Start 本身失败（二进制不存在）按现状错误返回，不得误判
// ErrSubprocessDied（errMsg 两形态分型的前提）
func TestLaunchUpdateSubprocessSpawnErrNotDied(t *testing.T) {
	m := testManager(t)
	orig := newUpdateCmdFn
	newUpdateCmdFn = func(string, string, int, int, string, string, string, superviseForm, []string) *exec.Cmd {
		return exec.Command(filepath.Join(t.TempDir(), "no-such-binary"))
	}
	t.Cleanup(func() { newUpdateCmdFn = orig })

	err := LaunchUpdateSubprocess("/old/x", "/new/x", 9999, 42, m.dataDir, "9.9.9", "0.0.1")
	if err == nil || errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("err = %v, want a plain start error (not ErrSubprocessDied)", err)
	}
}

// logGrewWithMarker 增量判定语义：旧字节中的 marker 不计（从 spawn 前尺寸标记
// 起读）；新增字节含 marker 即命中；未增长不命中
func TestLogGrewWithMarkerSizeMarkSemantics(t *testing.T) {
	m := testManager(t)
	appendUpdateLog(t, m.dataDir, handshakeStartedLine("0.0.1", "9.9.9"))
	appendUpdateLog(t, m.dataDir, "2026/11/22 14:02:30 update successful")
	mark, err := updateLogSize(m.dataDir)
	if err != nil {
		t.Fatalf("mark: %v", err)
	}
	marker := "update started: 0.0.1 -> 9.9.9"

	if logGrewWithMarker(m.dataDir, mark, marker) {
		t.Fatal("stale marker below the size mark must not match")
	}
	if logGrewWithMarker(m.dataDir, 0, "no-such-line") {
		t.Fatal("non-matching growth must not match")
	}

	appendUpdateLog(t, m.dataDir, handshakeStartedLine("0.0.1", "9.9.9"))
	if !logGrewWithMarker(m.dataDir, mark, marker) {
		t.Fatal("fresh marker appended above the size mark must match")
	}
}

// updateLogSize：首更（日志缺席）标记为 0，不报错
func TestUpdateLogSizeAbsentIsZero(t *testing.T) {
	m := testManager(t)
	mark, err := updateLogSize(m.dataDir)
	if err != nil || mark != 0 {
		t.Fatalf("mark = %d, err = %v, want 0/nil for absent log", mark, err)
	}
}

// 秒死原因文本：errors.Is 判型成立、outcome 与活性窗时长入文；非 darwin 平台
// 断言通用诱因段（darwin 指引段文案分叉由 GOOS 分支保证，交叉编译门禁守两分支
// 可编译）。两形态（P-20261122-9）：alive-but-silent 与 exited(<state>)——
// 后者由 ProcessState 捕获提供死因，前者如实声明「还活着只是没落日志」
func TestSubprocessDiedErrorText(t *testing.T) {
	err := subprocessDiedError(silentOutcome())
	if !errors.Is(err, ErrSubprocessDied) {
		t.Fatalf("errors.Is(ErrSubprocessDied) = false for %v", err)
	}
	if !strings.Contains(err.Error(), `"update started"`) || !strings.Contains(err.Error(), subprocessHandshakeDefault.String()) {
		t.Fatalf("reason must carry the evidence line and the window duration, got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "alive but silent within") {
		t.Fatalf("silent form must say alive-but-silent, got %q", err.Error())
	}
	if runtime.GOOS != "darwin" && !strings.Contains(err.Error(), "antivirus") {
		t.Fatalf("non-darwin reason must list common causes, got %q", err.Error())
	}

	// exited 形态：死因（ProcessState.String）进文，且不再宣称活性窗（进程已退）
	exited := subprocessDiedError(exitedBeforeStartupOutcome(nil))
	if !strings.Contains(exited.Error(), "exited (unknown status) before startup") {
		t.Fatalf("exited form must carry the exit state, got %q", exited.Error())
	}
	if strings.Contains(exited.Error(), "within") {
		t.Fatalf("exited form must not claim a liveness window, got %q", exited.Error())
	}
}

// 流水线三形态（applyUpdate errMsg 分型 + 失败通知 reason 通道）：下载桩+校验
// 短路让流水线直达 launch 段，launchUpdateSubprocessFn 注入演练三种结局
func TestApplyUpdateLaunchHandshakeForms(t *testing.T) {
	setup := func(t *testing.T) *Manager {
		t.Helper()
		m := testManager(t)
		useFakeDownload(t, bytes.Repeat([]byte("x"), 1024))
		origVerify := verifyUpdateFn
		verifyUpdateFn = func(string, *ReleaseInfo) error { return nil }
		t.Cleanup(func() { verifyUpdateFn = origVerify })
		return m
	}
	info := func() *ReleaseInfo {
		return &ReleaseInfo{Version: "9.9.9", DownloadURL: "https://example.com/codecombo"}
	}

	t.Run("spawn err 沿现状前缀", func(t *testing.T) {
		m := setup(t)
		orig := launchUpdateSubprocessFn
		launchUpdateSubprocessFn = func(string, string, int, int, string, string, string) error {
			return errors.New("fork/exec denied")
		}
		t.Cleanup(func() { launchUpdateSubprocessFn = orig })

		if err := m.ApplyUpdate(context.Background(), info(), "0.0.1", 0, nil); err == nil {
			t.Fatal("want error")
		}
		st := m.GetStatus()
		if st.Status != StatusFailed {
			t.Fatalf("status = %s, want failed", st.Status)
		}
		if st.ErrMsg != "start update process failed: fork/exec denied" {
			t.Fatalf("errMsg = %q, want the historical start-failed prefix", st.ErrMsg)
		}
	})

	t.Run("秒死直陈握手结论并随失败通知透出", func(t *testing.T) {
		m := setup(t)
		notes := captureNotifications(t)
		orig := launchUpdateSubprocessFn
		launchUpdateSubprocessFn = func(string, string, int, int, string, string, string) error {
			return fmt.Errorf(`%w: no "update started" logged within 10s — common causes: antivirus blocking`, ErrSubprocessDied)
		}
		t.Cleanup(func() { launchUpdateSubprocessFn = orig })

		// 异步受理链：秒死失败经状态机承载 + notifyUpdateFailed reason=errMsg 原文
		if err := m.StartUpdate(info(), "0.0.1", 0); err != nil {
			t.Fatalf("admission must succeed, got %v", err)
		}
		waitFor(t, "failed status", func() bool { return m.GetStatus().Status == StatusFailed })
		st := m.GetStatus()
		if !strings.HasPrefix(st.ErrMsg, "update subprocess exited immediately") {
			t.Fatalf("errMsg = %q, want the raw died form without the start-failed prefix", st.ErrMsg)
		}
		waitFor(t, "failed notification", func() bool { return len(notes()) == 2 })
		if !strings.Contains(notes()[1].Body, "update subprocess exited immediately") {
			t.Fatalf("failed notification body = %q, want the raw died reason", notes()[1].Body)
		}
	})

	t.Run("正常形态到 restarting", func(t *testing.T) {
		m := setup(t)
		orig := launchUpdateSubprocessFn
		launchUpdateSubprocessFn = func(string, string, int, int, string, string, string) error { return nil }
		t.Cleanup(func() { launchUpdateSubprocessFn = orig })

		if err := m.ApplyUpdate(context.Background(), info(), "0.0.1", 0, nil); err != nil {
			t.Fatalf("apply: %v", err)
		}
		if st := m.GetStatus(); st.Status != StatusRestarting {
			t.Fatalf("status = %s, want restarting", st.Status)
		}
	})
}
