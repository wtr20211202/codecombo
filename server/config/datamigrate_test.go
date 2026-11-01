package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// writeFakePid 写一个 pid 文件（首行 pid，模拟 app 写入格式；第二行端口）
func writeFakePid(t *testing.T, dir, name string, pid int) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "1234\n9999\n" // pid 行实际值由参数注入
	if pid > 0 {
		content = itoa(pid) + "\n9999\n"
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}

func seedLegacyDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "data", "lock"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "master-key"), []byte("k"+dir), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"port":19999}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "data", "lock", "config.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

// resolveMigrationTarget 迁移路由（实机缺陷 2026-10-25 回归锁）：默认解析、
// 显式旧默认形态、显式新默认都走迁移（目标=新默认）；只有显式真外部路径 skip。
// 初版实现把「解析结果 ≠ 旧默认」一律早退 skip——默认路径与 restart-real 的
// 显式 -d ~/.codecombo 全被误判外部路径，真实形态下迁移永不触发
func TestResolveMigrationTarget(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	newDefault := filepath.Join(root, "new")
	external := filepath.Join(root, "e2e-data")

	// 默认解析（无显式 env）：resolved 恒等于新默认，仍须走迁移
	if target, skip := resolveMigrationTarget(legacy, newDefault, newDefault, false); skip || !samePath(target, newDefault) {
		t.Fatalf("default resolution must migrate to newDefault, got target=%q skip=%v", target, skip)
	}
	// 显式旧默认形态（远端旧 systemd unit 下发 SC_DATA_DIR=~/.simple-coding）
	if target, skip := resolveMigrationTarget(legacy, legacy, newDefault, true); skip || !samePath(target, newDefault) {
		t.Fatalf("explicit legacy form must migrate, got target=%q skip=%v", target, skip)
	}
	// 显式新默认（restart-real 启动器 -d ~/.codecombo）——缺陷形态回归锁
	if target, skip := resolveMigrationTarget(legacy, newDefault, newDefault, true); skip || !samePath(target, newDefault) {
		t.Fatalf("explicit new-default must migrate, got target=%q skip=%v", target, skip)
	}
	// 显式真外部路径（e2e 分片 .e2e-data / 多目录用户）：skip 直用
	if target, skip := resolveMigrationTarget(legacy, external, newDefault, true); !skip || !samePath(target, external) {
		t.Fatalf("external path must skip, got target=%q skip=%v", target, skip)
	}
	// Windows 大小写不敏感同判：显式旧默认不同大小写形态仍走迁移
	if runtime.GOOS == "windows" {
		mixed := filepath.Join(root, "OLD")
		if target, skip := resolveMigrationTarget(legacy, mixed, newDefault, true); skip || !samePath(target, newDefault) {
			t.Fatalf("case-variant legacy form must migrate on windows, got target=%q skip=%v", target, skip)
		}
	}
}

// 态 2b：目标为启动器预创建的空壳（config.Load MkdirAll 的 <dir>/data 骨架）
// → 清壳后原子 rename，保持与「目标不存在」一致的原子语义（stop→start 启动
// 链实测形态）
func TestMigrateRenameAfterPrecreatedEmptyShell(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	seedLegacyDir(t, legacy)
	// 空壳骨架：Load 预创建 <dir> 与 <dir>/data，两级皆无任何文件
	if err := os.MkdirAll(filepath.Join(target, "data"), 0o700); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy dir should be gone, err=%v", err)
	}
	data, err := os.ReadFile(filepath.Join(target, "master-key"))
	if err != nil || string(data) != "k"+legacy {
		t.Fatalf("master-key not moved: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(target, "data", "lock", "config.json")); err != nil {
		t.Fatalf("legacy nested content must replace empty skeleton: %v", err)
	}
	// 幂等：再跑一次 no-op
	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("second run should be no-op: %v", err)
	}
}

