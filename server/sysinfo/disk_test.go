package sysinfo

import (
	"math"
	"testing"
)

// TestUsedPercent 纯量口径计算（平台无关的全量断言）
func TestUsedPercent(t *testing.T) {
	cases := []struct {
		name string
		du   DiskUsage
		want float64
	}{
		{"empty volume reports zero", DiskUsage{}, 0},
		{"full", DiskUsage{Total: 100, Free: 0, Avail: 0}, 100},
		{"half", DiskUsage{Total: 100, Free: 50, Avail: 50}, 50},
		// 展示口径用 Free：特权保留块计入已用（与 df 一致），Avail 只影响写盘预检
		{"reserved blocks count as used", DiskUsage{Total: 100, Free: 10, Avail: 4}, 90},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.du.UsedPercent()
			if math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("UsedPercent(%+v) = %v, want %v", tc.du, got, tc.want)
			}
		})
	}
}

func TestUsed(t *testing.T) {
	du := DiskUsage{Total: 100, Free: 30, Avail: 20}
	if got := du.Used(); got != 70 {
		t.Fatalf("Used() = %d, want 70", got)
	}
}

// TestUsageRealPath 真实采集冒烟：对测试临时目录取水位，断言口径自洽。
// 平台分支（statfs / GetDiskFreeSpaceEx）无法进程内 mock，以不变量校验
// 替代——两套实现的返回都必须满足 Total>0、Free≤Total、Avail≤Free，
// 本测试在双平台 CI 上各跑一份（每平台验证各自的分支）
func TestUsageRealPath(t *testing.T) {
	du, err := Usage(t.TempDir())
	if err != nil {
		t.Fatalf("Usage(temp dir) failed: %v", err)
	}
	if du.Total == 0 {
		t.Fatal("Total = 0, want > 0")
	}
	if du.Free > du.Total {
		t.Fatalf("Free %d > Total %d", du.Free, du.Total)
	}
	if du.Avail > du.Free {
		t.Fatalf("Avail %d > Free %d", du.Avail, du.Free)
	}
	if pct := du.UsedPercent(); pct < 0 || pct > 100 {
		t.Fatalf("UsedPercent() = %v, want within [0,100]", pct)
	}
}

// TestUsageNotExist 不存在的路径必须报错而非零值（调用方据 err 静默跳过）
func TestUsageNotExist(t *testing.T) {
	if _, err := Usage(t.TempDir() + string('/'-1) + "definitely-not-exist"); err == nil {
		t.Fatal("Usage(non-exist path) should return error")
	}
}

// TestSameVolume 同卷判定：同一路径恒真；解析不出卷根/卷根不同的路径
// 按异卷处理（宁可多展示一条，不可错误去重隐藏）。真异卷样本依赖机器
// 分盘布局，不强断言（SameVolume 本身即机器相关的观测，单测只守不变量）
func TestSameVolume(t *testing.T) {
	dir := t.TempDir()
	if !SameVolume(dir, dir) {
		t.Fatal("SameVolume(dir, dir) = false, want true")
	}
	// Q:\ 卷根在 Windows 上与当前盘符不同；在 Unix 上解析不出卷根——
	// 两平台都必须判异卷（Windows 卷根解析是纯字符串操作，不依赖存在性）
	if SameVolume(dir, `Q:\elsewhere\data`) {
		t.Fatal("SameVolume with foreign volume root should be false")
	}
}
