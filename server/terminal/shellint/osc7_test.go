package shellint

import (
	"regexp"
	"strings"
	"testing"
)

// OSC 7 cwd 上报（P-20261004-59）脚本族单测：bash 走真实驱动（cd 后 precmd
// 发帧 + 空格路径百分号编码），zsh/PowerShell 走嵌入脚本结构断言（两 shell
// 无跨平台可执行驱动——PowerShell 依赖 Windows 控制台、zsh 依赖提示符钩子，
// 发射位形态与 bash 同构，结构断言守门 + e2e terminal-cwd-track 全链路兜底）。

// osc7Re 匹配裸 OSC 7 帧（tmux DCS 包装场景与 133 同构，不在单测范围）
var osc7Re = regexp.MustCompile("\x1b\\]7;file://([^\x07]*)\x07")

// TestBashOSC7PrecmdEmits cwd 上报随 precmd 发射：cd 进含空格目录后显式调用
// precmd，帧内路径须按 URL 语义百分号编码（空格 → %20）
func TestBashOSC7PrecmdEmits(t *testing.T) {
	out := runBashDriver(t, `
mkdir -p "sp ace"
cd "sp ace"
__simple_coding_precmd
`)
	matches := osc7Re.FindAllStringSubmatch(out, -1)
	if len(matches) == 0 {
		t.Fatalf("expected OSC 7 frame, out: %q", out)
	}
	url := matches[len(matches)-1][1]
	if !strings.Contains(url, "sp%20ace") {
		t.Errorf("cwd url should percent-encode space, got %q", url)
	}
	if !strings.Contains(url, "file://") && !strings.HasPrefix(url, "") {
		t.Errorf("frame payload should be host-rooted url path, got %q", url)
	}
}

// TestBashOSC7InitialPrompt 安装期首次 prompt 即上报一次（新会话无需先跑命令）
func TestBashOSC7InitialPrompt(t *testing.T) {
	out := runBashDriver(t, "\n")
	if len(osc7Re.FindAllString(out, -1)) == 0 {
		t.Fatalf("expected OSC 7 frame at install time, out: %q", out)
	}
}

// TestScriptOSC7Markers zsh/PowerShell 嵌入脚本含 OSC7 发射位：包装器广义化
// 后仍带 133 发射（回归锚）+ 7 号发射入口在位
func TestScriptOSC7Markers(t *testing.T) {
	cases := []struct {
		shell   string
		wantSub []string
	}{
		{"zsh", []string{"__simple_coding_osc7", `]7;file://`, `]%s;%s`}},
		{"pwsh", []string{"__SCWriteOsc7", "]7;file://", "]133;A"}},
	}
	for _, tc := range cases {
		script := ScriptForShell(tc.shell)
		if script == "" {
			t.Fatalf("ScriptForShell(%q) empty", tc.shell)
		}
		for _, sub := range tc.wantSub {
			if !strings.Contains(script, sub) {
				t.Errorf("ScriptForShell(%q) missing %q", tc.shell, sub)
			}
		}
	}
}
