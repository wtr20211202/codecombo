package terminal

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// D 帧等待原语单测（P-20261004-108 运行书服务端执行的退出码等待）：
// 解析/投递/超时/集成在位判据 + 真实 PTY 下的写入→等待闭环（RunbookPanel e2e
// 已证 shell 集成链路，这里锁的是原语本身的三平台共享语义）。

func TestParseOscDExit(t *testing.T) {
	cases := []struct {
		payload string
		want    int
	}{
		{"D;0;1234", 0},
		{"D;7;50", 7},
		{"D;127;0", 127},
		{"D", 0},       // 无分节（形态异常）：D 帧即结束事实，退出码回 0 不误判超时
		{"D;abc;1", 0}, // 非数字
		{"D;;1", 0},    // 空段
		{"DX", 0},      // 无分节符
	}
	for _, c := range cases {
		if got := parseOscDExit([]byte(c.payload)); got != c.want {
			t.Errorf("parseOscDExit(%q) = %d, want %d", c.payload, got, c.want)
		}
	}
}

func TestWaitDFrameDeliversExitCode(t *testing.T) {
	d := newOscStateDetector()
	done := make(chan struct{})
	var got int
	var ok bool
	go func() {
		got, ok = d.WaitDFrame(2 * time.Second)
		close(done)
	}()
	// 等注册先行（map 写入在锁内，这里给调度一个窗口再喂帧）
	time.Sleep(50 * time.Millisecond)
	d.feed([]byte("\x1b]133;C\x07some output\x1b]133;D;7;42\x07"))
	select {
	case <-done:
		if !ok || got != 7 {
			t.Fatalf("WaitDFrame = (%d, %v), want (7, true)", got, ok)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("WaitDFrame timed out waiting for test")
	}
	// D 后运行态熄灭、帧判据点亮
	if running, _ := d.snapshot(); running {
		t.Error("running should be false after D frame")
	}
	if !d.FramesSeen() {
		t.Error("FramesSeen should be true after C/D frames")
	}
}

func TestWaitDFrameTimeout(t *testing.T) {
	d := newOscStateDetector()
	start := time.Now()
	code, ok := d.WaitDFrame(80 * time.Millisecond)
	if ok {
		t.Fatalf("expected timeout, got exit %d", code)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timeout waited too long: %v", elapsed)
	}
	// 超时返回后等待者表应清空（不泄漏条目）
	d.mu.Lock()
	n := len(d.dWaiters)
	d.mu.Unlock()
	if n != 0 {
		t.Fatalf("waiter table should be empty after timeout, got %d", n)
	}
}

func TestWaitDFrameMissesPriorFrame(t *testing.T) {
	// D 帧先于注册到达：等待者只等「未来的帧」——归属按到达序，这是与前端
	// 执行器同粗糙度的已知边界（调用方写命令后立即等待，错过窗口微秒级）
	d := newOscStateDetector()
	d.feed([]byte("\x1b]133;D;7;1\x07"))
	if _, ok := d.WaitDFrame(80 * time.Millisecond); ok {
		t.Fatal("waiter must not consume a D frame that arrived before registration")
	}
}

func TestWaitDFrameSuppressesPromptD(t *testing.T) {
	// 启动期 D（前面是 A 提示符开始帧，不是 C）不投递等待方：shellint 在每次
	// 提示符渲染前都发 D（含 shell 启动后首个 prompt 的 D;0），不设闸会把
	// 退出码等待链错位一格（步骤 N 收到步骤 N-1 的退出码，实测踩坑）。
	// 等待方跳过被抑制的启动 D，继续等首条命令自己的 D
	d := newOscStateDetector()
	done := make(chan struct{})
	var got int
	var ok bool
	go func() {
		got, ok = d.WaitDFrame(2 * time.Second)
		close(done)
	}()
	time.Sleep(50 * time.Millisecond)
	// 启动序列：A → D;0;0（首个 prompt）→ 之后才是首条命令的 E/C/D
	d.feed([]byte("\x1b]133;A\x07\x1b]133;D;0;0\x07\x1b]133;E;ZWNobyBh\x07\x1b]133;C\x07out\x1b]133;D;5;12\x07"))
	select {
	case <-done:
		if !ok || got != 5 {
			t.Errorf("waiter should catch the post-C D (5), got (%d, %v)", got, ok)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("test timed out")
	}
	// 纯启动序列（A → D;0;0 后无命令）：等待方不被启动 D 提前放行
	d2 := newOscStateDetector()
	d2.feed([]byte("\x1b]133;A\x07\x1b]133;D;0;0\x07"))
	if _, ok := d2.WaitDFrame(100 * time.Millisecond); ok {
		t.Error("waiter must not be released by a prompt-only D")
	}
}

func TestFramesSeenRequiresRealFrames(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte("plain output, no frames"))
	if d.FramesSeen() {
		t.Error("plain output must not count as frames")
	}
	d.feed([]byte("\x1b]133;C\x07"))
	if !d.FramesSeen() {
		t.Error("C frame should light FramesSeen")
	}
}

// TestSessionWaitCommandExitRealPty 真实 PTY（Windows ConPTY / Unix creack-pty）
// 下的原语闭环：shell 集成会话写 echo → 等到 D 帧 → 退出码 0。shell 集成注入
// 链路（bash/powershell 双形态）由既有 e2e 背书，这里锁服务端等待面
func TestSessionWaitCommandExitRealPty(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	s, err := DefaultManager.CreateSession("osc-wait-repro", "osc-wait", t.TempDir(), "", true)
	if err != nil {
		t.Skipf("real pty unavailable: %v", err)
	}
	// Kill 而非 CloseSession：tmux 后端的 Close 只杀 attach 连接，底层
	// tmux session 按「持久化跨重启」产品语义存活——测试会话必须整炉清掉，
	// 否则残留 sc-e3b0c442-* 会话成为（本包或并行二进制）RecoverSessions
	// 孤儿清扫的靶子，反过来打断后续测试
	t.Cleanup(func() {
		if session := DefaultManager.GetSession("osc-wait-repro"); session != nil {
			session.Kill()
		}
	})

	// 先用探针命令等到一个「可投递的 C/D 闭环」再发目标命令，不盲睡也不只看
	// framesSeen。三个平台/环境差异都会表现为「命令跑了但没有可投递 D」
	// （Linux/慢 attach 环境实测，Windows ConPTY 无此形态）：
	//   1. 固定时长盲睡的原始形态：bash 先跑完 rcfile 才读交互输入，命令本身
	//      不会早于钩子执行；但启动后第一条真命令会被 bash.sh DEBUG trap 的
	//      in_prompt 保护吞噬（宁漏记不误记的保守设计）——没有 C 帧前导的 D
	//      被 oscstate cmdActive 闸扣住不投递等待方，恰好是首跑
	//      「no D frame within timeout (framesSeen=true)」的失败形态（precmd
	//      每次渲染提示符都发 D，framesSeen 已点亮但等待方永远等不到投递）；
	//   2. tmux 不回放 attach 前的 pane 转义序列（重绘只恢复可见网格）——
	//      启动期 A/D 帧在慢 attach 下整体丢失，shell 空闲后不再渲染新提示符；
	//   3. 首条命令吞噬是否发生随 HISTCMD/prompt_histcmd 取值漂移，固定命令
	//      序列无法保证第 N 条一定自愈。
	// 处置：持续发探针命令直到 WaitCommandExit 真正投递一次（一条被吞下一条
	// 自愈——保护靠 HISTCMD 递增解除），闭环成立即钩子就位 + attach 完成 +
	// 保护已解除，目标命令的 C/D 稳定可达。三平台语义一致，不引入 skip。
	deadline := time.Now().Add(30 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatalf("shell integration never produced a dispatchable C/D cycle within 30s (framesSeen=%v)——钩子未装好/首命令吞噬未自愈/attach 帧丢失，三态排查", s.OscFramesSeen())
		}
		_ = s.WriteInput([]byte("true\r"))
		if _, ok := s.WaitCommandExit(3 * time.Second); ok {
			break
		}
	}
	if err := s.WriteInput([]byte("echo sc-osc-wait\r")); err != nil {
		t.Skipf("session not writable: %v", err)
	}
	code, ok := s.WaitCommandExit(15 * time.Second)
	if !ok {
		t.Fatalf("no D frame within timeout (framesSeen=%v)", s.OscFramesSeen())
	}
	if code != 0 {
		t.Fatalf("echo exit code = %d, want 0", code)
	}
	if !s.OscFramesSeen() {
		t.Error("OscFramesSeen should be true after echo ran")
	}
}
