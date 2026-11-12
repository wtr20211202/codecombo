package update

// P-20261112-1-S2 定向验证：restartService 四形态路由矩阵 / argv 原参数保真
// （下发+读取+spawn 三面）/ 回滚链与正向启动同构（同一 restartService 形态路由）。
// 全部经取值口注入（环境依赖探测的测试纪律），绝不真实 spawn 换包进程、不碰
// 真实 SCM 与 systemctl（launchUpdateSubprocessFn 注释同款护栏）。
// 本包测试无 t.Parallel，包级插桩安全

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// stubRestartSeams 一次性接管四形态路由的全部外呼口并记录调用：返回的
// *routeProbe 载有各口实况，测试结束还原
type routeProbe struct {
	systemctlUnit  string
	systemctlCalls int
	scStarts       int
	scStops        int
	spawnBinary    string
	spawnArgv      []string
	// spawnSys detach 语义断言的数据源：SysProcAttr 平台字段差异（unix
	// Setpgid / windows CreationFlags）无跨平台公共字段，runtime.GOOS 分支
	// 写不进同一文件（两分支必须可编译）——断言本体按构建标签分文件，见
	// restart_route_test_unix.go / restart_route_test_windows.go
	spawnSys   *syscall.SysProcAttr
	spawnFiles int
	spawnCalls int
	killedPIDs []int
}

func stubRestartSeams(t *testing.T) *routeProbe {
	p := &routeProbe{}
	origUnit := systemdUnitFn
	origCtl := systemctlRestartFn
	origStart := scStartServiceFn
	origStop := stopWindowsServiceFn
	origSpawn := spawnBareFn
	origKill := killByPIDFn
	t.Cleanup(func() {
		systemdUnitFn, systemctlRestartFn = origUnit, origCtl
		scStartServiceFn, stopWindowsServiceFn = origStart, origStop
		spawnBareFn, killByPIDFn = origSpawn, origKill
	})
	systemdUnitFn = func() string { return "" }
	systemctlRestartFn = func(unit string) error {
		p.systemctlCalls++
		p.systemctlUnit = unit
		return nil
	}
	scStartServiceFn = func() error { p.scStarts++; return nil }
	stopWindowsServiceFn = func() error { p.scStops++; return nil }
	spawnBareFn = func(binary string, argv []string, attr *os.ProcAttr) (int, error) {
		p.spawnCalls++
		p.spawnBinary = binary
		p.spawnArgv = argv
		p.spawnSys = attr.Sys
		p.spawnFiles = len(attr.Files)
		return 4321, nil
	}
	killByPIDFn = func(pid int) error { p.killedPIDs = append(p.killedPIDs, pid); return nil }
	return p
}

// TestRestartServiceRoutesBySuperviseForm 四形态路由矩阵：每种形态恰好命中
// 自己的动作口、其余口零调用（windows-service=仅 sc start / launchd=无外呼
// 直接成功 / bare=仅 spawn / systemd=仅 systemctl restart）
func TestRestartServiceRoutesBySuperviseForm(t *testing.T) {
	cases := []struct {
		form    superviseForm
		unit    string
		wantSc  int
		wantCtl int
		wantSpn int
	}{
		{superviseWindowsService, "", 1, 0, 0},
		{superviseLaunchd, "", 0, 0, 0},
		{superviseBare, "", 0, 0, 1},
		{superviseSystemd, "codecombo.service", 0, 1, 0},
	}
	for _, tc := range cases {
		p := stubRestartSeams(t)
		systemdUnitFn = func() string { return tc.unit }
		buf := stubUpdateLogger(t)
		t.Setenv(envUpdateSupervise, string(tc.form))

		pid, err := restartService("/swapped/binary", 9999, t.TempDir())

		if err != nil {
			t.Fatalf("form %q: unexpected error: %v", tc.form, err)
		}
		if tc.form == superviseWindowsService || tc.form == superviseLaunchd || tc.form == superviseSystemd {
			// PID 无意义（SCM/KeepAlive/systemd 接管），恒 0；bare 返回 spawn PID
			if pid != 0 {
				t.Fatalf("form %q: pid = %d, want 0", tc.form, pid)
			}
		} else if pid != 4321 {
			t.Fatalf("form %q: pid = %d, want spawn stub 4321", tc.form, pid)
		}
		if p.scStarts != tc.wantSc || p.systemctlCalls != tc.wantCtl || p.spawnCalls != tc.wantSpn {
			t.Fatalf("form %q: sc=%d ctl=%d spawn=%d, want sc=%d ctl=%d spawn=%d",
				tc.form, p.scStarts, p.systemctlCalls, p.spawnCalls, tc.wantSc, tc.wantCtl, tc.wantSpn)
		}
		if p.scStops != 0 {
			t.Fatalf("form %q: forward restart must not stop the service", tc.form)
		}
		if tc.form == superviseSystemd && p.systemctlUnit != tc.unit {
			t.Fatalf("form %q: systemctl unit = %q, want %q", tc.form, p.systemctlUnit, tc.unit)
		}
		if tc.form == superviseLaunchd && buf.String() == "" {
			t.Fatalf("form %q: hand-over decision not logged", tc.form)
		}
	}
}

