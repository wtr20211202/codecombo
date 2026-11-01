package terminal

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 终端 shell 选择（P-20261004-57）单测：设置读取 / 缺省回落 / 自定义路径校验 /
// 会话级覆盖优先级 / 候选探测去重。真实 PTY 会话创建链的落点用例见文件尾
//（PTY 不可用环境 skip，与 idle_realpty_test 同款边界）

// setShellSetting 装配独立 store 并写入 terminalDefaultShell（getShell 读设置
// 走 store.Get().Settings.Get()，测试间互不串扰靠 SetDefault 换实例）。
// 注意 Settings.Get() 对 fresh store 会回落并缓存 config.Load() 单例指针
// （settings.go settingsRepo.Get 的 legacy fallback）——原地改字段就是改全局
// 单例，不恢复会把值泄漏给同进程后续所有测试（-count=2 或同包后跑的会话类
// 测试拿到被改值，会话起在错误 shell 上；曾让 oscstate_wait 真实 PTY 用例
// 在 Linux 稳定失败），cleanup 必须还原字段原值
func setShellSetting(t *testing.T, v string) {
	t.Helper()
	st := store.New(filestore.New(t.TempDir()))
	store.SetDefault(st)
	t.Cleanup(func() { store.SetDefault(nil) })
	cfg := st.Settings.Get()
	prev := cfg.Server.TerminalDefaultShell
	t.Cleanup(func() { cfg.Server.TerminalDefaultShell = prev })
	cfg.Server.TerminalDefaultShell = v
	if err := st.Settings.Save(); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

// validShellPath 一个保证存在且可执行的本地二进制（测试二进制自身）——
// 只验 LookPath 解析，不在纯单测里真实拉起
func validShellPath(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("os.Executable unavailable: %v", err)
	}
	return exe
}

func TestValidateShellPath(t *testing.T) {
	if err := ValidateShellPath(validShellPath(t)); err != nil {
		t.Fatalf("valid path rejected: %v", err)
	}
	// 裸名形态：git 是本仓库硬依赖（构建/测试链都有），PATH 必含
	if _, err := exec.LookPath("git"); err == nil {
		if err := ValidateShellPath("git"); err != nil {
			t.Fatalf("bare name rejected: %v", err)
		}
	}
	if err := ValidateShellPath(filepath.Join(t.TempDir(), "no-such-shell-xyz")); err == nil {
		t.Fatalf("nonexistent path accepted")
	}
	if err := ValidateShellPath("no-such-shell-xyz"); err == nil {
		t.Fatalf("nonexistent bare name accepted")
	}
	if err := ValidateShellPath("  "); err == nil {
		t.Fatalf("empty accepted")
	}
}

// 未配置（零值/无 store）时 getShell 恒等于平台缺省序——存量行为零变化的锚点
func TestGetShellPlatformFallback(t *testing.T) {
	store.SetDefault(nil)
	if got := getShell(); got == "" || got != platformDefaultShell() {
		t.Fatalf("getShell without store = %q, want platformDefaultShell %q", got, platformDefaultShell())
	}

	setShellSetting(t, "")
	if got := getShell(); got != platformDefaultShell() {
		t.Fatalf("getShell with empty setting = %q, want %q", got, platformDefaultShell())
	}
}

// 设置有效 → getShell 采用设置值（裸名/完整路径两种形态）
func TestGetShellReadsSetting(t *testing.T) {
	setShellSetting(t, validShellPath(t))
	if got := getShell(); got != validShellPath(t) {
		t.Fatalf("getShell = %q, want configured %q", got, validShellPath(t))
	}
	if _, err := exec.LookPath("git"); err == nil {
		setShellSetting(t, "git")
		if got := getShell(); got != "git" {
			t.Fatalf("getShell bare name = %q, want git", got)
		}
	}
}

// 设置失效（二进制消失）→ getShell 降级平台缺省，不阻塞会话创建
func TestGetShellFallsBackWhenSettingBroken(t *testing.T) {
	setShellSetting(t, filepath.Join(t.TempDir(), "uninstalled-shell"))
	if got := getShell(); got != platformDefaultShell() {
		t.Fatalf("getShell with broken setting = %q, want fallback %q", got, platformDefaultShell())
	}
}

// 会话级覆盖优先级：覆盖 > 设置 > 平台缺省；失效覆盖降级不阻塞
func TestResolveSessionShell(t *testing.T) {
	setShellSetting(t, validShellPath(t))

	// 覆盖非空 → 压过设置
	if got := ResolveSessionShell("git"); got != "git" {
		t.Fatalf("override ignored: = %q, want git", got)
	}
	// 覆盖空 → 跟随设置
	if got := ResolveSessionShell(""); got != validShellPath(t) {
		t.Fatalf("empty override = %q, want setting %q", got, validShellPath(t))
	}
	// 覆盖失效 → 降级 getShell（设置有效取设置），宁回落不挂
	if got := ResolveSessionShell(filepath.Join(t.TempDir(), "gone-shell")); got != validShellPath(t) {
		t.Fatalf("broken override = %q, want fallback %q", got, validShellPath(t))
	}
}

// 候选探测：非空、含平台缺省（可用）、无重复、全字段形状
func TestShellCandidates(t *testing.T) {
	cands := ShellCandidates()
	if len(cands) == 0 {
		t.Fatalf("candidates empty")
	}
	def := platformDefaultShell()
	defPath, _ := exec.LookPath(def)
	seen := map[string]bool{}
	hasDefault := false
	for _, c := range cands {
		if c.Name == "" {
			t.Fatalf("candidate with empty name: %+v", c)
		}
		if c.Available && c.Path == "" {
			t.Fatalf("available candidate without path: %+v", c)
		}
		key := c.Name + "\x00" + c.Path
		if seen[key] {
			t.Fatalf("duplicate candidate: %+v", c)
		}
		seen[key] = true
		// 平台缺省必须出现在可用候选里（Windows 路径大小写不敏感，EqualFold
		// 对账；unix 侧精确相等，EqualFold 最坏是宽容命中，探测面无害）
		if c.Available && defPath != "" && strings.EqualFold(c.Path, defPath) {
			hasDefault = true
		}
	}
	if !hasDefault {
		t.Fatalf("platform default %q (%s) not among available candidates: %+v", def, defPath, cands)
	}
}

// 真实会话创建链的 shell 落点：覆盖压过缺省、设置驱动缺省（PTY 不可用 skip，
// 与 idle_realpty_test 同款边界）
func TestCreateSessionShellOverrideRealPty(t *testing.T) {
	shell := "sh"
	if runtime.GOOS == "windows" {
		shell = "cmd"
	}
	if _, err := exec.LookPath(shell); err != nil {
		t.Skipf("%s unavailable: %v", shell, err)
	}

	// ① 无设置：会话覆盖压过平台缺省
	setShellSetting(t, "")
	s, err := DefaultManager.CreateSessionWithShell("shell-ovr-1", "ovr", t.TempDir(), "", false, shell)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	if got := s.ShellPath(); got != shell {
		t.Fatalf("override session shell = %q, want %q", got, shell)
	}
	DefaultManager.CloseSession("shell-ovr-1")

	// ② 无覆盖：创建链读设置（terminalDefaultShell）作为缺省
	setShellSetting(t, shell)
	s2, err := DefaultManager.CreateSessionWithShell("shell-ovr-2", "set", t.TempDir(), "", false, "")
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	if got := s2.ShellPath(); got != shell {
		t.Fatalf("setting-driven session shell = %q, want %q", got, shell)
	}
	DefaultManager.CloseSession("shell-ovr-2")
}
