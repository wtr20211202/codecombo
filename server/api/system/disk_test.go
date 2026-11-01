package system

import (
	"strings"
	"testing"

	"codecombo/server/notification"
)

// collectAdd 捕获投递的通知清单（巡检单测的投递桩）
func collectAdd() (func(notification.Notification), *[]notification.Notification) {
	var got []notification.Notification
	return func(n notification.Notification) { got = append(got, n) }, &got
}

// vol 造一条指定角色/档位的单卷水位
func vol(role, level string) diskVolume {
	pct := 42.0
	switch level {
	case "warn":
		pct = 85
	case "crit":
		pct = 95
	}
	return diskVolume{Role: role, Path: "/data", UsedMB: uint64(pct), TotalMB: 100, UsedPercent: pct, Level: level}
}

// TestDiskWatchdogNotifyOnce 阈值通知一次性语义：首跨入账 → 同档静默 →
// 升档再报 → 回线重新武装后再跨又报（P-20261002-12 防刷屏核心语义，
// e2e 造不出 80%+ 真实水位，通知构造以此单测为准）
func TestDiskWatchdogNotifyOnce(t *testing.T) {
	add, got := collectAdd()
	w := newDiskWatchdog(nil, add)

	cur := []diskVolume{vol(diskRoleData, "warn")}
	w.volumesFn = func() []diskVolume { return cur }

	w.patrol() // 首跨 warn：入账
	if n := len(*got); n != 1 {
		t.Fatalf("after first crossing, notifications = %d, want 1", n)
	}
	w.patrol() // 同档巡检：不重复
	if n := len(*got); n != 1 {
		t.Fatalf("same-level patrol re-notified: %d, want 1", n)
	}

	cur = []diskVolume{vol(diskRoleData, "crit")}
	w.patrol() // 升档 crit：再报一次
	if n := len(*got); n != 2 {
		t.Fatalf("escalation to crit not notified: %d, want 2", n)
	}
	w.patrol() // crit 同档：静默
	if n := len(*got); n != 2 {
		t.Fatalf("same-level patrol re-notified: %d, want 2", n)
	}

	cur = []diskVolume{vol(diskRoleData, "ok")}
	w.patrol() // 回线：重新武装，不报
	if n := len(*got); n != 2 {
		t.Fatalf("recovery should not notify: %d, want 2", n)
	}

	cur = []diskVolume{vol(diskRoleData, "warn")}
	w.patrol() // 再跨：已重新武装，应再报
	if n := len(*got); n != 3 {
		t.Fatalf("re-armed crossing not notified: %d, want 3", n)
	}
}

// TestDiskWatchdogHysteresis 迟滞：warn→crit→warn 抖动只在 crit 升档时报一次，
// 回到 warn 不降档打扰（仍在线内）
func TestDiskWatchdogHysteresis(t *testing.T) {
	add, got := collectAdd()
	w := newDiskWatchdog(nil, add)

	cur := []diskVolume{vol(diskRoleData, "warn")}
	w.volumesFn = func() []diskVolume { return cur }
	w.patrol()

	cur = []diskVolume{vol(diskRoleData, "crit")}
	w.patrol()
	cur = []diskVolume{vol(diskRoleData, "warn")}
	w.patrol() // 降档：不打扰
	w.patrol() // 稳定 warn：不打扰
	if n := len(*got); n != 2 {
		t.Fatalf("hysteresis broken: %d notifications, want 2", n)
	}
}

