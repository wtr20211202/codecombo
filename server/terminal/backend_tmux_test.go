//go:build !windows

package terminal

import (
	"strings"
	"testing"
)

// TestParseTmuxVersion tmux -V 输出解析
func TestParseTmuxVersion(t *testing.T) {
	cases := []struct {
		input    string
		maj, min int
		ok       bool
	}{
		{"tmux 3.3", 3, 3, true},
		{"tmux 3.3a", 3, 3, true},
		{"tmux 3.4", 3, 4, true},
		{"tmux 3.5", 3, 5, true},
		{"tmux 4.0", 4, 0, true},
		{"tmux 3.2a", 3, 2, true}, // 可解析但低于最低版本
		{"not-a-version", 0, 0, false},
		{"", 0, 0, false},
	}

	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			maj, min, ok := ParseTmuxVersion(tc.input)
			if ok != tc.ok || maj != tc.maj || min != tc.min {
				t.Errorf("ParseTmuxVersion(%q) = (%d, %d, %v), want (%d, %d, %v)",
					tc.input, maj, min, ok, tc.maj, tc.min, tc.ok)
			}
		})
	}
}

// TestTmuxClipboardFloorKind 剪贴板能力地板两档分类（P-20261109-7）：
// <3.2 拖选复制受限（set-clipboard 键不存在）/ 3.2≤v<3.3 应用内复制透传受限
// （allow-passthrough 缺）/ ≥3.3 全通；空串与不可解析 = 静默（空串）不提示
func TestTmuxClipboardFloorKind(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"tmux 3.4", tmuxFloorOK},
		{"tmux 3.3a", tmuxFloorOK},
		{"tmux 3.3", tmuxFloorOK},
		{"tmux 4.0", tmuxFloorOK},
		{"tmux 3.2", tmuxFloorPassthrough},
		{"tmux 3.2a", tmuxFloorPassthrough},
		{"tmux 3.1b", tmuxFloorDragCopy},
		{"tmux 2.9", tmuxFloorDragCopy},
		// next-3.5 形态沿 ParseTmuxVersion 既有解析契约判不可解析（isTmuxAvailable
		// 同一正则同一行为，本提案不改后端选型语义）→ 静默（空串）无提示
		{"tmux next-3.5", ""},
		{"", ""},
		{"garbage", ""},
	}
	for _, tc := range cases {
		if got := TmuxClipboardFloorKind(tc.input); got != tc.want {
			t.Errorf("TmuxClipboardFloorKind(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// TestTmuxConfContentClipboardAndMouse 托管 conf 全文断言（P-20261109-7 A①）：
// set-clipboard on 恒在位（拖选 copy-pipe 源头兜底）；mouse 行随开关翻转——
// conf 是「DO NOT EDIT」托管文件，内容即本系统对 tmux 行为的声明面
func TestTmuxConfContentClipboardAndMouse(t *testing.T) {
	conf := tmuxConfContent(20000, true)
	if !strings.Contains(conf, "\nset -s set-clipboard on\n") {
		t.Errorf("tmuxConfContent missing `set -s set-clipboard on`:\n%s", conf)
	}
	if !strings.Contains(conf, "\nset -g mouse on\n") {
		t.Errorf("tmuxConfContent(mouseOn=true) missing `set -g mouse on`:\n%s", conf)
	}
	off := tmuxConfContent(20000, false)
	if !strings.Contains(off, "\nset -g mouse off\n") {
		t.Errorf("tmuxConfContent(mouseOn=false) missing `set -g mouse off`:\n%s", off)
	}
	if strings.Contains(off, "\nset -g mouse on\n") {
		t.Errorf("tmuxConfContent(mouseOn=false) still has `set -g mouse on`:\n%s", off)
	}
}

// TestComputeTmuxSessionName 验证命名格式与可反解析
func TestComputeTmuxSessionName(t *testing.T) {
	name := computeTmuxSessionName("project-abc-123")

	// 格式: sc-<8 hex>-<6 alnum>
	if len(name) != len("sc-")+8+len("-")+6 {
		t.Errorf("computeTmuxSessionName length = %d, want %d", len(name), len("sc-xxxxxxxx-xxxxxx"))
	}

	// 前缀检查
	if name[:3] != "sc-" {
		t.Errorf("computeTmuxSessionName prefix = %q, want %q", name[:3], "sc-")
	}

	// 反解析
	projHash, randID, ok := parseTmuxSessionName(name)
	if !ok {
		t.Errorf("parseTmuxSessionName(%q) failed", name)
	}
	if len(projHash) != 8 || len(randID) != 6 {
		t.Errorf("parseTmuxSessionName returned projHash=%q (len %d), randID=%q (len %d)",
			projHash, len(projHash), randID, len(randID))
	}
}

// TestComputeTmuxSessionNameStableHash 相同 projectId 生成相同 hash 前缀
func TestComputeTmuxSessionNameStableHash(t *testing.T) {
	n1 := computeTmuxSessionName("project-X")
	n2 := computeTmuxSessionName("project-X")

	// hash 前缀应相同（前 12 字符 = sc- + 8 hex），随机后缀不同
	if n1[:12] != n2[:12] {
		t.Errorf("hash prefix differs: %q vs %q", n1[:12], n2[:12])
	}
	if n1[12:] == n2[12:] {
		t.Errorf("random suffix should differ: %q vs %q", n1[12:], n2[12:])
	}
}

// TestTmuxBackendImplementsInterface 编译期验证 tmuxBackend 实现 PtyBackend
func TestTmuxBackendImplementsInterface(t *testing.T) {
	var _ PtyBackend = (*tmuxBackend)(nil)
	var _ PtyBackend = newTmuxBackend()
}

// TestTmuxBackendPersistent tmux backend 必须报告 IsPersistent()=true
func TestTmuxBackendPersistent(t *testing.T) {
	b := newTmuxBackend()
	if !b.IsPersistent() {
		t.Errorf("tmuxBackend.IsPersistent() = false, want true")
	}
}

// TestTmuxBackendCreateRequiresName tmux backend 在 TmuxName 为空时拒绝 Create
func TestTmuxBackendCreateRequiresName(t *testing.T) {
	b := newTmuxBackend()
	_, err := b.Create(SessionSpec{})
	if err == nil {
		t.Errorf("tmuxBackend.Create(empty spec) returned nil error, want error")
	}
}

// TestTmuxSessionEnvConf 敏感 env 下发 conf 的生成与安全字符集闸门：
// 正常值生成带引号的 set-environment 行；conf 特殊字符（引号/空白/注释/指令）
// 或畸形键值对必须拒绝走文件通道（调用方回退 argv 直传）
func TestTmuxSessionEnvConf(t *testing.T) {
	const sess = "sc-ab12cd34-xy9z01"
	conf, ok := tmuxSessionEnvConf(sess, []string{
		"CC_BASE_URL=http://localhost:8080",
		"CC_LOCK_TOKEN=sca_0123456789abcdef",
		"CC_TERMINAL_ID=" + sess,
	})
	if !ok {
		t.Fatalf("tmuxSessionEnvConf rejected safe values")
	}
	want := "set-environment -t '" + sess + "' -- 'CC_BASE_URL' 'http://localhost:8080'\n" +
		"set-environment -t '" + sess + "' -- 'CC_LOCK_TOKEN' 'sca_0123456789abcdef'\n" +
		"set-environment -t '" + sess + "' -- 'CC_TERMINAL_ID' '" + sess + "'\n"
	if conf != want {
		t.Errorf("conf mismatch:\n got: %q\nwant: %q", conf, want)
	}

	// conf/目标解析特殊字符一律拒绝，宁可回退 argv 也不注入未转义内容
	for _, kv := range []string{
		"CC_LOCK_TOKEN=sca_'quote",
		`CC_LOCK_TOKEN=sca_\"quote`,
		"CC_LOCK_TOKEN=sca_ has space",
		"CC_LOCK_TOKEN=sca_#comment",
		"CC_LOCK_TOKEN=sca_$expand",
		"CC_LOCK_TOKEN=sca_%if",
		"no-delimiter",
	} {
		if _, ok := tmuxSessionEnvConf(sess, []string{kv}); ok {
			t.Errorf("tmuxSessionEnvConf accepted unsafe value %q", kv)
		}
	}
}

// TestSetTmuxSessionEnvFallback 走 argv 回退路径不得 panic/丢值——仅验证
// 回退分支对畸形键值对的健壮性（tmux 未安装时 runTmux 报错被吞，行为同旧实现）
func TestSetTmuxSessionEnvFallback(t *testing.T) {
	setTmuxSessionEnv("sc-ab12cd34-xy9z01", []string{
		"CC_LOCK_TOKEN=sca_'unsafe",
		"no-delimiter",
	})
}

// TestTmuxSessionEnvConfProjectVars 项目标识两枚（P-20261003-307）的通道语义：
// uuid 形态的 CC_PROJECT_ID 在 conf 安全字符集内；路径值含空格（常见形态）必须
// 被拒走 conf 通道——tmuxSessionEnvConf 对单值超集即拒绝整批，因此 backend_tmux
// Create 把项目标识与敏感令牌拆两批下发，空格路径的 argv 回退不波及 CC_LOCK_TOKEN
func TestTmuxSessionEnvConfProjectVars(t *testing.T) {
	const sess = "sc-ab12cd34-xy9z01"
	if _, ok := tmuxSessionEnvConf(sess, []string{
		"CC_PROJECT_ID=0b6c1a2e-5c1d-4f8a-9a2b-3c4d5e6f7a8b",
	}); !ok {
		t.Errorf("uuid CC_PROJECT_ID should pass conf safe charset")
	}
	if _, ok := tmuxSessionEnvConf(sess, []string{
		`CC_PROJECT_PATH=/home/user/my repo`,
	}); ok {
		t.Errorf("spacey CC_PROJECT_PATH should be rejected from conf channel (argv fallback)")
	}
}
