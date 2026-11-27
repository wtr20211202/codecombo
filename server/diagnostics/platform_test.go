package diagnostics

import (
	"strings"
	"testing"
	"time"
)

// 平台命令表纯数据化 + GOOS 注入三分支（P-20261122-10 必改C 纪律；
// P-20261122-11 S2b 扩深度采样后同表对拍）：表结构可对拍、跨平台不派发、
// Windows 基线不含 chcp / 进程树，深度采样项带输出上限。
func TestPlatformCommandsPerGOOS(t *testing.T) {
	t.Run("windows baseline", func(t *testing.T) {
		env := platformEnv{GOOS: "windows", UID: -1, ExeBase: "codecombo.exe"}
		cmds := platformCommands(env)
		if len(cmds) != 5 {
			t.Fatalf("windows table = %d entries, want 5 (ver + sc query + netstat + wmic + optional CIM)", len(cmds))
		}
		ids := map[string]platformCommand{}
		for _, c := range cmds {
			if c.GOOS != "windows" {
				t.Fatalf("%s tied to GOOS %q, want windows only", c.ID, c.GOOS)
			}
			if len(c.Args) == 0 {
				t.Fatalf("%s has empty argv", c.ID)
			}
			for _, a := range c.Args {
				// chcp 纪律：改的是子进程码页且对内置命令输出无益（评审定稿）
				if a == "chcp" || a == "65001" {
					t.Fatalf("%s must not use chcp: %v", c.ID, c.Args)
				}
				if a == "ps" {
					t.Fatalf("%s must not run a process tree on Windows (S2b ruling): %v", c.ID, c.Args)
				}
			}
			ids[c.ID] = c
		}
		ver, ok := ids["windows-ver"]
		if !ok || strings.Join(ver.Args, " ") != "cmd /c ver" {
			t.Fatalf("windows-ver = %v, want `cmd /c ver`", ver.Args)
		}
		svc, ok := ids["windows-service"]
		if !ok || strings.Join(svc.Args, " ") != "sc query Codecombo" {
			t.Fatalf("windows-service = %v, want `sc query Codecombo`", svc.Args)
		}
		if got := strings.Join(ids["windows-listeners"].Args, " "); got != "netstat -ano -p tcp" {
			t.Fatalf("windows-listeners = %q, want netstat branch", got)
		}
		if ids["windows-listeners"].Filter != filterListenerRows {
			t.Fatal("windows-listeners must be filtered to LISTENING rows (netstat prints all TCP states)")
		}
		if !ids["windows-listeners"].Optional || !ids["windows-memory"].Optional {
			t.Fatal("listeners/memory on Windows must be optional (absent tool -> skipped)")
		}
		if !ids["windows-os-cim"].Optional {
			t.Fatal("windows-os-cim must be optional (3s-or-skip, not a failure)")
		}
	})

	t.Run("linux", func(t *testing.T) {
		env := platformEnv{GOOS: "linux", Unit: "codecombo.service", ExeBase: "codecombo"}
		cmds := platformCommands(env)
		byID := map[string]platformCommand{}
		for _, c := range cmds {
			if c.GOOS != "linux" {
				t.Fatalf("%s tied to %q", c.ID, c.GOOS)
			}
			byID[c.ID] = c
		}
		if got := strings.Join(byID["uname"].Args, " "); got != "uname -a" {
			t.Fatalf("linux uname = %q, want `uname -a` (S2b)", got)
		}
		// #26 判别式：KillMode 必须来自实际托管单元
		unitArgs := strings.Join(byID["systemd-unit"].Args, " ")
		if !strings.HasPrefix(unitArgs, "systemctl show -p Restart,KillMode,Type,User,") ||
			!strings.HasSuffix(unitArgs, " codecombo.service") {
			t.Fatalf("systemd-unit args = %q", unitArgs)
		}
		// P-20261124-1 S3①：监管/资源属性扩展（重启次数/退出码/内存/任务数/IO/NOFILE）
		for _, prop := range []string{"NRestarts", "ExecMainStatus", "ActiveEnterTimestamp", "MemoryCurrent", "TasksCurrent", "IOReadBytes", "IOWriteBytes", "LimitNOFILE"} {
			if !strings.Contains(unitArgs, prop) {
				t.Fatalf("systemd-unit args missing %s: %q", prop, unitArgs)
			}
		}
		// journal 唯一探针：deep 模式放宽到 8s（不加第二个 journal 探针）
		if byID["systemd-journal"].DeepTimeout != 8*time.Second {
			t.Fatalf("systemd-journal deep timeout = %v, want 8s", byID["systemd-journal"].DeepTimeout)
		}
		// dmesg 只作 deep-only 可选探针
		if cmd, ok := byID["dmesg-tail"]; !ok || !cmd.DeepOnly {
			t.Fatal("dmesg-tail must exist and be deep-only")
		}
		if got := strings.Join(byID["systemd-journal"].Args, " "); got != "journalctl -u codecombo.service -n 200 --no-pager" {
			t.Fatalf("systemd-journal args = %q", got)
		}
		if got := strings.Join(byID["listeners"].Args, " "); got != "ss -ltnp" {
			t.Fatalf("linux listeners = %q, want ss branch", got)
		}
		if got := strings.Join(byID["process-tree"].Args, " "); got != "ps -axo pid,ppid,etime,command" {
			t.Fatalf("linux process-tree = %q", got)
		}
		if byID["process-tree"].Filter != filterProcessTree {
			t.Fatal("process-tree must be filtered (never ship the full ps table)")
		}
		// S2b 评审裁定：删 cgroup memory.stat（层级读取贵且被 /proc/meminfo 覆盖）
		for _, c := range cmds {
			if strings.Contains(strings.Join(c.Args, " "), "memory.stat") || strings.Contains(strings.Join(c.Args, " "), "cgroup") {
				t.Fatalf("%s still probes cgroup memory.stat: %v", c.ID, c.Args)
			}
		}
		// 进程树/监听表/journal 都必须有界（输出面扩大后的硬纪律）
		for _, id := range []string{"systemd-journal", "listeners", "process-tree"} {
			c := byID[id]
			if c.MaxLines == 0 && c.MaxBytes == 0 {
				t.Fatalf("%s must declare an output cap", id)
			}
		}
	})

	t.Run("linux unit detected from supervisor", func(t *testing.T) {
		env := platformEnv{GOOS: "linux", Unit: "custom-host.service"}
		for _, c := range platformCommands(env) {
			if c.ID == "systemd-unit" && !strings.Contains(strings.Join(c.Args, " "), "custom-host.service") {
				t.Fatalf("systemd-unit must query the detected unit, got %v", c.Args)
			}
		}
	})

	t.Run("darwin", func(t *testing.T) {
		env := platformEnv{GOOS: "darwin", UID: 501, LaunchdLabel: "com.codecombo", ExeBase: "codecombo"}
		cmds := platformCommands(env)
		got := []string{}
		byID := map[string]platformCommand{}
		for _, c := range cmds {
			if c.GOOS != "darwin" {
				t.Fatalf("%s tied to %q", c.ID, c.GOOS)
			}
			got = append(got, strings.Join(c.Args, " "))
			byID[c.ID] = c
		}
		want := []string{
			"uname -a",
			"sw_vers",
			"launchctl print gui/501/com.codecombo",
			"lsof -nP -iTCP -sTCP:LISTEN",
			"ps -axo pid,ppid,etime,command",
			"sysctl -n hw.memsize",
		}
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("darwin commands = %v, want %v", got, want)
		}
		job := byID["launchd-job"]
		if job.MaxLines != 200 || job.MaxBytes != 32<<10 {
			t.Fatalf("launchd-job caps = %d lines / %d bytes, want 200 / 32KiB (S2b ruling)", job.MaxLines, job.MaxBytes)
		}
		// log show 绝不自动跑：命令表里不能出现
		for _, c := range cmds {
			if strings.Contains(strings.Join(c.Args, " "), "log show") {
				t.Fatalf("%s must not run `log show` automatically", c.ID)
			}
		}
	})

	t.Run("darwin without uid skips launchd domain", func(t *testing.T) {
		cmds := platformCommands(platformEnv{GOOS: "darwin", UID: -1})
		for _, c := range cmds {
			if c.ID == "launchd-job" {
				t.Fatal("launchd-job requires a valid gui/<uid> domain")
			}
		}
	})

	t.Run("unlisted GOOS", func(t *testing.T) {
		if cmds := platformCommands(platformEnv{GOOS: "freebsd"}); len(cmds) != 0 {
			t.Fatalf("freebsd table = %+v, want empty (never guess platform semantics)", cmds)
		}
	})
}

