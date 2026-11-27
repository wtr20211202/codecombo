package diagnostics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 平台深度采样的纯函数面（P-20261122-11 S2b）：输出裁剪 / 进程树过滤 /
// 机器内存解析 / 命令输出脱敏。命令派发本身不在这里跑真实平台命令——
// GOOS 三分支表由 platform_test.go 对拍，这里只钉行为语义。

func TestCapCommandOutput(t *testing.T) {
	lines := strings.Join([]string{"L1", "L2", "L3", "L4"}, "\n")
	out, note := capCommandOutput(lines, 2, 0)
	if out != "L1\nL2" || !strings.Contains(note, "2 lines") {
		t.Fatalf("line cap = %q / %q", out, note)
	}
	if !strings.Contains(note, "rerun the command manually") {
		t.Fatalf("cap note must tell the reader how to get the full output: %q", note)
	}

	out, note = capCommandOutput(strings.Repeat("x", 100), 0, 10)
	if len(out) > 10 || !strings.Contains(note, "10 B") {
		t.Fatalf("byte cap = %d / %q", len(out), note)
	}

	out, note = capCommandOutput("short", 200, 32<<10)
	if out != "short" || note != "" {
		t.Fatalf("un-capped output must pass through untouched: %q / %q", out, note)
	}
}

func TestFilterProcessTree(t *testing.T) {
	psOut := strings.Join([]string{
		"  PID  PPID     ELAPSED COMMAND",
		"  100     1       01:00 /usr/local/bin/codecombo --serve -p 9999",
		"  101     1       01:00 helper-not-ours --flag",
		"  102   100       00:10 tmux new-session -d -s aaa",
		"  103   100       00:09 tmux new-session -d -s bbb",
		"  104   100       00:08 tmux new-session -d -s ccc",
		"  105   100       00:07 tmux new-session -d -s ddd",
		"  106   100       00:06 /usr/local/bin/codecombo update --target 0.0.1",
	}, "\n")
	out, note := filterProcessTreeOutput(psOut, "codecombo")
	if !strings.Contains(out, "PID") {
		t.Fatalf("header must be kept: %q", out)
	}
	if strings.Count(out, "codecombo") != 2 {
		t.Fatalf("all codecombo lines must be kept: %q", out)
	}
	if strings.Contains(out, "helper-not-ours") {
		t.Fatalf("unrelated process leaked: %q", out)
	}
	if got := strings.Count(out, "tmux"); got != processTreeTmuxLines {
		t.Fatalf("tmux lines = %d, want %d", got, processTreeTmuxLines)
	}
	if !strings.Contains(note, "filtered to lines mentioning \"codecombo\"") {
		t.Fatalf("filter note missing: %q", note)
	}

	out, note = filterProcessTreeOutput("  PID PPID ELAPSED COMMAND\n  1 0 00:01 init\n", "codecombo")
	if out == "" || !strings.Contains(note, "no matching process") {
		t.Fatalf("zero-match must be explained, not dropped silently: %q / %q", out, note)
	}
}

func TestFilterListenerRows(t *testing.T) {
	raw := strings.Join([]string{
		"",
		"Active Connections",
		"",
		"  Proto  Local Address          Foreign Address        State           PID",
		"  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2552",
		"  TCP    127.0.0.1:1080         127.0.0.1:49282        ESTABLISHED     36596",
		"  TCP    127.0.0.1:1080         127.0.0.1:49284        TIME_WAIT       0",
		"  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       41612",
	}, "\n")
	out, note := filterListenerRowOutput(raw)
	if !strings.Contains(out, "Proto") {
		t.Fatalf("netstat header must be kept: %q", out)
	}
	if strings.Count(out, "LISTENING") != 2 || strings.Contains(out, "ESTABLISHED") || strings.Contains(out, "TIME_WAIT") {
		t.Fatalf("listener filter must drop non-listening rows: %q", out)
	}
	if !strings.Contains(note, "2 kept") {
		t.Fatalf("filter note = %q", note)
	}
	out, note = filterListenerRowOutput("  Proto  Local Address\n")
	if out == "" || !strings.Contains(note, "no listening TCP socket") {
		t.Fatalf("empty listener table must be explained: %q / %q", out, note)
	}
}

func TestProcessTreeFrom(t *testing.T) {
	win := processTreeFrom("windows", nil)
	if win == nil || win.Status != "skipped" || !strings.Contains(win.Note, "tasklist") {
		t.Fatalf("windows process tree must be explicitly skipped with a replacement hint: %+v", win)
	}
	got := processTreeFrom("linux", []CommandSample{
		{ID: "uname", Status: "ok", Output: "Linux"},
		{ID: "process-tree", Command: "ps -axo pid,ppid,etime,command", Status: "ok", Output: "  1 0 00:01 codecombo", Note: "filtered"},
	})
	if got == nil || got.Status != "ok" || !strings.Contains(got.Output, "codecombo") || got.Command == "" {
		t.Fatalf("unix process tree not carried through: %+v", got)
	}
	if pt := processTreeFrom("linux", nil); pt != nil {
		t.Fatalf("missing process-tree sample must not fabricate one: %+v", pt)
	}
}

func TestParseMeminfo(t *testing.T) {
	mem, note := parseMeminfo(`MemTotal:       16316332 kB
MemFree:          123456 kB
MemAvailable:    8123456 kB
Buffers:          100000 kB
`)
	if mem.TotalMB != 16316332/1024 || mem.AvailableMB != 8123456/1024 {
		t.Fatalf("meminfo parse = %+v", mem)
	}
	if note != "" {
		t.Fatalf("no fallback note expected, got %q", note)
	}

	// 老内核无 MemAvailable：回落 MemFree 并说明口径
	mem, note = parseMeminfo("MemTotal: 1024000 kB\nMemFree: 512000 kB\n")
	if mem.AvailableMB != 500 || !strings.Contains(note, "MemFree") {
		t.Fatalf("MemFree fallback = %+v / %q", mem, note)
	}
}

