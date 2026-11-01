package deploy

import (
	"strings"
	"testing"
)

func TestCodecomboMetadata(t *testing.T) {
	d := &CodecomboDeployer{}
	if d.ID() != "codecombo" {
		t.Errorf("expected codecombo, got %s", d.ID())
	}
	if d.Category() != CategorySelfHost {
		t.Errorf("expected self_host, got %s", d.Category())
	}
	deps := d.DependsOn()
	if len(deps) != 1 || deps[0] != "init_user" {
		t.Errorf("expected [init_user], got %v", deps)
	}
	if d.AllowMultiple() {
		t.Error("codecombo should not allow multiple")
	}
}

func TestMatchBinaryPlatform(t *testing.T) {
	cases := []struct {
		unameS, unameM string
		want           string
	}{
		{"Linux", "x86_64", "codecombo-linux-amd64"},
		{"Linux", "aarch64", "codecombo-linux-arm64"},
		{"Linux", "arm64", "codecombo-linux-arm64"},
		{"Darwin", "arm64", "codecombo-darwin-arm64"},
		{"Darwin", "x86_64", "codecombo-darwin-amd64"},
	}
	for _, c := range cases {
		got := matchBinaryName(c.unameS, c.unameM)
		if got != c.want {
			t.Errorf("unameS=%s unameM=%s got=%s want=%s", c.unameS, c.unameM, got, c.want)
		}
	}
}

// TestMatchBinaryNameCandidates 双名候选序（P-20261025-1）：正名优先，旧名回落
func TestMatchBinaryNameCandidates(t *testing.T) {
	got := matchBinaryNameCandidates("Linux", "x86_64")
	want := []string{"codecombo-linux-amd64", "simple-coding-linux-amd64"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
}

// TestBuildSystemdUnit 部署 unit 规范化：二进制装服务用户可写的数据目录 bin/
//（自更新换包需要 rename 二进制所在目录）、数据目录 env 刻意不下发（默认路径
// 解析 + 首启自动迁移）、绑定地址进 ExecStart（远程部署默认 0.0.0.0 开放局域网）
func TestBuildSystemdUnit(t *testing.T) {
	unit := buildSystemdUnit("9999", "0.0.0.0", "cld", codecomboBinPath("cld"), true)
	for _, want := range []string{
		"ExecStart=/home/cld/.codecombo/bin/codecombo --serve --port=9999 --host 0.0.0.0",
		"Description=Codecombo",
		// PATH 显式下发且含用户级目录：systemd 默认 PATH 无 ~/.local/bin，
		// 用户级安装的工具（npm 用户 prefix 等）服务内找不到
		"Environment=PATH=/home/cld/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"User=cld",
		"NoNewPrivileges=true",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit missing %q\nunit:\n%s", want, unit)
		}
	}
}

// TestCodecomboBinPath 安装路径必须在服务用户可写的数据目录下：
// 自更新换包需要 rename 二进制所在目录，系统目录（/usr/local/bin）会
// permission denied（历史缺陷）
func TestCodecomboBinPath(t *testing.T) {
	got := codecomboBinPath("cld")
	want := "/home/cld/.codecombo/bin/codecombo"
	if got != want {
		t.Errorf("codecomboBinPath(cld) = %s, want %s", got, want)
	}
	if legacy := legacyDataDirOf("cld"); legacy != "/home/cld/.simple-coding" {
		t.Errorf("legacyDataDirOf(cld) = %s", legacy)
	}
}

// TestBuildSystemdUnitSandboxOff 沙箱加固可关：部署参数显式 off 时 unit
// 不得包含 NoNewPrivileges 行（终端/智能体内需要 sudo 提权的场景）
func TestBuildSystemdUnitSandboxOff(t *testing.T) {
	unit := buildSystemdUnit("9999", "0.0.0.0", "cld", codecomboBinPath("cld"), false)
	if strings.Contains(unit, "NoNewPrivileges") {
		t.Errorf("sandbox off must omit NoNewPrivileges\nunit:\n%s", unit)
	}
}

// TestResolveSandbox 沙箱开关解析：默认开启，仅显式 "off" 关闭
func TestResolveSandbox(t *testing.T) {
	cases := []struct {
		params map[string]string
		want   bool
	}{
		{map[string]string{}, true},
		{map[string]string{"sandbox": ""}, true},
		{map[string]string{"sandbox": "on"}, true},
		{map[string]string{"sandbox": "off"}, false},
	}
	for _, c := range cases {
		if got := resolveSandbox(c.params); got != c.want {
			t.Errorf("resolveSandbox(%v) = %v, want %v", c.params, got, c.want)
		}
	}
}

// TestResolveBindHost 绑定地址解析：空值回退 0.0.0.0，空白 trim，非法字符拒绝
func TestResolveBindHost(t *testing.T) {
	got, err := resolveBindHost(map[string]string{})
	if err != nil || got != "0.0.0.0" {
		t.Fatalf("default = %q, err=%v", got, err)
	}
	got, err = resolveBindHost(map[string]string{"host": " 127.0.0.1 "})
	if err != nil || got != "127.0.0.1" {
		t.Fatalf("trim = %q, err=%v", got, err)
	}
	if _, err := resolveBindHost(map[string]string{"host": "0.0.0.0;rm"}); err == nil {
		t.Error("expected error for host with separator characters")
	}
}

// TestResolvePort 端口参数解析（默认 9999，非法值拒绝）
func TestResolvePort(t *testing.T) {
	cases := []struct {
		name    string
		params  map[string]string
		want    string
		wantErr bool
	}{
		{"default", nil, "9999", false},
		{"empty", map[string]string{"port": ""}, "9999", false},
		{"custom", map[string]string{"port": "8080"}, "8080", false},
		{"boundary low", map[string]string{"port": "1"}, "1", false},
		{"boundary high", map[string]string{"port": "65535"}, "65535", false},
		{"zero", map[string]string{"port": "0"}, "", true},
		{"overflow", map[string]string{"port": "65536"}, "", true},
		{"not number", map[string]string{"port": "abc"}, "", true},
	}
	for _, c := range cases {
		got, err := resolvePort(c.params)
		if (err != nil) != c.wantErr {
			t.Errorf("%s: err=%v, wantErr=%v", c.name, err, c.wantErr)
			continue
		}
		if !c.wantErr && got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}
