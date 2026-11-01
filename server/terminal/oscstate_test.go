package terminal

import (
	"strings"
	"testing"
	"time"
)

// OSC 133 运行态旁挂单测（P-20261004-63）：帧识别（C/D 推进、E/R/A 无关）、
// tmux DCS 包装形态、跨块分片（全切点表驱动）、异常流边界、Manager 计数口
//（kind 过滤 + 会话清理随动）。探测器纯内存裸构造，不起真实 PTY（本包惯例）。

const (
	testFrameC = "\x1b]133;C\x07"
	testFrameD = "\x1b]133;D;0;123\x07"
	// tmux DCS passthrough 包装（shellint $TMUX 分支的 printf 形态）：
	// \x1bPtmux; + 双倍 ESC + 内层帧 + BEL + ST
	testWrappedC = "\x1bPtmux;\x1b\x1b]133;C\x07\x1b\\"
	testWrappedD = "\x1bPtmux;\x1b\x1b]133;D;0;5\x07\x1b\\"
)

// 8KB 级 E 帧（命令文本 base64）：不改运行态，且其跨块半帧超暂存上限应被放弃
var testFrameE = "\x1b]133;E;" + strings.Repeat("QUJD", 2048) + "\x07"

func mustState(t *testing.T, d *oscStateDetector) (bool, time.Time) {
	t.Helper()
	running, last := d.snapshot()
	return running, last
}

// TestOscStateBasicFrames 基础帧语义：C 点亮 / D 熄灭 / E、R、A 不影响运行态
func TestOscStateBasicFrames(t *testing.T) {
	d := newOscStateDetector()

	if running, last := mustState(t, d); running || !last.IsZero() {
		t.Fatalf("fresh detector must be idle with zero lastCmdAt, got running=%v last=%v", running, last)
	}

	d.feed([]byte("npm run dev\r\nsome output"))
	if running, _ := mustState(t, d); running {
		t.Fatalf("plain output must not light running")
	}

	d.feed([]byte(testFrameC))
	if running, last := mustState(t, d); !running || last.IsZero() {
		t.Fatalf("C frame must light running and stamp lastCmdAt, got running=%v last=%v", running, last)
	}

	// E 帧夹在 C/D 之间（命令文本回传）：运行态保持点亮
	d.feed([]byte(testFrameE))
	if running, _ := mustState(t, d); !running {
		t.Fatalf("E frame must not change running state")
	}

	d.feed([]byte(testFrameD))
	if running, _ := mustState(t, d); running {
		t.Fatalf("D frame must extinguish running")
	}

	// R（重放边界）/ A（提示符）同款无关
	d.feed([]byte("\x1b]133;R\x07\x1b]133;A\x07"))
	if running, _ := mustState(t, d); running {
		t.Fatalf("R/A frames must not light running")
	}
}

// TestOscStateCDEmbeddedInOutput 帧与普通输出混流（真实终端的字节形态）
func TestOscStateCDEmbeddedInOutput(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte("\x1b[36m$\x1b[0m " + testFrameC + "git status\x1b]133;E;Z2l0IHN0YXR1cw==\x07\r\noutput" + testFrameD))
	if running, _ := mustState(t, d); running {
		t.Fatalf("C..D sequence in mixed output must end idle")
	}
}

// TestOscStateCrossChunkSplits 跨块分片：C+D 连续帧按全部切点分块喂入，
// 任意分片方式下最终状态一致（D 已到 = 熄灭）。帧体跨块由暂存拼接承载
func TestOscStateCrossChunkSplits(t *testing.T) {
	stream := "out" + testFrameC + "mid" + testFrameD + "tail"
	for split := 1; split < len(stream); split++ {
		d := newOscStateDetector()
		d.feed([]byte(stream[:split]))
		d.feed([]byte(stream[split:]))
		if running, last := mustState(t, d); running || last.IsZero() {
			t.Fatalf("split@%d: D must extinguish and stamp lastCmdAt, got running=%v last=%v", split, running, last)
		}
	}
}

