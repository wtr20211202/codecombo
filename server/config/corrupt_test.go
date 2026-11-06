package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// config.json 损坏显式降级单测（P-20261006-10）：三态矩阵（不存在/损坏/正常）
// 外加读失败态的甄别（读不到 ≠ 损坏，不保全不登记）。ResetForTest 必须配合
// t.Setenv("CC_DATA_DIR", t.TempDir())（隔离纪律见 ResetForTest 注释）。

// seedConfigFile 写 DataDir/config.json 测试种子
func seedConfigFile(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

// TestLoadMissingConfigNormalFirstBoot 不存在 = 正常首启：默认种子生效、
// 不登记降级态、磁盘上无保全副本
func TestLoadMissingConfigNormalFirstBoot(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	ResetForTest()
	t.Cleanup(ResetForTest)

	cfg := Load()
	if cfg.Server.Port != 9999 || cfg.Server.Host != "127.0.0.1" {
		t.Fatalf("default seed not applied: port=%d host=%q", cfg.Server.Port, cfg.Server.Host)
	}
	if rep := CorruptionReport(); rep != nil {
		t.Fatalf("missing config must not register a corruption report, got %+v", rep)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), "corrupt-") {
			t.Fatalf("no preservation copy expected, found %s", e.Name())
		}
	}
}

// TestLoadCorruptConfigPreservesAndRegisters 损坏（手改尾逗号代表形态）：
// 默认配置启动 + 降级态登记 + 坏文件按原字节保全、原路径腾空
func TestLoadCorruptConfigPreservesAndRegisters(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	ResetForTest()
	t.Cleanup(ResetForTest)

	bad := `{"server": {"port": 7777,"host": "0.0.0.0",},}`
	seedConfigFile(t, dir, bad)

	cfg := Load()
	if cfg.Server.Port != 9999 {
		t.Fatalf("corrupt config must start with default port, got %d", cfg.Server.Port)
	}

	rep := CorruptionReport()
	if rep == nil {
		t.Fatal("corrupt config must register a corruption report")
	}
	if !rep.Preserved() {
		t.Fatalf("preservation should succeed on a writable dir, report = %+v", rep)
	}
	if base := filepath.Base(rep.PreservedPath); !strings.HasPrefix(base, "config.json.corrupt-") {
		t.Fatalf("preserved name = %q, want config.json.corrupt-<ts>", base)
	}
	// 报告路径经 DataDir 归一（P-20261106 短名尾巴修复后长形态是设计目标）：
	// runner TMP 短名（RUNNER~1）下期望值须同型归一，三形态容忍家族（踩坑 #5）
	wantPath := EvalSymlinksNormalized(filepath.Join(dir, "config.json"))
	if rep.Path != wantPath {
		t.Fatalf("report path = %q, want %q", rep.Path, wantPath)
	}
	if rep.Err == "" {
		t.Fatal("report must carry the language-neutral parse error")
	}

	// 保全留证完整性：原字节落副本、原路径腾空（后续保存写新文件自然安全）
	got, err := os.ReadFile(rep.PreservedPath)
	if err != nil {
		t.Fatalf("read preserved copy: %v", err)
	}
	if string(got) != bad {
		t.Fatalf("preserved content mismatch:\n got %q\nwant %q", got, bad)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.json")); !os.IsNotExist(err) {
		t.Fatalf("config.json should be gone after preservation (stat err = %v)", err)
	}
}

// TestLoadValidConfigApplies 正常配置：字段生效、不登记降级态、原文件不动
func TestLoadValidConfigApplies(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	ResetForTest()
	t.Cleanup(ResetForTest)

	good := `{"server": {"port": 8123, "host": "0.0.0.0"}}`
	seedConfigFile(t, dir, good)

	cfg := Load()
	if cfg.Server.Port != 8123 || cfg.Server.Host != "0.0.0.0" {
		t.Fatalf("valid config not applied: port=%d host=%q", cfg.Server.Port, cfg.Server.Host)
	}
	if rep := CorruptionReport(); rep != nil {
		t.Fatalf("valid config must not register a corruption report, got %+v", rep)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "config.json")); err != nil || string(data) != good {
		t.Fatalf("valid config must stay in place untouched (err = %v)", err)
	}
}

// TestLoadUnreadableConfigIsNotCorruption 读失败态（config.json 是目录——
// 三平台稳定的「读不到」构造）：默认启动但既不保全也不登记降级态——文件可能
// 完好，改名反而毁现场；该态只留 warn 日志
func TestLoadUnreadableConfigIsNotCorruption(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	ResetForTest()
	t.Cleanup(ResetForTest)

	if err := os.Mkdir(filepath.Join(dir, "config.json"), 0700); err != nil {
		t.Fatal(err)
	}

	cfg := Load()
	if cfg.Server.Port != 9999 {
		t.Fatalf("unreadable config must fall back to default port, got %d", cfg.Server.Port)
	}
	if rep := CorruptionReport(); rep != nil {
		t.Fatalf("unreadable ≠ corrupt: must not register a report, got %+v", rep)
	}
}

// TestCorruptionReportPreservedFlag 保全失败分支的形态契约（改名失败本身
// 平台相关难以单测移植构造——只读盘在 Windows 不阻断 rename——此处验证
// PreservedPath 空 ⟹ Preserved() false 的下游判定语义）
func TestCorruptionReportPreservedFlag(t *testing.T) {
	rep := &ConfigCorruption{Path: "/x/config.json", PreservedPath: "/x/config.json.corrupt-1", Err: "e"}
	if !rep.Preserved() {
		t.Fatal("non-empty PreservedPath must count as preserved")
	}
	rep.PreservedPath = ""
	if rep.Preserved() {
		t.Fatal("empty PreservedPath must not count as preserved")
	}
}

// TestLoadCorruptTypeMismatchResetsPartialUnmarshal 类型错误形态（合法 JSON
// 结构但字段类型不符——unmarshal 会部分填充后报错）：验证损坏分支整体收敛
// 回默认种子，不带半解析的脏字段启动
func TestLoadCorruptTypeMismatchResetsPartialUnmarshal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	ResetForTest()
	t.Cleanup(ResetForTest)

	seedConfigFile(t, dir, `{"server": {"port": "not-a-number", "host": "9.9.9.9"}}`)

	cfg := Load()
	if cfg.Server.Port != 9999 || cfg.Server.Host != "127.0.0.1" {
		t.Fatalf("type-mismatch config must fully reset to defaults: port=%d host=%q", cfg.Server.Port, cfg.Server.Host)
	}
	if CorruptionReport() == nil {
		t.Fatal("type-mismatch is corruption and must register a report")
	}
}