// 空壳判定：文件/符号链接形态的条目存在即非空壳（含真实数据的双目录走合并）
func TestIsEmptyDirShell(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !isEmptyDirShell(root) {
		t.Fatal("nested empty dirs should be a shell")
	}
	if err := os.WriteFile(filepath.Join(root, "a", "b", "f"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if isEmptyDirShell(root) {
		t.Fatal("any regular file anywhere disqualifies the shell")
	}
	if _, err := os.Stat(filepath.Join(root, "a", "b", "f")); err != nil {
		t.Fatalf("predicate must not mutate: %v", err)
	}
}

// 态 1：旧目录不存在 → no-op
func TestMigrateLegacyAbsent(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("expect nil, got %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("target should not be created, err=%v", err)
	}
}

// 态 2：旧目录存在 + 目标不存在 → 原子 rename 整体搬移
func TestMigrateAtomicRename(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	seedLegacyDir(t, legacy)

	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy dir should be gone, err=%v", err)
	}
	data, err := os.ReadFile(filepath.Join(target, "master-key"))
	if err != nil || string(data) != "k"+legacy {
		t.Fatalf("master-key not moved: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(target, "data", "lock", "config.json")); err != nil {
		t.Fatalf("nested content not moved: %v", err)
	}
	// 幂等：再跑一次 no-op
	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("second run should be no-op: %v", err)
	}
}

// 态 3：双侧并存（远端升级脚手架：目标侧只有 bin/ 新二进制）→ 逐条目合并，
// 目标侧独有条目保留、旧目录内容并入、旧目录移除
func TestMigrateMergeWithExistingTarget(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	seedLegacyDir(t, legacy)
	// 目标侧脚手架：bin/codecombo（升级链先把新二进制装进新目录）
	if err := os.MkdirAll(filepath.Join(target, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "bin", "codecombo"), []byte("newbin"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy dir should be removed after merge, err=%v", err)
	}
	if data, err := os.ReadFile(filepath.Join(target, "bin", "codecombo")); err != nil || string(data) != "newbin" {
		t.Fatalf("target-only entry lost: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(target, "master-key")); err != nil || string(data) != "k"+legacy {
		t.Fatalf("legacy master-key not merged: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "data", "lock", "config.json")); err != nil {
		t.Fatalf("legacy nested content not merged: %v", err)
	}
}

// 态 3b：合并中断恢复——legacy 半搬状态再跑续完（幂等）
func TestMigrateMergeResumesAfterInterruption(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	seedLegacyDir(t, legacy)
	// 模拟中断：master-key 已搬走、config.json 与 data/ 还在旧目录
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(legacy, "master-key"), filepath.Join(target, "master-key")); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy should be gone after resume, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "master-key")); err != nil {
		t.Fatalf("pre-moved entry preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "config.json")); err != nil {
		t.Fatalf("remaining entries merged: %v", err)
	}
}

// 态 4：旧实例存活（pid 文件指向活进程不可稳定模拟——用「当前测试进程自身」
// 的 pid 写入，proc.Alive(自 pid) 恒真）→ 拒绝迁移
func TestMigrateRefusedWhenLegacyRunning(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	seedLegacyDir(t, legacy)
	writeFakePid(t, legacy, legacyPidFileName, os.Getpid())

	err := migrateLegacyDataDir(legacy, target)
	if err == nil {
		t.Fatal("expect refusal, got nil")
	}
	if !errors.Is(err, ErrLegacyInstanceRunning) {
		t.Fatalf("expect ErrLegacyInstanceRunning, got %v", err)
	}
	// 拒绝时不得动盘
	if _, serr := os.Stat(filepath.Join(legacy, "master-key")); serr != nil {
		t.Fatalf("legacy dir must stay untouched on refusal: %v", serr)
	}
	if _, serr := os.Stat(target); !os.IsNotExist(serr) {
		t.Fatal("target must not be created on refusal")
	}
}

// 新名 pid 文件同样参与存活预检（防旧目录里已是新格式的中间态漏检）
func TestMigrateRefusedChecksNewPidNameToo(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	seedLegacyDir(t, legacy)
	writeFakePid(t, legacy, pidFileName, os.Getpid())

	if err := migrateLegacyDataDir(legacy, target); !errors.Is(err, ErrLegacyInstanceRunning) {
		t.Fatalf("expect ErrLegacyInstanceRunning via new pid name, got %v", err)
	}
}

// skip 规则：目标为真外部路径时旧目录不迁移（EnsureDataDirMigrated 层语义，
// 这里直接验证纯函数在外部目标下的保守 no-op 由调用层 skip 保证——引擎本身
// 只按入参行事，本测试锁定「同路径入参零操作」防误用）
func TestMigrateSamePathNoop(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	seedLegacyDir(t, legacy)
	if runtime.GOOS == "windows" {
		if err := migrateLegacyDataDir(legacy, filepath.Join(root, "OLD")); err != nil {
			t.Fatalf("case-insensitive same path should no-op: %v", err)
		}
	} else {
		if err := migrateLegacyDataDir(legacy, legacy); err != nil {
			t.Fatalf("same path should no-op: %v", err)
		}
	}
	if _, err := os.Stat(filepath.Join(legacy, "master-key")); err != nil {
		t.Fatalf("content must stay: %v", err)
	}
}

// 同名文件冲突：旧目录内容为准，目标侧文件让位保留（两份都不丢）
func TestMigrateMergeConflictLegacyWins(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old")
	target := filepath.Join(root, "new")
	seedLegacyDir(t, legacy)
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "config.json"), []byte(`{"port":1}`), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := migrateLegacyDataDir(legacy, target); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(target, "config.json"))
	if err != nil || string(data) != `{"port":19999}` {
		t.Fatalf("legacy should win conflict: data=%q err=%v", data, err)
	}
	if _, err := os.Stat(filepath.Join(target, "config.json.codecombo-premerge")); err != nil {
		t.Fatalf("target copy should be kept aside: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy should be gone: %v", err)
	}
}

