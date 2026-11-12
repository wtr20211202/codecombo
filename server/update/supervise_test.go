package update

// P-20261112-1-S1 env 契约单测：监管形态提示的注入 / 缺省回落 / 两源不一致留痕。
// 全部经取值口注入（环境依赖探测的测试纪律），绝不真实 spawn 换包进程
//（launchUpdateSubprocessFn 注释同款护栏）。本包测试无 t.Parallel，包级插桩安全

import (
	"bytes"
	"log"
	"os"
	"strings"
	"testing"
)

// lastEnvValue 取 env 列表中某键的最后一次出现：exec.Cmd.Env 重复键按 Go
// 1.19+ 末值生效——断言口径与子进程 os.Getenv 实际读到的一致
func lastEnvValue(env []string, key string) string {
	got := ""
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			got = strings.TrimPrefix(kv, key+"=")
		}
	}
	return got
}

// stubUpdateLogger 把包级 updateLogger 指向内存缓冲以断言留痕，测试结束还原
func stubUpdateLogger(t *testing.T) *bytes.Buffer {
	var buf bytes.Buffer
	orig := updateLogger
	updateLogger = log.New(&buf, "", 0)
	t.Cleanup(func() { updateLogger = orig })
	return &buf
}

// TestUpdateSubprocessEnvSuperviseInjection env 契约注入：三形态逐项下发，
// 外部预置的陈旧同名变量以本次下发末值为准
func TestUpdateSubprocessEnvSuperviseInjection(t *testing.T) {
	for _, form := range []superviseForm{superviseWindowsService, superviseLaunchd, superviseBare} {
		t.Setenv(envUpdateSupervise, "stale-hint-from-outer-env")
		env := updateSubprocessEnv("/dd", "v2.0.0", "v1.9.0", form, nil)
		if got := lastEnvValue(env, envUpdateSupervise); got != string(form) {
			t.Fatalf("supervise env = %q, want %q", got, form)
		}
		// 既有契约字段不回归（正名双写各一份）
		if got := lastEnvValue(env, envUpdateDataDir); got != "/dd" {
			t.Fatalf("data dir env = %q, want /dd", got)
		}
		if got := lastEnvValue(env, envUpdateDataDirOld); got != "/dd" {
			t.Fatalf("legacy data dir env = %q, want /dd", got)
		}
	}
}

// TestNewUpdateCmdContract 换包子进程命令契约：argv 列式不经 shell + env
// 契约含监管形态（真实 spawn 由 LaunchUpdateSubprocess 负责，测试不启动）
func TestNewUpdateCmdContract(t *testing.T) {
	cmd := newUpdateCmd("/old/codecombo", "/new/codecombo", 9999, 4321, "/dd", "v2.0.0", "v1.9.0", superviseLaunchd, nil)
	want := []string{"_do_update", "/old/codecombo", "/new/codecombo", "9999", "4321"}
	if len(cmd.Args) != 1+len(want) {
		t.Fatalf("argv = %v, want self + %v", cmd.Args, want)
	}
	for i, w := range want {
		if cmd.Args[i+1] != w {
			t.Fatalf("argv[%d] = %q, want %q", i+1, cmd.Args[i+1], w)
		}
	}
	if got := lastEnvValue(cmd.Env, envUpdateSupervise); got != string(superviseLaunchd) {
		t.Fatalf("supervise env = %q, want launchd", got)
	}
	if got := lastEnvValue(cmd.Env, envUpdatePrevVerOld); got != "v1.9.0" {
		t.Fatalf("legacy prev version env = %q, want v1.9.0", got)
	}
}

// TestCurrentSuperviseForm 主进程形态探测三分支（探测源注入）：服务形态
// 优先于 launchd，其余回落 bare；默认探测实况（go test 宿主非 darwin/非
// SCM 服务）恒 bare——systemd 不在值域，bare 为唯一合法实况回落
func TestCurrentSuperviseForm(t *testing.T) {
	origSvc, origLd := isServiceFn, launchdManagedFn
	t.Cleanup(func() { isServiceFn, launchdManagedFn = origSvc, origLd })

	isServiceFn, launchdManagedFn = func() bool { return true }, func() bool { return true }
	if got := currentSuperviseForm(); got != superviseWindowsService {
		t.Fatalf("form = %q, want windows-service（服务形态优先）", got)
	}

	isServiceFn, launchdManagedFn = func() bool { return false }, func() bool { return true }
	if got := currentSuperviseForm(); got != superviseLaunchd {
		t.Fatalf("form = %q, want launchd", got)
	}

	isServiceFn, launchdManagedFn = func() bool { return false }, func() bool { return false }
	if got := currentSuperviseForm(); got != superviseBare {
		t.Fatalf("form = %q, want bare", got)
	}

	isServiceFn, launchdManagedFn = origSvc, origLd
	if got := currentSuperviseForm(); got != superviseBare {
		t.Fatalf("default detection = %q, want bare", got)
	}
}

