package shellint

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// oscERe 匹配裸 OSC 133 E 帧（tmux DCS 包装场景不在此测试范围）
var oscERe = regexp.MustCompile("\x1b\\]133;E;([A-Za-z0-9+/=]*)\x07")

// oscCRe 匹配 OSC 133 C 帧（命令开始）
var oscCRe = regexp.MustCompile("\x1b\\]133;C\x07")

// extractECommands 从终端字节流提取全部 E 帧并 base64 解码为命令文本
func extractECommands(t *testing.T, out string) []string {
	t.Helper()
	matches := oscERe.FindAllStringSubmatch(out, -1)
	cmds := make([]string, 0, len(matches))
	for _, m := range matches {
		data, err := base64.StdEncoding.DecodeString(m[1])
		if err != nil {
			t.Fatalf("E frame is not valid base64: %q", m[1])
		}
		cmds = append(cmds, string(data))
	}
	return cmds
}

// toPosixPath 把 Windows 路径转为 msys/bash 可读的 POSIX 形式（D:\a\b → /d/a/b）
func toPosixPath(p string) string {
	p = filepath.ToSlash(p)
	if len(p) >= 2 && p[1] == ':' {
		return "/" + strings.ToLower(p[:1]) + p[2:]
	}
	return p
}

// runBashDriver 用 `bash -i <driver>` 驱动测试：driver = bash.sh 全文 + 一轮
// precmd 模拟 + 追加命令体。
// -i script 模式下 DEBUG trap 与 history 正常工作（E 帧可测），
// 但 PROMPT_COMMAND 不执行（D/A 帧与 precmd 钩子链路需真实 PTY，另行手动验证）。
// 显式补一轮 __simple_coding_precmd：真实会话首条命令前必然经过首个
// PROMPT_COMMAND 周期（bash.sh 安装期即置 in_prompt 保护，见 bash.sh 内注释），
// 无该周期则保护永不解除、body 命令全被拦——模拟之使断言贴近真实时序。
// 该模拟行的记账被武装期 precmd 分支无条件拦下（P-20261003-326 判据），
// 历史 dance（set +o/-o history 夹层）已移除：安装期语句由 installing+武装门
// 拦截无需关记录，而「恢复记录」的裸行紧贴 precmd 的 HISTCMD-1 校准——判据
// 按设计必记校准后的第一条命令，机械行踩上该槽位即幻影帧（WSL 5.2.21 与
// msys 5.2.26 -i 实测一致，2026-10-09）。
// HISTFILE 经 exec env 指向 /dev/null：隔离宿主 history（-i 启动即读 HISTFILE，
// 写在 driver 首行为时已晚——宿主 .bash_history 尾条目会以 fc 顶行/HISTCMD
// 基线污染帧判据，WSL 实测 hist≈503 起步）。
// bash 不存在时跳过（如部分 CI 环境无 bash）。
//
// 注：P-20261007-03 曾在此半途引入「天文数字 HISTCMD 基线注入」（instrumented
// 变量构建后未使用，包整体编译失败；实测接入后幻影照旧——注入瞄准的算术去重
// 闸已被 P-326 元组闸取代，注入形态未经任何平台实跑验证），本次按「最后可编译
// 且双平台实证」形态摘除半成品——如需注入须带双平台实跑证据另行落地。
func runBashDriver(t *testing.T, body string) string {
	t.Helper()
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available in PATH")
	}
	script, err := os.ReadFile("bash.sh")
	if err != nil {
		t.Fatalf("read bash.sh: %v", err)
	}
	driver := filepath.Join(t.TempDir(), "driver.sh")

	// CRLF 归一（Linux 门禁实锚）：.gitattributes 已强制 *.sh / *.go eol=lf，但
	// 属性生效前检出的陈旧工作区（w/crlf）不会被 git 自动重刷——msys bash 容忍
	// CRLF（Windows 侧测试照绿），WSL bash 5.2 对 CRLF 脚本直接 syntax error
	// exit 2（实测 bash.sh 21 行 `__simple_coding_osc() {` 处炸）。测试源文件的
	// raw string body 同理携带文件本身的行尾。驱动文件由本测试落盘、完全自持，
	// 归一后不再随检出形态漂移
	normalizeEol := func(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }
	// HISTFILE 指向空文件：隔离宿主 history 写入（.bash_history 中旧命令可能
	// 影响 fc 基线；已载入内存的宿主条目无法卸载，断言须对其计数不敏感）
	content := "HISTFILE=/dev/null\n" + normalizeEol(string(script)) + "\n{ __simple_coding_precmd; }\n" + normalizeEol(body)
	if err := os.WriteFile(driver, []byte(content), 0644); err != nil {
		t.Fatalf("write driver: %v", err)
	}
	cmd := exec.Command(bashPath, "--noprofile", "--norc", "-i", toPosixPath(driver))
	// HISTFILE 必须先于 bash 启动生效（见上）：追加而非覆盖继承环境
	cmd.Env = append(os.Environ(), "HISTFILE=/dev/null")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("run bash driver: %v\nstdout:\n%q", err, out)
	}
	return string(out)
}

