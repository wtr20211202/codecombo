package remote

import (
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// TestResolveTmuxName 远程 tmux 会话名解析：开关关闭 / 请求复用 / 自动生成
func TestResolveTmuxName(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	setTmux := func(on bool) {
		cfg := store.Get().Settings.Get()
		cfg.Server.TerminalRemoteTmux = &on
	}

	t.Run("开关关闭返回空名（原生 shell）", func(t *testing.T) {
		setTmux(false)
		name, err := resolveTmuxName("host-x", "")
		if err != nil || name != "" {
			t.Fatalf("want empty name, got %q err=%v", name, err)
		}
	})

	t.Run("开关关闭时即使请求携带名字也不启用", func(t *testing.T) {
		setTmux(false)
		name, err := resolveTmuxName("host-x", "sc_rtm_keep")
		if err != nil || name != "" {
			t.Fatalf("want empty name, got %q err=%v", name, err)
		}
	})

	t.Run("开启时合法请求名原样复用（重开重连既有 tmux 会话）", func(t *testing.T) {
		setTmux(true)
		name, err := resolveTmuxName("host-x", "sc_rtm_ab12cd34-9x8y7z")
		if err != nil || name != "sc_rtm_ab12cd34-9x8y7z" {
			t.Fatalf("want passthrough, got %q err=%v", name, err)
		}
	})

	t.Run("开启时非法请求名拒绝（防 shell 注入）", func(t *testing.T) {
		setTmux(true)
		for _, bad := range []string{"a;rm -rf /", "a'b", "a b", "a$b", string(make([]byte, 65))} {
			if _, err := resolveTmuxName("host-x", bad); err == nil {
				t.Fatalf("want error for %q", bad)
			}
		}
	})

	t.Run("未携带名字时自动生成唯一合法名", func(t *testing.T) {
		setTmux(true)
		seen := map[string]bool{}
		for i := 0; i < 5; i++ {
			name, err := resolveTmuxName("host-x", "")
			if err != nil {
				t.Fatalf("generate: %v", err)
			}
			if !tmuxNameRe.MatchString(name) {
				t.Fatalf("generated name %q violates charset", name)
			}
			if len(name) < len("sc_rtm_")+8 || name[:7] != "sc_rtm_" {
				t.Fatalf("generated name %q missing sc_rtm_ prefix", name)
			}
			if seen[name] {
				t.Fatalf("generated duplicate name %q", name)
			}
			seen[name] = true
		}
	})

	t.Run("默认配置下开关为关", func(t *testing.T) {
		cfg := &config.ServerConfig{}
		if cfg.TerminalRemoteTmuxOrDefault() {
			t.Fatal("default must be off")
		}
	})
}
