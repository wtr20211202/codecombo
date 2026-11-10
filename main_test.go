package main

import (
	"os"
	"strings"
	"testing"
)

// withArgs 临时替换 os.Args 并在测试结束后恢复
func withArgs(t *testing.T, args []string) {
	t.Helper()
	orig := os.Args
	os.Args = args
	t.Cleanup(func() { os.Args = orig })
}

func TestParseHostFlag(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"未指定返回空", []string{"codecombo", "start"}, ""},
		{"长 flag 形式", []string{"codecombo", "start", "--host", "0.0.0.0"}, "0.0.0.0"},
		{"短 flag 形式", []string{"codecombo", "start", "-H", "192.168.1.10"}, "192.168.1.10"},
		{"等号形式", []string{"codecombo", "start", "--host=127.0.0.1"}, "127.0.0.1"},
		{"值带空格自动 trim", []string{"codecombo", "start", "--host", "  0.0.0.0  "}, "0.0.0.0"},
		{"-H 与 -p 共存", []string{"codecombo", "start", "-H", "0.0.0.0", "-p", "8080"}, "0.0.0.0"},
		{"--host 末尾缺值视为未指定", []string{"codecombo", "start", "--host"}, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withArgs(t, tc.args)
			if got := parseHostFlag(); got != tc.want {
				t.Fatalf("parseHostFlag() = %q, want %q", got, tc.want)
			}
		})
	}
}

// 空值触发 os.Exit 的路径在测试进程内无法直接断言（os.Exit 会终止整个测试进程），
// 由代码 review + 手工 smoke test（codecombo start --host= 应报错退出）覆盖。

func TestParsePortFlag(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"未指定返回 0", []string{"codecombo", "start"}, 0},
		{"长 flag 形式", []string{"codecombo", "start", "--port", "8080"}, 8080},
		{"短 flag 形式", []string{"codecombo", "start", "-p", "7000"}, 7000},
		{"等号形式", []string{"codecombo", "start", "--port=9090"}, 9090},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withArgs(t, tc.args)
			if got := parsePortFlag(); got != tc.want {
				t.Fatalf("parsePortFlag() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestApplyDataDirFlag(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"未指定不改环境", []string{"codecombo", "start"}, ""},
		{"长 flag 形式", []string{"codecombo", "start", "--data-dir", "D:/tmp/sc-a"}, "D:/tmp/sc-a"},
		{"短 flag 形式", []string{"codecombo", "start", "-d", "/tmp/sc-b"}, "/tmp/sc-b"},
		{"等号形式", []string{"codecombo", "start", "--data-dir=/tmp/sc-c"}, "/tmp/sc-c"},
		{"值带空格自动 trim", []string{"codecombo", "start", "--data-dir", " /tmp/sc-d "}, "/tmp/sc-d"},
		{"--data-dir 末尾缺值视为未指定", []string{"codecombo", "start", "--data-dir"}, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			withArgs(t, tc.args)
			// 环境还原：无论走哪个分支，测试后 SC_DATA_DIR 恢复原值
			orig, had := os.LookupEnv("SC_DATA_DIR")
			t.Cleanup(func() {
				if had {
					_ = os.Setenv("CC_DATA_DIR", orig)
				} else {
					_ = os.Unsetenv("CC_DATA_DIR")
				}
			})
			_ = os.Unsetenv("CC_DATA_DIR")

			applyDataDirFlag()

			got := os.Getenv("CC_DATA_DIR")
			if got != tc.want {
				t.Fatalf("CC_DATA_DIR = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestApplyDataDirFlag_OverridesEnv flag 显式覆盖已有环境变量（优先级验证）
func TestApplyDataDirFlag_OverridesEnv(t *testing.T) {
	withArgs(t, []string{"codecombo", "start", "-d", "/tmp/from-flag"})
	t.Setenv("CC_DATA_DIR", "/tmp/from-env")

	applyDataDirFlag()

	if got := os.Getenv("CC_DATA_DIR"); got != "/tmp/from-flag" {
		t.Fatalf("flag should override env, CC_DATA_DIR = %q", got)
	}
}

// TestOfflineUpdateHint P-20261109-5：CLI 离线换包路径退役后的指引文案。
// npm 形态直接给 npm 更新指令（不走服务端链——manager 对 npm 形态本就让位）；
// 其余形态给「先起服务再 update（服务端 manager 全链：验签+回滚）/包管理器」
// 两条出路。IsNpmManaged 双判据：CODECOMBO_INSTALLER 环境变量 + node_modules
// 路径段——测试二进制路径不含 node_modules，注入 env 即可分别命中两分支
func TestOfflineUpdateHint(t *testing.T) {
	t.Run("npm 形态指向 npm 更新", func(t *testing.T) {
		t.Setenv("CODECOMBO_INSTALLER", "npm")
		hint := offlineUpdateHint()
		if !strings.Contains(hint, "npm i -g codecombo@latest") {
			t.Fatalf("npm hint should point to npm update, got: %s", hint)
		}
		if strings.Contains(hint, "codecombo start") {
			t.Fatalf("npm hint should not suggest the server-side flow, got: %s", hint)
		}
	})

	t.Run("非 npm 形态指向运行中服务端或包管理器", func(t *testing.T) {
		t.Setenv("CODECOMBO_INSTALLER", "")
		hint := offlineUpdateHint()
		for _, want := range []string{"codecombo start", "codecombo update", "npm i -g codecombo@latest"} {
			if !strings.Contains(hint, want) {
				t.Fatalf("hint should contain %q, got: %s", want, hint)
			}
		}
	})
}