// TestSuperviseFromEnvFallback 缺省回落 bare（env 不存在=「旧主进程+新
// _do_update」矩阵，无噪声）与未知值回落 bare（留痕）；契约值按提示路由
func TestSuperviseFromEnvFallback(t *testing.T) {
	origUnit := systemdUnitFn
	t.Cleanup(func() { systemdUnitFn = origUnit })
	systemdUnitFn = func() string { return "" }
	buf := stubUpdateLogger(t)
	t.Cleanup(func() { os.Unsetenv(envUpdateSupervise) })

	os.Unsetenv(envUpdateSupervise)
	if got := superviseFromEnv(); got != superviseBare {
		t.Fatalf("absent env: form = %q, want bare", got)
	}
	if buf.String() != "" {
		t.Fatalf("absent env must not log: %q", buf.String())
	}

	t.Setenv(envUpdateSupervise, "containerd")
	if got := superviseFromEnv(); got != superviseBare {
		t.Fatalf("unknown hint: form = %q, want bare", got)
	}
	if !strings.Contains(buf.String(), "containerd") {
		t.Fatalf("unknown hint not logged: %q", buf.String())
	}

	for _, form := range []superviseForm{superviseWindowsService, superviseLaunchd, superviseBare} {
		buf.Reset()
		t.Setenv(envUpdateSupervise, string(form))
		if got := superviseFromEnv(); got != form {
			t.Fatalf("hint %q: form = %q, want %q", form, got, form)
		}
	}
}

// TestSuperviseFromEnvSelfCheckWins 两源不一致以自查为准并留痕；提示=bare
// （主进程对 systemd 形态的正常下发）不产生不一致噪声
func TestSuperviseFromEnvSelfCheckWins(t *testing.T) {
	origUnit := systemdUnitFn
	t.Cleanup(func() { systemdUnitFn = origUnit })
	systemdUnitFn = func() string { return "codecombo.service" }
	buf := stubUpdateLogger(t)

	t.Setenv(envUpdateSupervise, "launchd")
	if got := superviseFromEnv(); got != superviseSystemd {
		t.Fatalf("form = %q, want systemd（自查优先）", got)
	}
	if !strings.Contains(buf.String(), "launchd") || !strings.Contains(buf.String(), "codecombo.service") {
		t.Fatalf("disagreement not logged: %q", buf.String())
	}

	buf.Reset()
	t.Setenv(envUpdateSupervise, "bare")
	if got := superviseFromEnv(); got != superviseSystemd {
		t.Fatalf("form = %q, want systemd", got)
	}
	if strings.Contains(buf.String(), "disagrees") {
		t.Fatalf("bare hint must not count as disagreement: %q", buf.String())
	}
}

// TestLaunchUpdateSubprocessConsultsForm 下发入口必经形态探测取值口：探针以
// panic 标记调用、newBinary 恒为不存在路径——组装顺序正确则 panic 先于
// Start 触发（不真实 spawn 任何进程）；若接线遗漏则 Start 以文件不存在报错
// 返回，recover 为 nil 即失败
func TestLaunchUpdateSubprocessConsultsForm(t *testing.T) {
	orig := currentSuperviseFormFn
	t.Cleanup(func() { currentSuperviseFormFn = orig })
	fired := false
	currentSuperviseFormFn = func() superviseForm {
		fired = true
		panic("supervise-probe")
	}
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		_ = LaunchUpdateSubprocess("/old/x", t.TempDir()+string(os.PathSeparator)+"no-such-binary", 1, 1, "/dd", "v", "pv")
	}()
	if !fired {
		t.Fatal("supervise form probe never consulted by LaunchUpdateSubprocess")
	}
	if recovered == nil {
		t.Fatal("probe panic did not propagate — env assembly may bypass form detection")
	}
}
