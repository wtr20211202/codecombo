package remote

import (
	"testing"

	"codecombo/server/store"
)

// TestExtractDiagSnapshot 从既有诊断输出格式提取数值（与 DiagnoseText 同源产物，
// 不重跑命令）。各命令输出取真实工具的常见形态
func TestExtractDiagSnapshot(t *testing.T) {
	resp := diagnoseResp{OK: true, Items: []diagItem{
		{Key: "uptime", Label: "Uptime / Load", Output: " 14:22:01 up 5 days,  3:22,  1 user,  load average: 0.52, 0.58, 0.59"},
		{Key: "cpu", Label: "CPU", Output: "4\n top - 14:22:01 up 5 days\n%Cpu(s):  3.9 us,  1.3 sy,  0.0 ni, 94.2 id,  0.3 wa,  0.0 hi,  0.3 si,  0.0 st"},
		{Key: "memory", Label: "Memory", Output: "               total        used        free      shared  buff/cache   available\nMem:            7636        3112        1204         123        3319        4123\nSwap:           2047           0        2047"},
		{Key: "disk", Label: "Disk", Output: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/root        29G  6.6G   23G  23% /\ntmpfs           3.8G     0  3.8G   0% /dev/shm"},
		{Key: "failedServices", Label: "Failed services", Output: "systemd-modules-load.service loaded failed failed Load Kernel Modules\nnetworking.service loaded failed failed Raise network interfaces"},
	}}

	snap, ok := extractDiagSnapshot(resp)
	if !ok {
		t.Fatal("expected snapshot extracted")
	}
	if snap.Load1 != 0.52 || snap.Load5 != 0.58 || snap.Load15 != 0.59 {
		t.Errorf("load: got %v/%v/%v", snap.Load1, snap.Load5, snap.Load15)
	}
	if snap.CPUPercent != 5.8 {
		t.Errorf("cpu busy: expected 5.8, got %v", snap.CPUPercent)
	}
	if snap.MemUsedMB != 3112 {
		t.Errorf("mem used: expected 3112, got %d", snap.MemUsedMB)
	}
	if snap.DiskAvailMB != 23552 || snap.DiskTotalMB != 29696 { // 23G, 29G
		t.Errorf("disk: avail=%d total=%d", snap.DiskAvailMB, snap.DiskTotalMB)
	}
	if snap.FailedServices != 2 {
		t.Errorf("failed services: expected 2, got %d", snap.FailedServices)
	}
}

// TestExtractDiagSnapshot_EmptyNotStored 全军覆没（输出全为空/错误）不落历史
func TestExtractDiagSnapshot_EmptyNotStored(t *testing.T) {
	resp := diagnoseResp{OK: true, Items: []diagItem{
		{Key: "memory", Error: "exit 127: free: command not found"},
		{Key: "disk", Output: ""},
	}}
	if _, ok := extractDiagSnapshot(resp); ok {
		t.Error("expected no snapshot when nothing parsed")
	}
}

// TestParseDfRoot_WrappedLine df 不带 -P 时长设备名折成两行的兼容
func TestParseDfRoot_WrappedLine(t *testing.T) {
	out := "Filesystem      Size  Used Avail Use% Mounted on\n" +
		"/dev/mapper/vg--root\n" +
		"                 40G   30G   10G  75% /\n"
	avail, total := parseDfRoot(out)
	if avail != 10240 || total != 40960 {
		t.Errorf("wrapped line: avail=%d total=%d", avail, total)
	}
}

// TestParseDfRoot_NonRootFallback 无根挂载点时取首个可解析数据行
func TestParseDfRoot_NonRootFallback(t *testing.T) {
	out := "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sdb1        98G   4.2G   89G   5% /mnt/data\n"
	avail, total := parseDfRoot(out)
	if avail != 91136 || total != 100352 { // 89G, 98G
		t.Errorf("fallback: avail=%d total=%d", avail, total)
	}
	// 表头/纯文本不出数
	if a, _ := parseDfRoot("Filesystem Size Used Avail Use% Mounted on"); a != 0 {
		t.Errorf("header should not parse, got %d", a)
	}
}

// TestParseSizeMB 容量字面量 → MB
func TestParseSizeMB(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{"29G", 29696}, {"6.6G", 6758}, {"1024M", 1024}, {"500K", 0}, // 500K≈0.5MB 四舍五入 0? 0.488→0
		{"1.0T", 1048576}, {"0", 0}, {"", 0}, {"junk", 0}, {"75%", 0},
	}
	for _, c := range cases {
		if got := parseSizeMB(c.in); got != c.want {
			t.Errorf("parseSizeMB(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

// TestParseUptimeLoad 变体：无逗号分隔 / 缺失
func TestParseUptimeLoad(t *testing.T) {
	if l1, _, _ := parseUptimeLoad("load average: 1.10, 2.20, 3.30"); l1 != 1.10 {
		t.Errorf("expected 1.10, got %v", l1)
	}
	if l1, _, _ := parseUptimeLoad("load averages: 0.10 0.20 0.30"); l1 != 0.10 {
		t.Errorf("bsd style: expected 0.10, got %v", l1)
	}
	if l1, l5, l15 := parseUptimeLoad("no load info here"); l1 != 0 || l5 != 0 || l15 != 0 {
		t.Errorf("expected zeros, got %v %v %v", l1, l5, l15)
	}
}

// TestDiffDiagSnapshotInResponse 对比内联形态：prev+delta 组装（handler 侧语义）
func TestDiffDiagSnapshotInResponse(t *testing.T) {
	prev := store.DiagSnapshot{DiskAvailMB: 23552, MemUsedMB: 3112, Load1: 0.52}
	snap := store.DiagSnapshot{DiskAvailMB: 22528, MemUsedMB: 3368, Load1: 1.02}
	d := store.DiffDiagSnapshot(prev, snap)
	if d.DiskAvailMB != -1024 || d.MemUsedMB != 256 || d.Load1 != 0.5 {
		t.Errorf("unexpected delta: %+v", d)
	}
}