// TestBashOSC133EEvents 整行命令文本回传：
// - 简单命令 / 管道 / for 循环均回传整行（BASH_COMMAND 只有子命令文本，整行取自 fc）
// - 复合命令多次 DEBUG trap 以 HISTCMD 去重，仅产生一帧
// - 安装期（rcfile 等价场景）不产生假 E 帧
func TestBashOSC133EEvents(t *testing.T) {
	out := runBashDriver(t, `
echo hello
echo left | cat
for i in 1 2; do echo iter $i; done
`)
	cmds := extractECommands(t, out)
	want := []string{"echo hello", "echo left | cat", "for i in 1 2; do echo iter $i; done"}
	if !reflect.DeepEqual(cmds, want) {
		t.Errorf("E frames mismatch:\n got: %q\nwant: %q", cmds, want)
	}
	// C 帧与 E 帧一一成对
	if got := len(oscCRe.FindAllString(out, -1)); got != len(want) {
		t.Errorf("expected %d C frames, got %d", len(want), got)
	}
}

// TestBashOSC133PrecmdGuard precmd 保护与自愈：
// - precmd 内部命令（date 命令替换）不得产生额外 C/E 帧
// - in_prompt 保护在下一条命令（HISTCMD 递增）到达时自愈解除
// 注意：-i script 模式下 `__simple_coding_precmd` 是显式命令行，自身合法产生一帧
func TestBashOSC133PrecmdGuard(t *testing.T) {
	out := runBashDriver(t, `
echo first
__simple_coding_precmd
echo second
`)
	cmds := extractECommands(t, out)
	want := []string{"echo first", "__simple_coding_precmd", "echo second"}
	if !reflect.DeepEqual(cmds, want) {
		t.Errorf("E frames mismatch:\n got: %q\nwant: %q", cmds, want)
	}
}

// TestBashOSC133ETruncation 超长命令截断 8KB（base64 前先截原始字节）
func TestBashOSC133ETruncation(t *testing.T) {
	long := "echo " + strings.Repeat("a", 9000)
	out := runBashDriver(t, "\n"+long+"\n")
	cmds := extractECommands(t, out)
	if len(cmds) != 1 {
		t.Fatalf("expected 1 E frame, got %d: %q", len(cmds), cmds)
	}
	if len(cmds[0]) != 8192 {
		t.Errorf("expected truncated to 8192 bytes, got %d", len(cmds[0]))
	}
	if !strings.HasPrefix(cmds[0], "echo aaaa") {
		t.Errorf("truncated command should keep prefix, got %q...", cmds[0][:20])
	}
}

// TestBashOSC133UTF8Command 多字节命令文本（中文）经 base64 往返无损
func TestBashOSC133UTF8Command(t *testing.T) {
	out := runBashDriver(t, `
echo 你好世界
`)
	cmds := extractECommands(t, out)
	want := []string{"echo 你好世界"}
	if !reflect.DeepEqual(cmds, want) {
		t.Errorf("E frames mismatch:\n got: %q\nwant: %q", cmds, want)
	}
}