// 解码：合法 UTF-8 原样；非 UTF-8（Windows 控制台码页）剥非 ASCII 并留 note
func TestDecodeCommandOutput(t *testing.T) {
	out, note := decodeCommandOutput([]byte("Microsoft Windows [Version 10.0.26200.1]\r\n"))
	if note != "" {
		t.Fatalf("valid UTF-8 got note %q", note)
	}
	if out != "Microsoft Windows [Version 10.0.26200.1]" {
		t.Fatalf("out = %q", out)
	}

	// GBK 编码的「版本」两字节 + ASCII 骨架
	raw := append([]byte("Microsoft Windows [ "), 0xb0, 0xe6, 0xb1, 0xbe, ' ', '1', '0', ']')
	out, note = decodeCommandOutput(raw)
	if note == "" {
		t.Fatal("non-UTF-8 output must carry a decode note (manifest visibility)")
	}
	if !strings.Contains(out, "Microsoft Windows [") || !strings.Contains(out, "10]") {
		t.Fatalf("ASCII skeleton lost: %q", out)
	}
	if strings.ContainsRune(out, '\uFFFD') || strings.Contains(out, "\xb0") {
		t.Fatalf("non-ASCII bytes must be stripped, got %q", out)
	}
}

// 级别/模块/时间戳解析：slog 文本 handler 形态 + 旧方括号形态
func TestLogLineParsers(t *testing.T) {
	line := `time=2026-11-22T10:00:01.500+08:00 level=ERROR msg="update: rollback triggered" err="boom"`
	if got := levelOf(line); got != "ERROR" {
		t.Fatalf("levelOf = %q, want ERROR", got)
	}
	if got := moduleOf(line); got != "update" {
		t.Fatalf("moduleOf = %q, want update", got)
	}
	if got := timestampOf(line); got != "2026-11-22T10:00:01.500+08:00" {
		t.Fatalf("timestampOf = %q", got)
	}

	legacy := "2026-11-22 10:00:02 [WARN] watcher degraded"
	if got := levelOf(legacy); got != "WARN" {
		t.Fatalf("legacy levelOf = %q, want WARN", got)
	}
	if got := timestampOf(legacy); got != "2026-11-22 10:00:02" {
		t.Fatalf("legacy timestampOf = %q", got)
	}
	if got := levelOf("plain line without level"); got != "" {
		t.Fatalf("plain levelOf = %q, want empty", got)
	}
}
