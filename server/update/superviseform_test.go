package update

import (
	"strings"
	"testing"
)

// SuperviseForm 只读诊断投影：返回值必须落在已知形态集内（诊断包/前端按
// 稳定键分支），且 npm wrapper 形态的 env+ppid 双守卫判定与页面重启链同口径。
func TestSuperviseFormKnownValues(t *testing.T) {
	form, _ := SuperviseForm()
	switch form {
	case "windows-service", "npm-wrapper", "systemd", "launchd", "bare":
	default:
		t.Fatalf("SuperviseForm returned unknown form %q", form)
	}
}

// npm wrapper 形态：env 下发自身 PID 且 ppid 相符 → npm-wrapper（判别文案带
// parent pid，排障时能直接对账进程树）
func TestSuperviseFormNpmWrapper(t *testing.T) {
	orig := getppidFn
	t.Cleanup(func() { getppidFn = orig })
	getppidFn = func() int { return 4242 }
	t.Setenv(EnvWrapperPid, "4242")

	form, detail := SuperviseForm()
	if form != "npm-wrapper" {
		t.Fatalf("form = %q, want npm-wrapper", form)
	}
	if !strings.Contains(detail, "4242") {
		t.Fatalf("detail = %q, want parent pid echoed", detail)
	}
}

// 守护/裸进程形态：env 在场但 ppid 不符（继承自 wrapper 的守护进程）→ 不判
// npm-wrapper（双守卫的防误判面，app.go 重启链同口径）
func TestSuperviseFormWrapperEnvWithoutParent(t *testing.T) {
	orig := getppidFn
	t.Cleanup(func() { getppidFn = orig })
	getppidFn = func() int { return 999 }
	t.Setenv(EnvWrapperPid, "4242")

	form, _ := SuperviseForm()
	if form == "npm-wrapper" {
		t.Fatal("wrapper env without a matching parent must not be classified as npm-wrapper")
	}
}