// TestOscStateCrossChunkCLights 跨块 C 帧：任意切点分块后 C 必然点亮
//（含切在帧头中间 \x1b]1|33;C 的形态）
func TestOscStateCrossChunkCLights(t *testing.T) {
	stream := testFrameC + "after"
	for split := 1; split < len(stream); split++ {
		d := newOscStateDetector()
		d.feed([]byte(stream[:split]))
		d.feed([]byte(stream[split:]))
		if running, _ := mustState(t, d); !running {
			t.Fatalf("split@%d: C frame must light running", split)
		}
	}
}

// TestOscStateWrappedTmuxDCS tmux DCS passthrough 包装形态：内层 ESC 双倍化，
// \x1b]133; 子序列 + BEL 终止不变，字节扫描天然命中；包装帧跨块同理
func TestOscStateWrappedTmuxDCS(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte(testWrappedC))
	if running, _ := mustState(t, d); !running {
		t.Fatalf("wrapped C frame must light running")
	}
	d.feed([]byte(testWrappedD))
	if running, _ := mustState(t, d); running {
		t.Fatalf("wrapped D frame must extinguish running")
	}

	// 包装 C 帧按全部切点分块（含切进 DCS 头与双倍 ESC 之间）
	for split := 1; split < len(testWrappedC); split++ {
		d := newOscStateDetector()
		d.feed([]byte(testWrappedC[:split]))
		d.feed([]byte(testWrappedC[split:]))
		if running, _ := mustState(t, d); !running {
			t.Fatalf("wrapped split@%d: C must light running", split)
		}
	}
}

// TestOscStateLongPayloadNotPending E 帧（8KB payload）跨块半帧超暂存上限：
// 放弃暂存且不改运行态（丢弃无损），不产生无界内存
func TestOscStateLongPayloadNotPending(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte(testFrameC))
	half := len(testFrameE) / 2
	d.feed([]byte(testFrameE[:half])) // E 半帧：payload 远超上限
	if running, _ := mustState(t, d); !running {
		t.Fatalf("E half-frame must not change running state")
	}
	d.feed([]byte(testFrameE[half:]))
	if running, _ := mustState(t, d); !running {
		t.Fatalf("state must stay lit after dropped E frame")
	}
	if d.pendingLen() != 0 {
		t.Fatalf("pending must not retain long payload, got %d bytes", d.pendingLen())
	}
}

// TestOscStateMalformedEscTerminated 异常流：帧被 ESC 截断（无 BEL）不作数，
// 后续正常帧照常识别（ESC 后续扫不被卡死）
func TestOscStateMalformedEscTerminated(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte("\x1b]133;C\x1b")) // ESC 截断的残帧
	if running, _ := mustState(t, d); running {
		t.Fatalf("ESC-truncated frame must not light running")
	}
	d.feed([]byte(testFrameC))
	if running, _ := mustState(t, d); !running {
		t.Fatalf("normal frame after malformed stream must still light running")
	}
}

// TestOscStateMultipleFramesOneChunk 单块多帧（快速连续命令）：逐帧推进，
// 终态由最后一帧决定
func TestOscStateMultipleFramesOneChunk(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte(testFrameC + testFrameD + testFrameC + testFrameC))
	if running, _ := mustState(t, d); !running {
		t.Fatalf("last frame C must leave running lit")
	}
	d.feed([]byte(testFrameD + testFrameD))
	if running, _ := mustState(t, d); running {
		t.Fatalf("D must extinguish")
	}
}

// TestOscStatePendingAcrossThreeChunks 帧头跨三块的分片拼装
//（\x1b]1 | 33;D | ;0;9\x07——极端慢速流）
func TestOscStatePendingAcrossThreeChunks(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte(testFrameC))
	d.feed([]byte("\x1b]1"))
	d.feed([]byte("33;D"))
	d.feed([]byte(";0;9\x07"))
	if running, _ := mustState(t, d); running {
		t.Fatalf("D frame assembled across three chunks must extinguish running")
	}
}