// TestRestartBareReplaysOriginalArgs 原参数保真（spawn 面）：argv 契约在场时
// 逐项原样还原（不经 shell、不重排、port 位置参数不再追加）；契约缺省回落
// 现状语义 --serve --port；进程属性脱离终端会话（三平台各自语义字段）；
// stdout/stderr 落数据目录日志
func TestRestartBareReplaysOriginalArgs(t *testing.T) {
	p := stubRestartSeams(t)
	stubUpdateLogger(t)
	dd := t.TempDir()

	t.Cleanup(func() { os.Unsetenv(envUpdateArgvN) })
	t.Setenv(envUpdateArgvN, "3")
	t.Setenv(envUpdateArgvPrefix+"0", "--serve")
	t.Setenv(envUpdateArgvPrefix+"1", "--host=0.0.0.0")
	t.Setenv(envUpdateArgvPrefix+"2", "--data-dir=/tmp/some dir")

	pid, err := restartService("/swapped/binary", 9999, dd)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pid != 4321 {
		t.Fatalf("pid = %d, want spawn stub 4321", pid)
	}
	want := []string{"/swapped/binary", "--serve", "--host=0.0.0.0", "--data-dir=/tmp/some dir"}
	if strings.Join(p.spawnArgv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %v, want %v（原参数逐项保真）", p.spawnArgv, want)
	}
	if p.spawnBinary != "/swapped/binary" {
		t.Fatalf("spawn binary = %q, want swapped path（argv[0] 权威）", p.spawnBinary)
	}
	if p.spawnFiles != 3 {
		t.Fatalf("proc files = %d, want stdin+stdout+stderr", p.spawnFiles)
	}
	assertDaemonProcAttr(t, p.spawnSys)
	if _, err := os.Stat(filepath.Join(dd, "logs", "update-restart.log")); err != nil {
		t.Fatalf("restart stdout log not created under dd/logs: %v", err)
	}

	// 契约缺省（旧主进程跨版本矩阵）：回落现状语义
	p.spawnCalls = 0
	os.Unsetenv(envUpdateArgvN)
	if _, err := restartService("/swapped/binary", 9999, dd); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	legacy := []string{"/swapped/binary", "--serve", "--port", "9999"}
	if strings.Join(p.spawnArgv, "\x00") != strings.Join(legacy, "\x00") {
		t.Fatalf("legacy argv = %v, want %v", p.spawnArgv, legacy)
	}
}

