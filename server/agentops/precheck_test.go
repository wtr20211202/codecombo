package agentops

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"codecombo/server/config"
	"codecombo/server/userbin"
)

// 创建前预检（P-20261003-79）单测：缺失/版本快检失败二分类、稳定标记原文、
// 路径形态豁免、真实二进制放行。userbin 失败结论缓存 30s 会跨用例串扰，
// 探测类用例开头清缓存

func TestPrecheckCommandMissing(t *testing.T) {
	userbin.ResetCache()
	defer userbin.ResetCache()

	_, err := PrecheckCommand("e2e-no-such-rt", "sc-precheck-definitely-missing-bin --flag")
	var pe *PrecheckError
	if !errors.As(err, &pe) || !pe.Missing {
		t.Fatalf("want PrecheckError missing, got %v", err)
	}
	// 稳定标记是对外契约（web/src/api/http.ts KNOWN_ERROR_I18N 按原文匹配）
	want := "runtime e2e-no-such-rt is not installed or not in the service process PATH"
	if pe.Error() != want {
		t.Fatalf("Error() = %q, want %q", pe.Error(), want)
	}
	if pe.Unwrap() != nil {
		t.Fatalf("缺失类不应携带底层错误，got %v", pe.Unwrap())
	}
}

func TestPrecheckCommandVersionFail(t *testing.T) {
	userbin.ResetCache()
	defer userbin.ResetCache()

	old := versionProbe
	versionProbe = func(string, time.Duration) (string, error) { return "", errors.New("exit status 1") }
	t.Cleanup(func() { versionProbe = old })

	// git 各平台测试环境必备（存在），仅快检失败 → version 类而非缺失类
	_, err := PrecheckCommand("git", "git")
	var pe *PrecheckError
	if !errors.As(err, &pe) || pe.Missing {
		t.Fatalf("want PrecheckError version-fail, got %v", err)
	}
	if !strings.HasPrefix(pe.Error(), "runtime git failed version quick check") {
		t.Fatalf("Error() = %q, want 前缀 runtime git failed version quick check", pe.Error())
	}
	if pe.Unwrap() == nil || !strings.Contains(pe.Unwrap().Error(), "exit status 1") {
		t.Fatalf("version 类应保留底层错误供诊断，got %v", pe.Unwrap())
	}
}

func TestPrecheckCommandHealthyBinaryPasses(t *testing.T) {
	userbin.ResetCache()
	defer userbin.ResetCache()

	// 真实执行路径（非注入桩）：git --version 各平台必过
	if _, err := PrecheckCommand("git", "git"); err != nil {
		t.Fatalf("健康二进制应放行，got %v", err)
	}
}

// 预检顺取版本（P-20261003-134）：健康结论随同一次 --version 子进程带回输出
// 首行；解析失败（无输出）容忍为空值，不影响放行
func TestPrecheckCommandCapturesVersionLine(t *testing.T) {
	userbin.ResetCache()
	defer userbin.ResetCache()

	old := versionProbe
	versionProbe = func(string, time.Duration) (string, error) {
		return "2.1.3 (Claude Code)", nil
	}
	t.Cleanup(func() { versionProbe = old })

	v, err := PrecheckCommand("git", "git")
	if err != nil {
		t.Fatalf("健康二进制应放行，got %v", err)
	}
	if v != "2.1.3 (Claude Code)" {
		t.Fatalf("version = %q, want 2.1.3 (Claude Code)", v)
	}

	// 探测成功但无输出（解析失败容忍）：空值放行不报错
	versionProbe = func(string, time.Duration) (string, error) { return "", nil }
	if v, err := PrecheckCommand("git", "git"); err != nil || v != "" {
		t.Fatalf("空输出应容忍为空值放行，got (%q, %v)", v, err)
	}
}

// firstVersionLine 首行解析：stdout 优先 stderr 兜底、跳过空行、去首尾空白、
// 超长截断（防御包装脚本任意输出经 meta 与快照载荷扩散）
func TestFirstVersionLine(t *testing.T) {
	cases := []struct {
		name string
		out  []string
		want string
	}{
		{"stdout 首选", []string{"2.1.3\nother\n", "err-line\n"}, "2.1.3"},
		{"stdout 空行跳过取次行", []string{"\n  v2.0  \n"}, "v2.0"},
		{"stdout 全空回落 stderr", []string{"", "1.2.3\n"}, "1.2.3"},
		{"全空返回空串", []string{"", "  \n"}, ""},
		{"无参数返回空串", nil, ""},
	}
	for _, tc := range cases {
		if got := firstVersionLine(tc.out...); got != tc.want {
			t.Fatalf("%s: firstVersionLine = %q, want %q", tc.name, got, tc.want)
		}
	}
	long := strings.Repeat("x", runtimeVersionMaxRunes+50)
	got := firstVersionLine(long)
	if got[:3] != "xxx" || !strings.HasSuffix(got, "…") {
		t.Fatalf("超长首行应截断加省略号，got len=%d", len([]rune(got)))
	}
	if n := utf8.RuneCountInString(got); n != runtimeVersionMaxRunes+1 {
		t.Fatalf("截断宽度 = %d rune, want %d+省略号", n, runtimeVersionMaxRunes)
	}
}

func TestPrecheckRuntimePathFormSkipped(t *testing.T) {
	cleanupCustomAgents(t)
	// 包装脚本绝对/相对路径形态：探测本就不可达，原样启动是既有承诺——
	// 即使二进制不存在也不拦。路径分隔符用 filepath.Join 保证两平台都命中
	// ContainsAny(`/\`) 豁免分支
	cmd := filepath.Join("definitely", "missing", "dir", "wrapper.sh") + " --run"
	SyncCustomAgents([]config.CustomAgent{{Name: "e2e-pathform-rt", Command: cmd}})
	if v, err := PrecheckRuntime("e2e-pathform-rt"); err != nil || v != "" {
		t.Fatalf("路径形态命令应豁免预检且无版本，got (%q, %v)", v, err)
	}
}

func TestPrecheckRuntimeMissingCustomAgent(t *testing.T) {
	cleanupCustomAgents(t)
	userbin.ResetCache()
	defer userbin.ResetCache()

	SyncCustomAgents([]config.CustomAgent{{Name: "e2e-missing-rt", Command: "sc-precheck-missing-bin --serve"}})
	_, err := PrecheckRuntime("e2e-missing-rt")
	var pe *PrecheckError
	if !errors.As(err, &pe) || !pe.Missing {
		t.Fatalf("裸名且二进制缺失应报 missing，got %v", err)
	}
}

func TestPrecheckRuntimeUnknownNameNil(t *testing.T) {
	// 未注册名返回 nil：选型链必回落 auto，由调用方对实际选定者补检
	if v, err := PrecheckRuntime("no-such-registered-rt"); err != nil || v != "" {
		t.Fatalf("未注册名应返回 nil，got (%q, %v)", v, err)
	}
}
