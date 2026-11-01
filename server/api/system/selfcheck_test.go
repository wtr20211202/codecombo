package system

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 环境体检单测（P-20261003-317）：条目形态与状态语义是前端三态渲染与 agent
// 程序化消费的契约——稳定键集合/三态词表/明细非空在此固化；真实工具链
// （git/lfs/tmux/磁盘）有无随环境变化，断言「结论与状态自洽」而非具体值。

// selfCheckStableItems 体检单稳定键（顺序即展示序，agent 按键分支勿依赖顺序）
var selfCheckStableItems = []string{"version", "git", "lfs", "tmux", "agent-runtimes", "ports", "disk", "config"}

// selfCheckValidStatus 三态词表
var selfCheckValidStatus = map[string]bool{"ok": true, "warn": true, "fail": true}

func TestSelfCheckReportShape(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	items := SelfCheckReport()
	if len(items) != len(selfCheckStableItems) {
		t.Fatalf("report items = %d, want %d", len(items), len(selfCheckStableItems))
	}
	seen := map[string]bool{}
	for i, it := range items {
		if it.Item != selfCheckStableItems[i] {
			t.Fatalf("items[%d].item = %q, want %q（展示序契约）", i, it.Item, selfCheckStableItems[i])
		}
		if seen[it.Item] {
			t.Fatalf("duplicate item key %q", it.Item)
		}
		seen[it.Item] = true
		if !selfCheckValidStatus[it.Status] {
			t.Fatalf("item %q status = %q, want ok|warn|fail", it.Item, it.Status)
		}
		if strings.TrimSpace(it.Detail) == "" {
			t.Fatalf("item %q detail is empty", it.Item)
		}
		if it.Status == "ok" && it.Hint != "" {
			t.Fatalf("item %q is ok but carries a hint %q（修复指引只配 warn/fail）", it.Item, it.Hint)
		}
		if it.Status != "ok" && strings.TrimSpace(it.Hint) == "" {
			t.Fatalf("item %q is %q without a hint（warn/fail 必须给修复指引）", it.Item, it.Status)
		}
	}
}

// TestSelfCheckVersionItem 版本条目恒 ok 且 detail 承载构建信息（issue 环境
// 信息的主体：版本/提交/平台缺一不可）
func TestSelfCheckVersionItem(t *testing.T) {
	it := versionItem()
	if it.Status != "ok" {
		t.Fatalf("version status = %q, want ok（自检基线行恒过）", it.Status)
	}
	for _, part := range []string{"codecombo", runtime.Version(), runtime.GOOS} {
		if !strings.Contains(it.Detail, part) {
			t.Fatalf("version detail %q missing %q", it.Detail, part)
		}
	}
}

// TestSelfCheckGitItemConsistency git 条目：探测成功 ⟹ ok 且 detail 带
// "git version" 前缀；失败 ⟹ fail 且给修复指引
func TestSelfCheckGitItemConsistency(t *testing.T) {
	it := gitItem()
	if it.Status == "ok" {
		if !strings.Contains(it.Detail, "git version") {
			t.Fatalf("git ok detail = %q, want `git version ...` output", it.Detail)
		}
		return
	}
	if it.Status != "fail" || it.Hint == "" {
		t.Fatalf("git not-ok item = %+v, want fail with hint", it)
	}
}

// TestSelfCheckLfsItemConsistency lfs 条目：可选能力，缺失降级 warn 不失败
func TestSelfCheckLfsItemConsistency(t *testing.T) {
	it := lfsItem()
	switch it.Status {
	case "ok":
		if !strings.Contains(strings.ToLower(it.Detail), "git-lfs") {
			t.Fatalf("lfs ok detail = %q, want git-lfs version output", it.Detail)
		}
	case "warn":
		if it.Hint == "" {
			t.Fatalf("lfs warn without hint: %+v", it)
		}
	default:
		t.Fatalf("lfs status = %q, want ok|warn（可选能力不判 fail）", it.Status)
	}
}

// TestSelfCheckDiskItemStatusMapping 磁盘条目状态随水位档位映射：ok→ok、
// warn→warn、crit→fail；数据卷不可观测 → fail。注入 diskVolumes 无法直接
// 桩（diskItem 直读），此处以「真实探测下状态合法 + detail 含路径/数值」为界，
// 档位映射逻辑由 diskLevelOf 既有单测覆盖
func TestSelfCheckDiskItem(t *testing.T) {
	it := diskItem()
	if !selfCheckValidStatus[it.Status] {
		t.Fatalf("disk status = %q, want ok|warn|fail", it.Status)
	}
	if it.Status == "fail" && !strings.Contains(it.Detail, "data dir not readable") && !strings.Contains(it.Detail, "free") {
		t.Fatalf("disk fail detail unexpected: %q", it.Detail)
	}
	if it.Status != "fail" && !strings.Contains(it.Detail, "free") {
		t.Fatalf("disk detail = %q, want `<free> free / ...`", it.Detail)
	}
}