// DataDir 双读：CC_ 优先、SC_ 回落并记账
func TestDataDirDualRead(t *testing.T) {
	t.Setenv("CC_DATA_DIR", "")
	t.Setenv("SC_DATA_DIR", "")
	ResetForTest()
	t.Cleanup(ResetForTest)

	if LegacyEnvUsed() {
		t.Fatal("no fallback expected before any read")
	}
	_ = DataDir() // 默认路径
	if LegacyEnvUsed() {
		t.Fatal("default path is not a fallback")
	}

	t.Setenv("SC_DATA_DIR", filepath.Join(t.TempDir(), "via-sc"))
	ResetForTest()
	if got := DataDir(); !filepath.IsAbs(got) || filepath.Base(got) != "via-sc" {
		t.Fatalf("SC_ fallback not honored: %q", got)
	}
	if !LegacyEnvUsed() {
		t.Fatal("SC_ fallback should be recorded")
	}

	t.Setenv("CC_DATA_DIR", filepath.Join(t.TempDir(), "via-cc"))
	ResetForTest()
	if got := DataDir(); filepath.Base(got) != "via-cc" {
		t.Fatalf("CC_ should take priority: %q", got)
	}
	if LegacyEnvUsed() {
		t.Fatal("CC_ hit should not record fallback")
	}
}

// OpenLegacyPidCompat：新名优先、旧名回落、全缺返回空串
func TestOpenLegacyPidCompat(t *testing.T) {
	root := t.TempDir()
	if got := OpenLegacyPidCompat(root); got != "" {
		t.Fatalf("expect empty, got %q", got)
	}
	writeFakePid(t, root, legacyPidFileName, 0)
	got := OpenLegacyPidCompat(root)
	if filepath.Base(got) != legacyPidFileName {
		t.Fatalf("expect legacy name fallback, got %q", got)
	}
	writeFakePid(t, root, pidFileName, 0)
	got = OpenLegacyPidCompat(root)
	if filepath.Base(got) != pidFileName {
		t.Fatalf("expect new name priority, got %q", got)
	}
}
