//go:build !windows

package terminal

// OSC 133 shell 集成注入的全链回归（P-20261004-82）：真实 PTY 起 shell
// （shellIntegration=true 走 shellint.Setup 挂载）→ 敲一条命令 → 断言 C/D/E/A
// 帧出现在会话输出字节流（前端 OSC 消费族与 P-63 服务端 oscState 的共同源头）。
//
// 为什么需要本文件：shellint/bash_test.go 以 `bash -i driver` 驱动，PROMPT_COMMAND
// 不执行（见其文件头注释），D/A 帧链路从未被单测覆盖——「Linux bash 帧不产出」
// 的误判因此潜伏数周，5 个前端 e2e spec 被 serverIsLinux 守卫整族跳过。本文件
// 用真实 PTY（unix creack/pty）补上该缺口，守卫解除后有回归即在此暴露。
// Windows 侧同链路由 e2e 全量覆盖（ConPTY + PowerShell 无 skip），不依赖本文件。

import (
	"encoding/base64"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

var (
	osc133ARe = regexp.MustCompile("\x1b\\]133;A\x07")
	osc133CRe = regexp.MustCompile("\x1b\\]133;C\x07")
	osc133DRe = regexp.MustCompile("\x1b\\]133;D;")
	// E 帧 payload 允许可选参数位（截断标记等），捕获 base64 段
	osc133ERe = regexp.MustCompile("\x1b\\]133;E;([A-Za-z0-9+/=]*)\x07")
)

// byteRing 聚合会话输出：帧可能跨 4KB 读块分片（readLoop 分片），全量累积后
// 再做终态断言，规避重组时序
type byteRing struct {
	mu sync.Mutex
	b  []byte
}

func (r *byteRing) write(d []byte) {
	r.mu.Lock()
	r.b = append(r.b, d...)
	r.mu.Unlock()
}

func (r *byteRing) snapshot() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.b)
}

// waitContains 轮询直到输出含 needle（shell 启动/命令执行在 CI 负载下秒级抖动）
func (r *byteRing) waitContains(t *testing.T, needle string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(r.snapshot(), needle) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timeout (%v) waiting for %q in session output (%d bytes):\n%q",
		timeout, needle, len(r.snapshot()), r.snapshot())
}

func TestOSC133RealPtyFramesNative(t *testing.T) {
	testOSC133RealPtyFrames(t, "native")
}

func TestOSC133RealPtyFramesTmux(t *testing.T) {
	if !isTmuxAvailable() {
		t.Skip("tmux unavailable (<3.3 or not installed)")
	}
	testOSC133RealPtyFrames(t, "tmux")
}

func testOSC133RealPtyFrames(t *testing.T, backend string) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 钉 bash：getShell() 取 $SHELL，环境可能是 zsh/fish 等——本用例断言的是
	// bash 形态的 OSC 133 字节序（帧格式三 shell 一致，但命令文本时序不同）
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available in PATH")
	}
	t.Setenv("SHELL", bashPath)

	cfg := store.Get().Settings.Get()
	if cfg == nil {
		t.Fatal("settings not initialized")
	}
	cfg.Server.TerminalBackend = backend
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatal(err)
	}

	s, err := DefaultManager.CreateSession("osc133-realpty", "repro", t.TempDir(), "", true)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	t.Cleanup(func() { DefaultManager.CloseSession(s.ID) })

	ring := &byteRing{}
	cancel := s.OnOutput(ring.write)
	defer cancel()

	// 不等首个 A 帧再敲命令：tmux 下 attach 首批字节（含 rcfile 安装 A）与
	// OnOutput 登记存在竞态，先到的帧测试侧收不到；命令后的 D/A 必然经已登记
	// 的回调到达。固定静置让 shell 完成启动，再敲命令
	time.Sleep(1500 * time.Millisecond)

	// 命令文本须逐次唯一：bash 侧 HISTCMD 去重对「与上一条完全相同的命令」
	// 天然不记（HISTCONTROL=ignoredups 下甚至不进 history，HISTCMD 不前进），
	// 固定文本会在重跑时静默无 C 帧
	marker := fmt.Sprintf("echo sc-osc133-realpty-%d", time.Now().UnixNano())
	if err := s.WriteInput([]byte(marker + "\r")); err != nil {
		t.Fatalf("write input: %v", err)
	}
	ring.waitContains(t, "\x1b]133;C", 15*time.Second)
	ring.waitContains(t, "\x1b]133;D;", 15*time.Second)

	// E 帧命令文本回传：base64 解码须等于整行命令（前端命令历史/装饰行/自刷新
	// 检测链全部以 E 文本为输入，只认「解码后等值」而非字节在场）
	out := ring.snapshot()
	matches := osc133ERe.FindAllStringSubmatch(out, -1)
	if len(matches) == 0 {
		t.Fatalf("no OSC 133 E frame in output (%d bytes):\n%q", len(out), out)
	}
	var decoded []string
	for _, m := range matches {
		if raw, err := base64.StdEncoding.DecodeString(m[1]); err == nil {
			decoded = append(decoded, string(raw))
		}
	}
	found := false
	for _, d := range decoded {
		if strings.Contains(d, marker) {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("E frames decoded %v, none contains %q\nfull output:\n%q", decoded, marker, out)
	}
	// A 帧在命令后仍有产出（新 prompt）：precmd 链未因首命令中断
	if !osc133ARe.MatchString(out) || !osc133CRe.MatchString(out) || !osc133DRe.MatchString(out) {
		t.Fatalf("frame family incomplete (A/C/D must all be present):\n%q", out)
	}
}