// TestSelfCheckTmuxItemPlatformContract tmux 条目平台契约：Windows 恒 ok 注记
// not applicable（native PTY 承载，无 tmux 不算缺憾）；Unix 缺失降级 warn 不判 fail
func TestSelfCheckTmuxItemPlatformContract(t *testing.T) {
	it := tmuxItem()
	if runtime.GOOS == "windows" {
		if it.Status != "ok" || !strings.Contains(it.Detail, "not applicable on windows") {
			t.Fatalf("windows tmux item = %+v, want ok + not-applicable note", it)
		}
		return
	}
	if it.Status == "fail" {
		t.Fatalf("unix tmux item must not fail (native backend still works): %+v", it)
	}
	if it.Status == "ok" && !strings.Contains(it.Detail, "tmux ") {
		t.Fatalf("unix tmux ok detail = %q, want version output", it.Detail)
	}
}

// TestProbeVersionString 探测包装三态：成功修剪空白 / 报错=未探测到 / 超时
// 上限生效（注入短超时防测试慢）
func TestProbeVersionString(t *testing.T) {
	if v, ok := probeVersionString(func() (string, error) { return "  git version 2.51.0\n", nil }); !ok || v != "git version 2.51.0" {
		t.Fatalf("probe trim: (%q,%v)", v, ok)
	}
	if v, ok := probeVersionString(func() (string, error) { return "", errors.New("not found") }); ok || v != "" {
		t.Fatalf("probe error: (%q,%v), want empty+false", v, ok)
	}

	prev := selfCheckProbeTimeout
	selfCheckProbeTimeout = 50 * time.Millisecond
	t.Cleanup(func() { selfCheckProbeTimeout = prev })

	start := time.Now()
	v, ok := probeVersionString(func() (string, error) {
		time.Sleep(300 * time.Millisecond)
		return "slow", nil
	})
	elapsed := time.Since(start)
	if ok || v != "" {
		t.Fatalf("slow probe: (%q,%v), want timeout+false", v, ok)
	}
	// 超时上限要真生效：耗时 ≈ 注入的 50ms 而非等满 300ms 探测
	if elapsed > 250*time.Millisecond {
		t.Fatalf("timeout cap not effective: took %v", elapsed)
	}
}

// TestSelfCheckPortsItem 端口条目信息性恒 ok；无登记时明细带诚实边界注记
func TestSelfCheckPortsItem(t *testing.T) {
	it := portsItem()
	if it.Status != "ok" {
		t.Fatalf("ports status = %q, want ok（信息性条目）", it.Status)
	}
	if it.Detail == "" {
		t.Fatal("ports detail empty")
	}
}

// TestSelfCheckConfigItemOk 正常态：配置加载无降级 ⟹ ok + 配置路径明细、
// 无 hint（agent 探测「本实例配置是否在降级」的编程原语，P-20261006-10）
func TestSelfCheckConfigItemOk(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	config.ResetForTest()
	t.Cleanup(config.ResetForTest)

	it := configItem()
	if it.Status != "ok" || it.Item != "config" {
		t.Fatalf("config item = %+v, want ok without degradation", it)
	}
	if it.Hint != "" {
		t.Fatalf("ok item must not carry a hint, got %q", it.Hint)
	}
	if !strings.Contains(it.Detail, "config.json") {
		t.Fatalf("ok detail = %q, want config.json path", it.Detail)
	}
}

// TestSelfCheckConfigItemDegraded 损坏降级态（经真实 Load 链播种，非直填
// 全局态）：warn + 明细含保全路径与解析错误 + 修复指引——保全失败分支的
// 卡片形态由 app 包 config_corrupt_test.go 覆盖（改名失败平台相关难移植构造）
func TestSelfCheckConfigItemDegraded(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	config.ResetForTest()
	t.Cleanup(config.ResetForTest)

	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{bad"), 0600); err != nil {
		t.Fatal(err)
	}
	config.Load()

	it := configItem()
	if it.Status != "warn" {
		t.Fatalf("degraded config item = %+v, want warn", it)
	}
	if strings.TrimSpace(it.Hint) == "" {
		t.Fatal("warn item must carry a fix hint")
	}
	if !strings.Contains(it.Detail, "preserved at") || !strings.Contains(it.Detail, "parse error") {
		t.Fatalf("degraded detail = %q, want parse error + preserved path", it.Detail)
	}
}
