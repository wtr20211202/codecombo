package update

// P-20261122-2 定向验证：npm wrapper 前台形态重启握手的三态守卫矩阵（新
// wrapper / 守护形态继承 / 无 wrapper-旧 wrapper）与页面重启兜底 RestartSelfExe
// 的脱会话 spawn 面。全部经取值口注入（getppidFn / spawnBareFn——环境依赖探测
// 的测试纪律），绝不真实 spawn 重启进程。本包测试无 t.Parallel，包级插桩安全

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubGetppid 接管 getppidFn 并在测试结束还原
func stubGetppid(t *testing.T, ppid int) {
	t.Helper()
	orig := getppidFn
	t.Cleanup(func() { getppidFn = orig })
	getppidFn = func() int { return ppid }
}

// TestWrapperRestartRequested npm 前台形态重启握手的三态守卫矩阵：
//   - 新 wrapper 前台形态：env 下发 wrapper PID 且 ppid==该值 → true（重启
//     所有权归 wrapper，调用方 shutdown 后以 RestartExitCode 退出）
//   - 守护形态（codecombo start 经 cmdStart 自 spawn）：env 被继承但 ppid
//     已非 wrapper → false（落 RestartSelfExe 兜底——无条件 75 会令守护进程
//     无人接手当场死亡）
//   - 无 wrapper / 旧 wrapper（过渡期不下发 env）/ 垃圾值 → false（同落兜底）
func TestWrapperRestartRequested(t *testing.T) {
	t.Run("new wrapper foreground form: env+ppid match", func(t *testing.T) {
		t.Setenv(EnvWrapperPid, "4321")
		stubGetppid(t, 4321)
		if !WrapperRestartRequested() {
			t.Fatal("env wrapper pid == ppid must hand restart ownership to wrapper")
		}
	})

	t.Run("daemon form: env inherited but ppid differs", func(t *testing.T) {
		t.Setenv(EnvWrapperPid, "4321")
		stubGetppid(t, 999) // cmdStart spawn 的 Go 进程（已退出）/收养后非 wrapper
		if WrapperRestartRequested() {
			t.Fatal("ppid mismatch must fall back to self-spawn, never exit 75 (daemon would die unattended)")
		}
	})

	t.Run("old/no wrapper: env absent", func(t *testing.T) {
		t.Cleanup(func() { os.Unsetenv(EnvWrapperPid) })
		os.Unsetenv(EnvWrapperPid)
		stubGetppid(t, 4321)
		if WrapperRestartRequested() {
			t.Fatal("env absent (pre-P-20261122-2 wrapper / non-npm form) must fall back")
		}
	})

	t.Run("garbage env values", func(t *testing.T) {
		for _, bad := range []string{"not-a-pid", "0", "-5", "  "} {
			t.Run(bad, func(t *testing.T) {
				t.Setenv(EnvWrapperPid, bad)
				stubGetppid(t, 4321)
				if WrapperRestartRequested() {
					t.Fatalf("env %q must be rejected", bad)
				}
			})
		}
	})

	t.Run("exit code has no clash with repo exit codes", func(t *testing.T) {
		// 评审锚：全仓 Go 退出码仅 0/1 与 Windows 服务 uint32 1（SCM 语义）
		if RestartExitCode == 0 || RestartExitCode == 1 {
			t.Fatalf("RestartExitCode = %d clashes with existing exit-code space", RestartExitCode)
		}
	})
}

// TestRestartSelfExeDetachedSpawn 页面重启兜底的脱会话 spawn 面（P-20261122-2
// 升级核心）：原参数保真（os.Args 全量重放）、进程属性脱离终端会话（三平台
// 各自语义字段）、stdout/stderr 落数据目录日志——前台/裸进程/npm 守护形态页面
// 重启后关终端不再连带新进程死
func TestRestartSelfExeDetachedSpawn(t *testing.T) {
	p := stubRestartSeams(t)
	stubUpdateLogger(t)
	dd := t.TempDir()

	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	if err := RestartSelfExe(dd); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.spawnCalls != 1 {
		t.Fatalf("spawnCalls = %d, want 1", p.spawnCalls)
	}
	if p.spawnBinary != exe {
		t.Fatalf("spawn binary = %q, want self exe %q", p.spawnBinary, exe)
	}
	wantArgv := append([]string{exe}, os.Args[1:]...)
	if strings.Join(p.spawnArgv, "\x00") != strings.Join(wantArgv, "\x00") {
		t.Fatalf("argv = %v, want full os.Args replay %v", p.spawnArgv, wantArgv)
	}
	if p.spawnFiles != 3 {
		t.Fatalf("proc files = %d, want stdin+stdout+stderr", p.spawnFiles)
	}
	assertDaemonProcAttr(t, p.spawnSys)
	if _, err := os.Stat(filepath.Join(dd, "logs", "update-restart.log")); err != nil {
		t.Fatalf("restart stdout log not created under dd/logs: %v", err)
	}
}

// TestRestartSelfExeSpawnFailure 自 spawn 失败如实上抛（调用方留痕「manual
// start required」后进程退出——不吞错）
func TestRestartSelfExeSpawnFailure(t *testing.T) {
	origSpawn := spawnBareFn
	origUnit := systemdUnitFn
	origCtl := systemctlRestartFn
	origStart := scStartServiceFn
	origStop := stopWindowsServiceFn
	origKill := killByPIDFn
	t.Cleanup(func() {
		spawnBareFn, systemdUnitFn, systemctlRestartFn = origSpawn, origUnit, origCtl
		scStartServiceFn, stopWindowsServiceFn, killByPIDFn = origStart, origStop, origKill
	})
	spawnErr := errors.New("spawn refused")
	spawnBareFn = func(string, []string, *os.ProcAttr) (int, error) { return 0, spawnErr }
	stubUpdateLogger(t)

	if err := RestartSelfExe(t.TempDir()); err != spawnErr {
		t.Fatalf("err = %v, want spawn failure surfaced", err)
	}
}