// TestDiskWatchdogNotificationShape 通知构造：Category system + 类型随档位 +
// titleKey/bodyKey 走 monitor.disk.notify.* 模板 + 中文兜底标题 + 语言中立明细
func TestDiskWatchdogNotificationShape(t *testing.T) {
	add, got := collectAdd()
	w := newDiskWatchdog(func() []diskVolume {
		return []diskVolume{vol(diskRoleSys, "crit")}
	}, add)
	w.patrol()

	if len(*got) != 1 {
		t.Fatalf("notifications = %d, want 1", len(*got))
	}
	n := (*got)[0]
	if n.Category != notification.CategorySystem {
		t.Fatalf("category = %q, want %q", n.Category, notification.CategorySystem)
	}
	if n.Type != "error" {
		t.Fatalf("type = %q, want error (crit level)", n.Type)
	}
	if n.TitleKey != "monitor.disk.notify.sysCrit" {
		t.Fatalf("titleKey = %q", n.TitleKey)
	}
	if n.BodyKey != "monitor.disk.notify.critBody" {
		t.Fatalf("bodyKey = %q", n.BodyKey)
	}
	if n.Title == "" || !strings.Contains(n.Title, "系统盘") {
		t.Fatalf("chinese fallback title = %q", n.Title)
	}
	if !strings.Contains(n.Body, "used 95.0%") || !strings.Contains(n.Body, "/data") {
		t.Fatalf("language-neutral body = %q", n.Body)
	}
	if n.MsgParams["pct"] != "95.0%" {
		t.Fatalf("msgParams pct = %v", n.MsgParams["pct"])
	}

	// warn 档是 warning 级
	add2, got2 := collectAdd()
	w2 := newDiskWatchdog(func() []diskVolume {
		return []diskVolume{vol(diskRoleData, "warn")}
	}, add2)
	w2.patrol()
	if (*got2)[0].Type != "warning" {
		t.Fatalf("warn-level type = %q, want warning", (*got2)[0].Type)
	}
}

// TestDiskWatchdogMultiRole 数据盘与系统盘各自独立武装（互不抑制）
func TestDiskWatchdogMultiRole(t *testing.T) {
	add, got := collectAdd()
	w := newDiskWatchdog(func() []diskVolume {
		return []diskVolume{vol(diskRoleData, "warn"), vol(diskRoleSys, "warn")}
	}, add)
	w.patrol()
	if n := len(*got); n != 2 {
		t.Fatalf("two roles crossing should notify twice: %d, want 2", n)
	}
	w.patrol()
	if n := len(*got); n != 2 {
		t.Fatalf("same-level patrol re-notified: %d, want 2", n)
	}
}

// TestDiskLevelOf 档位判定与阈值常量（>80 warn、>90 crit，边界值本身属低档）
func TestDiskLevelOf(t *testing.T) {
	cases := map[float64]string{
		0: "ok", 80: "ok", 80.1: "warn", 85: "warn", 90: "warn", 90.1: "crit", 100: "crit",
	}
	for pct, want := range cases {
		if got := diskLevelOf(pct); got != want {
			t.Fatalf("diskLevelOf(%v) = %q, want %q", pct, got, want)
		}
	}
}

// TestDiskVolumes 真实采集面：数据盘必在且口径自洽；系统盘默认同卷 →
// 去重后仅一条（数据盘）；SC_SYS_DISK_PATH 指到同卷另一目录仍去重
// （真异卷样本依赖机器分盘布局，不做强断言）
func TestDiskVolumes(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())

	t.Run("default same volume dedupes to data only", func(t *testing.T) {
		t.Setenv("CC_SYS_DISK_PATH", "")
		vs := diskVolumes()
		if len(vs) != 1 {
			t.Fatalf("volumes = %d, want 1 (data): %+v", len(vs), vs)
		}
		v := vs[0]
		if v.Role != diskRoleData {
			t.Fatalf("role = %q, want data", v.Role)
		}
		if v.TotalMB == 0 || v.UsedMB > v.TotalMB {
			t.Fatalf("inconsistent usage: used %d / total %d", v.UsedMB, v.TotalMB)
		}
		if v.Level != diskLevelOf(v.UsedPercent) {
			t.Fatalf("level %q disagrees with percent %v", v.Level, v.UsedPercent)
		}
	})

	t.Run("sys path on same volume still dedupes", func(t *testing.T) {
		t.Setenv("CC_SYS_DISK_PATH", t.TempDir())
		vs := diskVolumes()
		if len(vs) != 1 {
			t.Fatalf("volumes = %d, want 1 (same volume): %+v", len(vs), vs)
		}
	})

	t.Run("nonexist sys path skipped without error", func(t *testing.T) {
		t.Setenv("CC_SYS_DISK_PATH", t.TempDir()+"/no-such-dir")
		vs := diskVolumes()
		if len(vs) != 1 || vs[0].Role != diskRoleData {
			t.Fatalf("volumes = %+v, want data only", vs)
		}
	})
}

// TestHumanMB 容量格式（1024 进制，通知明细与面板同基）
func TestHumanMB(t *testing.T) {
	cases := map[uint64]string{
		512: "512 MB", 2048: "2.00 GB", 1572864: "1.50 TB",
	}
	for in, want := range cases {
		if got := humanMB(in); got != want {
			t.Fatalf("humanMB(%d) = %q, want %q", in, got, want)
		}
	}
}
