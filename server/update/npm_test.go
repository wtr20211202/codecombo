package update

import "testing"

func TestIsNpmManaged(t *testing.T) {
	t.Setenv("CODECOMBO_INSTALLER", "")
	cases := []struct {
		name string
		path string
		want bool
	}{
		{"npm 全局 win", `C:\Users\x\AppData\Roaming\npm\node_modules\codecombo-win32-x64\bin\codecombo.exe`, true},
		{"npm 全局 unix", "/usr/lib/node_modules/codecombo-linux-x64/bin/codecombo", true},
		{"本地 node_modules", "/repo/web/node_modules/codecombo-darwin-arm64/bin/codecombo", true},
		{"常规部署", "/usr/local/bin/codecombo", false},
		{"开发构建", "dist/codecombo", false},
		{"相似名不是同段", "/opt/node_modules_backup/codecombo", false},
		{"空路径", "", false},
	}
	for _, tc := range cases {
		if got := IsNpmManaged(tc.path); got != tc.want {
			t.Errorf("%s: IsNpmManaged(%q) = %v, want %v", tc.name, tc.path, got, tc.want)
		}
	}
}

func TestIsNpmManagedEnvOverride(t *testing.T) {
	t.Setenv("CODECOMBO_INSTALLER", "npm")
	if !IsNpmManaged("/usr/local/bin/codecombo") {
		t.Error("env 注入 npm 时常规路径也应判为 npm 管理")
	}
	t.Setenv("CODECOMBO_INSTALLER", "")
	t.Setenv("CODECOMBO_INSTALLER", "NPM") // 大小写不敏感
	if !IsNpmManaged("/usr/local/bin/codecombo") {
		t.Error("env 大小写变体也应命中")
	}
}