// TestOrigArgsFromEnv argv 契约读取面：在场逐键还原（含空串/含 = 参数）、
// 缺省静默回落、N 非法/超上界/逐键缺失回落
func TestOrigArgsFromEnv(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(t *testing.T)
		want   []string
		wantOK bool
	}{
		{
			name: "absent legacy parent",
			setup: func(t *testing.T) {
				os.Unsetenv(envUpdateArgvN)
			},
			want: nil, wantOK: false,
		},
		{
			name: "present with empty and = args",
			setup: func(t *testing.T) {
				t.Setenv(envUpdateArgvN, "4")
				t.Setenv(envUpdateArgvPrefix+"0", "--serve")
				t.Setenv(envUpdateArgvPrefix+"1", "")
				t.Setenv(envUpdateArgvPrefix+"2", "--flag=a=b c")
				t.Setenv(envUpdateArgvPrefix+"3", "-p")
			},
			want:   []string{"--serve", "", "--flag=a=b c", "-p"},
			wantOK: true,
		},
		{
			name: "N=0 unusable",
			setup: func(t *testing.T) {
				t.Setenv(envUpdateArgvN, "0")
			},
			want: nil, wantOK: false,
		},
		{
			name: "N garbage",
			setup: func(t *testing.T) {
				t.Setenv(envUpdateArgvN, "many")
			},
			want: nil, wantOK: false,
		},
		{
			name: "N over bound",
			setup: func(t *testing.T) {
				t.Setenv(envUpdateArgvN, "100000")
			},
			want: nil, wantOK: false,
		},
		{
			name: "missing item",
			setup: func(t *testing.T) {
				t.Setenv(envUpdateArgvN, "2")
				t.Setenv(envUpdateArgvPrefix+"0", "--serve")
			},
			want: nil, wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stubUpdateLogger(t)
			tc.setup(t)
			t.Cleanup(func() { os.Unsetenv(envUpdateArgvN) })
			got, ok := origArgsFromEnv()
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if strings.Join(got, "\x00") != strings.Join(tc.want, "\x00") {
				t.Fatalf("args = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestUpdateSubprocessEnvArgvDelivery argv 契约下发面：N 计数与逐键一一对应，
// 与形态提示共存互不干扰
func TestUpdateSubprocessEnvArgvDelivery(t *testing.T) {
	env := updateSubprocessEnv("/dd", "v2.0.0", "v1.9.0", superviseBare,
		[]string{"--serve", "--port", "9999", "--host", "0.0.0.0"})
	if got := lastEnvValue(env, envUpdateArgvN); got != "5" {
		t.Fatalf("argv N = %q, want 5", got)
	}
	for i, want := range []string{"--serve", "--port", "9999", "--host", "0.0.0.0"} {
		key := envUpdateArgvPrefix + strconv.Itoa(i)
		if got := lastEnvValue(env, key); got != want {
			t.Fatalf("argv %s = %q, want %q", key, got, want)
		}
	}
	// 形态提示不回归
	if got := lastEnvValue(env, envUpdateSupervise); got != string(superviseBare) {
		t.Fatalf("supervise env = %q, want bare", got)
	}
}

// TestRollbackRoutesByFormWindowsService 回滚链同构（windows-service）：
// rollback 走同一 restartService 的服务分支——恢复备份后再 sc start，且正向
// 启动不触发 sc stop
func TestRollbackRoutesByFormWindowsService(t *testing.T) {
	p := stubRestartSeams(t)
	stubUpdateLogger(t)
	t.Setenv(envUpdateSupervise, string(superviseWindowsService))
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo.exe")
	_ = os.WriteFile(cur, []byte("NEW"), 0755)
	backup := cur + ".bak"
	_ = os.WriteFile(backup, []byte("OLD"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: backup, port: 9999, dd: dd}

	if err := ctx.rollback("start new version failed"); err == nil {
		t.Fatal("rollback must surface the failure")
	}
	if string(mustRead(t, cur)) != "OLD" {
		t.Fatal("backup not restored over the swapped binary")
	}
	if p.scStarts != 1 || p.spawnCalls != 0 || p.systemctlCalls != 0 {
		t.Fatalf("rollback routing: sc=%d spawn=%d ctl=%d, want sc start only", p.scStarts, p.spawnCalls, p.systemctlCalls)
	}
}

// TestKillAndRollbackRoutesByForm 回滚链同构（健康检查失败三形态）：bare 先
// 杀 spawnedPID 再恢复重拉；windows-service sc stop 后恢复重拉 sc start；
// launchd 先恢复再按 PID 文件杀 KeepAlive 拉起进程、不 spawn（重拉交 KeepAlive）
func TestKillAndRollbackRoutesByForm(t *testing.T) {
	t.Run("bare", func(t *testing.T) {
		p := stubRestartSeams(t)
		stubUpdateLogger(t)
		t.Setenv(envUpdateSupervise, string(superviseBare))
		dd := t.TempDir()
		cur := filepath.Join(dd, "codecombo")
		_ = os.WriteFile(cur, []byte("NEW"), 0755)
		_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
		ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", port: 9999, dd: dd, spawnedPID: 777}

		ctx.killAndRollback("health check failed")

		if !intContains(p.killedPIDs, 777) {
			t.Fatalf("killed = %v, want spawned 777 first", p.killedPIDs)
		}
		if string(mustRead(t, cur)) != "OLD" {
			t.Fatal("backup not restored")
		}
		if p.spawnCalls != 1 || p.spawnBinary != cur {
			t.Fatalf("bare rollback must re-spawn restored binary, got spawn=%d binary=%q", p.spawnCalls, p.spawnBinary)
		}
	})

	t.Run("windows-service", func(t *testing.T) {
		p := stubRestartSeams(t)
		stubUpdateLogger(t)
		t.Setenv(envUpdateSupervise, string(superviseWindowsService))
		// PID 文件候选第三项回落 config.DataDir()，钉空目录隔离宿主实况
		t.Setenv("CC_DATA_DIR", "")
		t.Setenv("SC_DATA_DIR", "")
		t.Setenv("CC_DATA_DIR", t.TempDir())
		dd := t.TempDir()
		cur := filepath.Join(dd, "codecombo.exe")
		_ = os.WriteFile(cur, []byte("NEW"), 0755)
		_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
		// SCM 拉起的坏新进程 PID（杀不得——failure-recovery 会与回滚赛跑）：
		// PID 文件是唯一来源，取远超 pid_max 的不存在值保证 waitForProcess 立即返回
		_ = os.WriteFile(filepath.Join(dd, "codecombo.pid"), []byte("2147483000\n9999\n"), 0644)
		ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", port: 9999, dd: dd}

		ctx.killAndRollback("health check failed")

		if p.scStops != 1 || p.scStarts != 1 {
			t.Fatalf("sc stop=%d start=%d, want graceful stop then start", p.scStops, p.scStarts)
		}
		if p.spawnCalls != 0 || p.systemctlCalls != 0 {
			t.Fatalf("windows-service rollback must not spawn/systemctl: spawn=%d ctl=%d", p.spawnCalls, p.systemctlCalls)
		}
		if len(p.killedPIDs) != 0 {
			t.Fatalf("service process must not be hard-killed (failure-recovery race), killed=%v", p.killedPIDs)
		}
		if string(mustRead(t, cur)) != "OLD" {
			t.Fatal("backup not restored")
		}
	})

	t.Run("launchd", func(t *testing.T) {
		p := stubRestartSeams(t)
		stubUpdateLogger(t)
		t.Setenv(envUpdateSupervise, string(superviseLaunchd))
		// PID 文件候选第三项回落 config.DataDir()，钉空目录隔离宿主实况
		t.Setenv("CC_DATA_DIR", "")
		t.Setenv("SC_DATA_DIR", "")
		t.Setenv("CC_DATA_DIR", t.TempDir())
		dd := t.TempDir()
		cur := filepath.Join(dd, "codecombo")
		_ = os.WriteFile(cur, []byte("NEW"), 0755)
		_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
		_ = os.WriteFile(filepath.Join(dd, "codecombo.pid"), []byte("2147483000\n9999\n"), 0644)
		ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", port: 9999, dd: dd}

		ctx.killAndRollback("health check failed")

		// 顺序关键：恢复先于击杀（KeepAlive 重拉必捡旧包），PID 来自 PID 文件
		if string(mustRead(t, cur)) != "OLD" {
			t.Fatal("backup not restored before killing relaunched process")
		}
		if !intContains(p.killedPIDs, 2147483000) {
			t.Fatalf("killed = %v, want relaunched pid from pid file", p.killedPIDs)
		}
		if p.spawnCalls != 0 || p.scStarts != 0 || p.systemctlCalls != 0 || p.scStops != 0 {
			t.Fatalf("launchd rollback must hand over to KeepAlive: spawn=%d sc=%d ctl=%d stop=%d",
				p.spawnCalls, p.scStarts, p.systemctlCalls, p.scStops)
		}
	})
}

// TestReadRunningPid PID 文件首行读取：新名/旧名/缺失与坏行回落。
// CC_DATA_DIR 钉到空目录隔离宿主实况（TestReadPIDLoopbackPortCandidates 同款
// ——候选第三项回落 config.DataDir()，不隔离会读到宿主真实实例的 PID）
func TestReadRunningPid(t *testing.T) {
	t.Setenv("CC_DATA_DIR", "")
	t.Setenv("SC_DATA_DIR", "")
	t.Setenv("CC_DATA_DIR", t.TempDir())
	dd := t.TempDir()
	if got := readRunningPid(dd); got != 0 {
		t.Fatalf("missing pid file: got %d, want 0", got)
	}
	_ = os.WriteFile(filepath.Join(dd, "codecombo.pid"), []byte("4321\n9999\n18000\nhttp\n"), 0644)
	if got := readRunningPid(dd); got != 4321 {
		t.Fatalf("first line = %d, want 4321", got)
	}
	_ = os.WriteFile(filepath.Join(dd, "codecombo.pid"), []byte("not-a-pid\n"), 0644)
	if got := readRunningPid(dd); got != 0 {
		t.Fatalf("bad line: got %d, want 0", got)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

func intContains(list []int, want int) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