// TestOscStateDivergedTailNotPending 块尾 ESC 后分叉（非 133 序列，如 CSI）：
// 不暂存，不吞后续帧
func TestOscStateDivergedTailNotPending(t *testing.T) {
	d := newOscStateDetector()
	d.feed([]byte("text\x1b[31m")) // CSI 色码截在块尾
	d.feed([]byte(testFrameC))
	if running, _ := mustState(t, d); !running {
		t.Fatalf("CSI tail must not break subsequent C frame")
	}
	if d.pendingLen() != 0 {
		t.Fatalf("diverged tail must not be held as pending")
	}
}

// TestSessionOscRunningStateNilSafe 裸构造会话（无探测器）访问不炸，
// 返回 (false, 零时刻)
func TestSessionOscRunningStateNilSafe(t *testing.T) {
	s := &Session{}
	running, last := s.OscRunningState()
	if running || !last.IsZero() {
		t.Fatalf("nil detector must report idle/zero, got running=%v last=%v", running, last)
	}
}

// TestManagerRunningCount 计数口：kind 过滤 / count+total+ids 一致 / 会话清理
// 随动（removeSession 后计数即落）/ 裸会话（osc nil）计入 total 不计运行
func TestManagerRunningCount(t *testing.T) {
	m := &Manager{sessions: make(map[string]*Session)}
	mk := func(id, kind string) *Session {
		s := &Session{ID: id, Kind: kind, osc: newOscStateDetector()}
		m.sessions[id] = s
		return s
	}
	a1 := mk("agent-1", KindAgent)
	a2 := mk("agent-2", KindAgent)
	mk("shell-1", KindShell)
	// 无探测器的裸会话（测试构造形态）：在册但永不在运行清单
	m.sessions["agent-3"] = &Session{ID: "agent-3", Kind: KindAgent}

	// 初始：全部空闲
	if c, tot, ids := m.RunningCount(KindAgent); c != 0 || tot != 3 || len(ids) != 0 {
		t.Fatalf("initial agent count want 0/3/[], got %d/%d/%v", c, tot, ids)
	}

	a1.osc.feed([]byte(testFrameC))
	a2.osc.feed([]byte(testFrameD)) // D 不点亮
	m.sessions["shell-1"].osc.feed([]byte(testFrameC))

	if c, tot, ids := m.RunningCount(KindAgent); c != 1 || tot != 3 || len(ids) != 1 || ids[0] != "agent-1" {
		t.Fatalf("agent count want 1/3/[agent-1], got %d/%d/%v", c, tot, ids)
	}
	if c, tot, _ := m.RunningCount(KindShell); c != 1 || tot != 1 {
		t.Fatalf("shell count want 1/1, got %d/%d", c, tot)
	}
	if c, tot, ids := m.RunningCount(""); c != 2 || tot != 4 || len(ids) != 2 {
		t.Fatalf("all count want 2/4/2ids, got %d/%d/%v", c, tot, ids)
	}

	// 会话清理随动：agent-1 消亡（Kill/removeSession 同款 map 摘除）后计数即落
	delete(m.sessions, "agent-1")
	if c, tot, ids := m.RunningCount(KindAgent); c != 0 || tot != 2 || len(ids) != 0 {
		t.Fatalf("after removal want 0/2/[], got %d/%d/%v", c, tot, ids)
	}

	// 命令完成熄灭：shell-1 收 D 后归零
	m.sessions["shell-1"].osc.feed([]byte(testFrameD))
	if c, _, _ := m.RunningCount(KindShell); c != 0 {
		t.Fatalf("shell session must extinguish after D, got %d", c)
	}
}

// pendingLen 测试观察口：当前暂存尾段长度
func (d *oscStateDetector) pendingLen() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.pending)
}