func TestMemoryParsers(t *testing.T) {
	mem, ok := parseSysctlBytes("17179869184\n")
	if !ok || mem.TotalMB != 16384 {
		t.Fatalf("sysctl parse = %+v ok=%t", mem, ok)
	}
	if _, ok := parseSysctlBytes("not-a-number"); ok {
		t.Fatal("garbage sysctl output must not parse")
	}

	mem, ok = parseWmicMemory("FreePhysicalMemory=4194304\r\nTotalVisibleMemorySize=16777216\r\n")
	if !ok || mem.TotalMB != 16384 || mem.AvailableMB != 4096 {
		t.Fatalf("wmic parse = %+v ok=%t", mem, ok)
	}
	if _, ok := parseWmicMemory("No Instance(s) Available."); ok {
		t.Fatal("empty wmic output must not parse")
	}
}

// 命令输出逐行脱敏：journalctl/launchctl print 是日志与 env 原文，
// 与 raw 日志同一口径（token 遮蔽 + DataDir 归一）
func TestRedactCommandText(t *testing.T) {
	dir := t.TempDir()
	red := NewRedactor(dir, true)
	raw := "path=" + dir + "/logs/a.log token=supersecret123\nplain line"
	out := redactCommandText(red, raw)
	if strings.Contains(out, "supersecret123") {
		t.Fatalf("token leaked through command output: %q", out)
	}
	if !strings.Contains(out, "$DATA_DIR") || !strings.Contains(out, "token=***") {
		t.Fatalf("command output not normalized/masked: %q", out)
	}
}

// 存储统计：顶层分解 + 只统计不读内容（data/ 是凭据库）
func TestCollectStorage(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{filepath.Join(dir, "data"), filepath.Join(dir, "logs"), filepath.Join(dir, "empty")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(dir, "data", "master-key"), "SECRET-MASTER-KEY")
	writeFile(t, filepath.Join(dir, "data", "cred.a"), "SECRET-CREDENTIAL")
	writeFile(t, filepath.Join(dir, "logs", "a.log"), "hello")
	writeFile(t, filepath.Join(dir, "config.json"), "SECRET-CONFIG")

	st, large := collectStorage(dir, &DiskSample{TotalMB: 100}, NewRedactor(dir, true),
		time.Date(2026, 11, 22, 12, 0, 0, 0, time.Local), time.Time{})
	// 大文件面复用同一次 walk：data/ 只计数不列名（凭据库红线）
	if large.DataFiles != 2 {
		t.Fatalf("data/ file count = %d, want 2 (names must never be listed)", large.DataFiles)
	}
	for _, f := range large.Top {
		if strings.Contains(f.Path, "master-key") || strings.Contains(f.Path, "data/") {
			t.Fatalf("data/ file name leaked into large-files: %s", f.Path)
		}
	}
	byName := map[string]StorageDirSample{}
	for _, d := range st.Dirs {
		byName[d.Name] = d
	}
	if got := byName["data"]; got.Entries != 2 || got.Bytes != int64(len("SECRET-MASTER-KEY")+len("SECRET-CREDENTIAL")) {
		t.Fatalf("data/ stats = %+v", got)
	}
	if got := byName["logs"]; got.Entries != 1 || got.Bytes != 5 {
		t.Fatalf("logs/ stats = %+v", got)
	}
	if _, ok := byName["empty"]; !ok {
		t.Fatal("empty top-level dir must still be listed (0 entries is a fact)")
	}
	if got := byName["config.json"]; got.Entries != 1 {
		t.Fatalf("top-level file stats = %+v", got)
	}
	if st.Total.Entries != 7 { // 3 top-level dirs + 3 files under them + config.json
		t.Fatalf("total entries = %d, want 7", st.Total.Entries)
	}
	if st.Disk == nil || st.Disk.TotalMB != 100 {
		t.Fatalf("disk not carried through: %+v", st.Disk)
	}
	if st.DataDir != "$DATA_DIR" {
		t.Fatalf("data dir must be normalized, got %q", st.DataDir)
	}
	var found bool
	for _, n := range st.Notes {
		if strings.Contains(n, "credential store") {
			found = true
		}
	}
	if !found {
		t.Fatalf("data/ must be labeled as the credential store: %v", st.Notes)
	}

	out := renderStorageJSON(st)
	for _, secret := range []string{"SECRET-MASTER-KEY", "SECRET-CREDENTIAL", "SECRET-CONFIG"} {
		if strings.Contains(out, secret) {
			t.Fatalf("storage.json leaked file content %q", secret)
		}
	}
	if !strings.Contains(out, "\"data\"") {
		t.Fatalf("storage.json missing data/ breakdown: %q", out)
	}
}

// 机器内存：Linux 走 /proc/meminfo 文件读，缺失时如实 note（不标红）
func TestLinuxMachineMemoryMissing(t *testing.T) {
	// 测试进程若跑在 Linux 上会读到真实 meminfo（ok）；Windows/macOS 上
	// os.ReadFile("/proc/meminfo") 必然失败——只断言「不 panic 且 source 正确」
	mem := linuxMachineMemory(NewRedactor(t.TempDir(), true))
	if mem == nil || mem.Source != "/proc/meminfo" {
		t.Fatalf("linux memory sample = %+v", mem)
	}
}
