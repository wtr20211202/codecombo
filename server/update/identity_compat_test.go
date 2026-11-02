package update

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// P-20261025-1 运行时标识切换的更新链兼容矩阵单测：
// 产物名双认 / pid 文件多候选 / 盘上名归一约束 / 更新子进程 env 双名。

// 〔GitHub 更新源〕产物名模板双认：正名优先、旧名回落，伴生校验资产随匹配名
func TestAssetNameCandidates(t *testing.T) {
	got := assetNameCandidates("linux", "amd64")
	if len(got) != 2 || got[0] != "codecombo-linux-amd64" || got[1] != "simple-coding-linux-amd64" {
		t.Fatalf("candidates = %v", got)
	}
	if assetName("windows", "amd64") != "codecombo-windows-amd64.exe" {
		t.Fatalf("canonical windows name = %s", assetName("windows", "amd64"))
	}
}

// 〔本机 apply〕更新成功后的盘上名归一：
//   - 旧产品名前缀 → 原子换名 codecombo 同尾段
//   - 非「simple-coding」前缀（e2e harness 名等）不动
//   - systemd 托管不换（unit ExecStart 钉旧路径）
func TestCanonicalizeBinaryName(t *testing.T) {
	dir := t.TempDir()

	// 守卫注入：本测试只验改名规则，不验 cgroup 探测（后者是宿主环境函数，
	// 直接调用会在 GitHub runner 等宿主即 systemd 服务的环境里误拦——实锚）
	origFn := systemdUnitOursFn
	systemdUnitOursFn = func() string { return "" }
	t.Cleanup(func() { systemdUnitOursFn = origFn })

	// 旧名 → 换名成功
	legacy := filepath.Join(dir, "simple-coding")
	if err := os.WriteFile(legacy, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	canonicalizeBinaryName(legacy)
	if _, err := os.Stat(filepath.Join(dir, "codecombo")); err != nil {
		t.Fatalf("legacy binary not renamed: %v", err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatal("legacy name should be gone after rename")
	}

	// 带平台尾段的 dist 产物名 → 同规则归一
	dist := filepath.Join(dir, "simple-coding-linux-amd64")
	if err := os.WriteFile(dist, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	canonicalizeBinaryName(dist)
	if _, err := os.Stat(filepath.Join(dir, "codecombo-linux-amd64")); err != nil {
		t.Fatalf("dist artifact not renamed: %v", err)
	}

	// 非产品名（e2e harness 二进制）→ 不动
	foreign := filepath.Join(dir, "polish-e2e-9999.exe")
	if err := os.WriteFile(foreign, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	canonicalizeBinaryName(foreign)
	if _, err := os.Stat(foreign); err != nil {
		t.Fatal("non-product binary must keep its name")
	}
}

// 守卫本身：部署器装的两类单元让位改名；泛化 .service（runner 宿主等）不拦
func TestCanonicalizeGuardUnitScope(t *testing.T) {
	origFn := systemdUnitOursFn
	t.Cleanup(func() { systemdUnitOursFn = origFn })

	dir := t.TempDir()
	cases := []struct {
		unit     string // cgroup 实况（文档性，标注语义）
		ours     string // systemdUnitOursFn 注入值 = 真实函数过滤后的返回
		wantKept bool   // 旧名二进制是否应保留（部署器单元 = ExecStart 钉路径 → 保留）
	}{
		{"", "", false},                                          // 非 systemd 环境（裸进程/Windows/容器）→ 归一改名
		{"nginx.service", "", false},                             // 宿主上无关的服务（runner 等）被过滤 → 同样改名
		{"codecombo.service", "codecombo.service", true},         // 部署器正名单元 → 让位
		{"simple-coding.service", "simple-coding.service", true}, // 部署器旧名单元 → 让位
	}
	for _, tc := range cases {
		legacy := filepath.Join(dir, "simple-coding-guard-"+strings.ReplaceAll(tc.ours+tc.unit, ".", "-"))
		if err := os.WriteFile(legacy, []byte("bin"), 0o755); err != nil {
			t.Fatal(err)
		}
		systemdUnitOursFn = func() string { return tc.ours }
		canonicalizeBinaryName(legacy)
		if tc.wantKept {
			if _, err := os.Stat(legacy); err != nil {
				t.Errorf("unit %q: legacy binary should stay (ExecStart pinned)", tc.unit)
			}
		} else {
			if _, err := os.Stat(legacy); !os.IsNotExist(err) {
				t.Errorf("unit %q: legacy binary must be renamed to codecombo", tc.unit)
			}
		}
	}
}

// 〔健康检查〕pid 文件多候选：更新子进程 env 下发的 dd（旧目录）迁移后消失时，
// 回落 config.DataDir() 的新名 pid 文件仍能取到回环端口
func TestReadPIDLoopbackPortCandidates(t *testing.T) {
	t.Setenv("CC_DATA_DIR", "")
	t.Setenv("SC_DATA_DIR", "")
	oldDir := t.TempDir()
	newDir := t.TempDir()
	t.Setenv("CC_DATA_DIR", newDir)

	// dd（旧目录）只有旧名文件且无第三行 → 0
	if err := os.WriteFile(filepath.Join(oldDir, "simple-coding.pid"), []byte("1\n9999\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readPIDLoopbackPort(oldDir); got != 0 {
		t.Fatalf("two-line pid file should yield 0, got %d", got)
	}

	// dd 旧名文件带第三行 → 命中
	if err := os.WriteFile(filepath.Join(oldDir, "simple-coding.pid"), []byte("1\n9999\n18000"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readPIDLoopbackPort(oldDir); got != 18000 {
		t.Fatalf("legacy pid loopback = %d, want 18000", got)
	}

	// dd 已随迁移消失 → 回落 DataDir 新名文件
	if got := readPIDLoopbackPort(filepath.Join(oldDir, "gone")); got != 0 {
		t.Fatalf("missing dd should yield 0, got %d", got)
	}
	if err := os.WriteFile(filepath.Join(newDir, "codecombo.pid"), []byte("2\n9999\n18001"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readPIDLoopbackPort(filepath.Join(oldDir, "gone")); got != 18001 {
		t.Fatalf("post-migration fallback loopback = %d, want 18001", got)
	}
}

// 〔更新子进程 env〕正名 + 旧名双写下发，双读消费两侧都能取到
func TestUpdateSubprocessEnvDualName(t *testing.T) {
	t.Setenv(envUpdateDataDir, "")
	t.Setenv(envUpdateVersion, "")
	t.Setenv(envUpdatePrevVer, "")
	t.Setenv(envUpdateDataDirOld, "/legacy/dd")
	t.Setenv(envUpdateVersionOld, "0.0.2")
	t.Setenv(envUpdatePrevVerOld, "0.0.1")
	if got := getenvOr(envUpdateDataDir, envUpdateDataDirOld); got != "/legacy/dd" {
		t.Fatalf("legacy env fallback dd = %q", got)
	}
	if got := getenvOr(envUpdateVersion, envUpdateVersionOld); got != "0.0.2" {
		t.Fatalf("legacy env fallback version = %q", got)
	}
	t.Setenv(envUpdateDataDir, "/canonical/dd")
	if got := getenvOr(envUpdateDataDir, envUpdateDataDirOld); got != "/canonical/dd" {
		t.Fatalf("canonical env should win, got %q", got)
	}
	if !strings.HasPrefix(envUpdateDataDir, "CODECOMBO_") {
		t.Fatalf("canonical env name = %q", envUpdateDataDir)
	}
}
