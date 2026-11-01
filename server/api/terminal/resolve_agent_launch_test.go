package terminal

import (
	"testing"
)

// stubSelect 选型桩：复刻 SelectProviderByName 真实语义——显式名可用返回之，
// 不可用内部回退 auto（按可用性挑第一个）；全不可用返回失败
func stubSelect(providerAvailable map[string]bool, official map[string]string) launchSelector {
	autoPick := func() (string, string, bool) {
		for _, n := range []string{"claude", "codex", "dsh"} {
			if providerAvailable[n] {
				return n, official[n], true
			}
		}
		return "", "", false
	}
	return func(name string) (string, string, bool) {
		if name != "" && name != "auto" {
			if providerAvailable[name] {
				return name, official[name], true
			}
		}
		return autoPick()
	}
}

// TestResolveAgentLaunch_CustomBypassesAvailability 显式指定运行时 + 配了自定义
// 启动命令 → 跳过可用性门控按原样启动（探测覆盖不到的自定义 CLI 场景，与
// 前端「探测不可用不禁用」口径一致；此前服务端在 Available=false 时回退
// auto/降级 shell，自定义命令永远没机会执行）
func TestResolveAgentLaunch_CustomBypassesAvailability(t *testing.T) {
	selectFn := stubSelect(
		map[string]bool{"claude": false, "codex": true, "dsh": true},
		map[string]string{"claude": "claude", "codex": "codex", "dsh": "dsh"},
	)
	customs := map[string]string{"claude": "/opt/launcher claude --flag"}

	rt, launch, launched := resolveAgentLaunch("claude", "", customs, selectFn)
	if !launched || rt != "claude" || launch != "/opt/launcher claude --flag" {
		t.Fatalf("got %q / %q / %v, want claude custom launch", rt, launch, launched)
	}

	// launchArgs 追加语义保持
	_, launch, _ = resolveAgentLaunch("claude", "--resume abc", customs, selectFn)
	if launch != "/opt/launcher claude --flag --resume abc" {
		t.Fatalf("launch = %q", launch)
	}
}

// TestResolveAgentLaunch_NoCustomFallsBack 无自定义命令维持原语义：探测不可用
// 的显式名回退 auto（「用户配置先于环境消失的运行时仍可正常使用」）
func TestResolveAgentLaunch_NoCustomFallsBack(t *testing.T) {
	selectFn := stubSelect(
		map[string]bool{"claude": false, "codex": true, "dsh": false},
		map[string]string{"codex": "codex"},
	)
	rt, launch, launched := resolveAgentLaunch("claude", "", nil, selectFn)
	if !launched || rt != "codex" || launch != "codex" {
		t.Fatalf("got %q / %q / %v, want codex fallback", rt, launch, launched)
	}

	// 全部不可用 → 选型失败，调用方降级 shell
	rt, _, launched = resolveAgentLaunch("claude", "", nil, stubSelect(map[string]bool{}, nil))
	if launched || rt != "" {
		t.Fatalf("got %q / %v, want selection failure", rt, launched)
	}
}

// TestResolveAgentLaunch_AutoCustomOverride auto 选出的实际运行时若配了自定义
// 命令则同样覆盖
func TestResolveAgentLaunch_AutoCustomOverride(t *testing.T) {
	selectFn := stubSelect(
		map[string]bool{"claude": true, "codex": true, "dsh": true},
		map[string]string{"claude": "claude", "codex": "codex", "dsh": "dsh"},
	)
	customs := map[string]string{"claude": "my-claude-wrapper"}

	rt, launch, launched := resolveAgentLaunch("auto", "", customs, selectFn)
	if !launched || rt != "claude" || launch != "my-claude-wrapper" {
		t.Fatalf("got %q / %q / %v, want claude with custom override", rt, launch, launched)
	}
}

// TestResolveAgentLaunch_Shell shell 一等选项：透传 launchArgs 不选型
func TestResolveAgentLaunch_Shell(t *testing.T) {
	rt, launch, launched := resolveAgentLaunch("shell", "echo hi", nil, nil)
	if !launched || rt != "shell" || launch != "echo hi" {
		t.Fatalf("got %q / %q / %v", rt, launch, launched)
	}
}
