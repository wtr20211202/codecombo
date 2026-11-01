package update

import "testing"

// semver 2.0.0 比较规则全覆盖（含预发布语义）
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// 基础
		{"1.2.3", "1.2.3", 0},
		{"v1.2.3", "1.2.3", 0},
		{"1.2.4", "1.2.3", 1},
		{"1.10.0", "1.9.0", 1},
		{"1.2", "1.2.0", 0},
		{"dev", "0.0.1", -1},
		{"0.0.1", "dev", 1},
		// 预发布 vs 正式：正式 > 预发布
		{"1.2.3-beta", "1.2.3", -1},
		{"1.2.3", "1.2.3-beta", 1},
		{"1.0.0-alpha", "1.0.0", -1},
		// 预发布标识符逐个比较
		{"1.0.0-alpha", "1.0.0-beta", -1},
		{"1.0.0-beta", "1.0.0-rc.1", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.2", -1},
		{"1.0.0-beta.2", "1.0.0-beta.11", -1}, // 数值 2 < 11
		{"1.0.0-beta.11", "1.0.0-beta.2", 1},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1}, // 前缀相等 → 少 < 多
		{"1.0.0-alpha.1", "1.0.0-alpha", 1},
		// 数字 < 非数字
		{"1.0.0-1", "1.0.0-alpha", -1},
		// 构建元数据剥离（不影响优先级）
		{"1.2.3-rc.1+build.5", "1.2.3-rc.1+build.9", 0},
		{"1.2.3+build.5", "1.2.3+build.9", 0},
		// 主版本段仍生效
		{"1.2.4-beta", "1.2.3", 1},
		{"2.0.0-alpha", "1.9.9", 1},
		// beta → stable 是升级
		{"0.1.0", "0.1.0-beta.1", 1},
		{"0.1.0-beta.1", "0.1.0", -1},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestHasUpdate(t *testing.T) {
	// beta → stable 是升级
	if !HasUpdate("0.1.0-beta.1", "0.1.0") {
		t.Error("beta.1 should update to 0.1.0 stable")
	}
	// stable 不应降级到 beta
	if HasUpdate("0.1.0", "0.1.0-beta.2") {
		t.Error("stable should not downgrade to beta")
	}
	// 预发布递增
	if !HasUpdate("0.1.0-beta.1", "0.1.0-beta.2") {
		t.Error("beta.1 should update to beta.2")
	}
	// 正式版不提示同版本预发布
	if HasUpdate("0.1.0", "0.1.0-beta.1") {
		t.Error("stable should not downgrade to pre-release")
	}
}
