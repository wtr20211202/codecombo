package share

// 源根 mtime 采样/惰性对比的单元测试（P-20261114-3-S2 主档判定原语）：
// 采样聚合、对比三态、条目预算护栏（超限 unknown 不置位）、源不可达
// unknown、批量逐根共享预算

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// staleTree 造一个源树（dirs+files），返回项目根；内容时点显式拨到 now 基线
// 附近，避免依赖文件系统真实时钟
func staleTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mk := func(rel, content string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("a.txt", "alpha")
	mk("sub/b.txt", "beta")
	mk("sub/deep/c.txt", "gamma")
	return root
}

// touchFile 追加写一个文件（mtime 前移）
func touchFile(t *testing.T, root, rel string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("-appended"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	// Windows/部分 FS mtime 粒度粗：显式拨到未来一刻，保证与前值可区分
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(p, future, future); err != nil {
		t.Fatal(err)
	}
}

func TestCaptureSourceMtimesFileAndDir(t *testing.T) {
	root := staleTree(t)
	base, ok := CaptureSourceMtimes(root, []string{"a.txt", "sub"})
	if !ok {
		t.Fatal("capture should succeed for small tree")
	}
	if len(base) != 2 {
		t.Fatalf("baseline keys = %d, want 2", len(base))
	}
	fi, err := os.Stat(filepath.Join(root, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if base["a.txt"] != fi.ModTime().UnixNano() {
		t.Fatalf("file baseline = %d, want file mtime %d", base["a.txt"], fi.ModTime().UnixNano())
	}
	// 目录基准 = 子树 max：深条目 mtime ≥ 目录自身 mtime 才成立时取深条目
	subInfo, err := os.Stat(filepath.Join(root, "sub"))
	if err != nil {
		t.Fatal(err)
	}
	if base["sub"] < subInfo.ModTime().UnixNano() {
		t.Fatalf("dir baseline %d below dir mtime %d", base["sub"], subInfo.ModTime().UnixNano())
	}
}

func TestSourceChangedDetectsModifyAndDelete(t *testing.T) {
	root := staleTree(t)
	base, ok := CaptureSourceMtimes(root, []string{"a.txt", "sub"})
	if !ok {
		t.Fatal("capture failed")
	}
	// 未变：三态 = (false, true)
	if changed, ok := SourceChanged(root, []string{"a.txt", "sub"}, base); changed || !ok {
		t.Fatalf("unchanged tree: changed=%v ok=%v, want false/true", changed, ok)
	}
	// 深层文件原地改写（max 聚合的判定目标：目录根 Lstat 永远看不到这类变化）
	touchFile(t, root, "sub/deep/c.txt")
	if changed, ok := SourceChanged(root, []string{"a.txt", "sub"}, base); !changed || !ok {
		t.Fatalf("deep modify: changed=%v ok=%v, want true/true", changed, ok)
	}
	// 重建基准后删除条目：删除使父目录 mtime 前移，等值比较同样命中
	base, ok = CaptureSourceMtimes(root, []string{"sub"})
	if !ok {
		t.Fatal("recapture failed")
	}
	if err := os.Remove(filepath.Join(root, filepath.FromSlash("sub/deep/c.txt"))); err != nil {
		t.Fatal(err)
	}
	if changed, ok := SourceChanged(root, []string{"sub"}, base); !changed || !ok {
		t.Fatalf("delete: changed=%v ok=%v, want true/true", changed, ok)
	}
}

func TestSourceChangedUnknownWhenBaselineMissingOrKeyMismatch(t *testing.T) {
	root := staleTree(t)
	// 无基准：unknown（不置位不误报）
	if changed, ok := SourceChanged(root, []string{"a.txt"}, nil); changed || ok {
		t.Fatalf("nil baseline: changed=%v ok=%v, want false/false", changed, ok)
	}
	base, ok := CaptureSourceMtimes(root, []string{"a.txt", "sub"})
	if !ok {
		t.Fatal("capture failed")
	}
	// 键集与根集不齐：整体 unknown（部分判定易漂移，宁缺勿错）
	if changed, ok := SourceChanged(root, []string{"a.txt"}, base); changed || ok {
		t.Fatalf("key mismatch: changed=%v ok=%v, want false/false", changed, ok)
	}
}

func TestStaleScanEntryCapUnknown(t *testing.T) {
	root := staleTree(t)
	old := StaleScanEntryCap
	StaleScanEntryCap = 2 // 单测缝：注入小档位（files.duplicate dupMaxEntries 同款）
	defer func() { StaleScanEntryCap = old }()

	// 采样超限：无基准（不追踪）
	if base, ok := CaptureSourceMtimes(root, []string{"sub"}); ok || base != nil {
		t.Fatalf("over-cap capture: ok=%v base=%v, want false/nil", ok, base)
	}
	// 对比超限：unknown（不置位）——护栏防大树遍历的任务语义
	if changed, ok := SourceChanged(root, []string{"sub"}, map[string]int64{"sub": 1}); changed || ok {
		t.Fatalf("over-cap compare: changed=%v ok=%v, want false/false", changed, ok)
	}
	// 预算跨根共享：两个小根合计超限同样整单 unknown
	if _, ok := CaptureSourceMtimes(root, []string{"a.txt", "sub"}); ok {
		t.Fatal("shared budget should fail the whole capture when sum exceeds cap")
	}
}

func TestStaleUnknownWhenSourceGone(t *testing.T) {
	root := staleTree(t)
	base, ok := CaptureSourceMtimes(root, []string{"a.txt"})
	if !ok {
		t.Fatal("capture failed")
	}
	SetStaleProbeFail(true)
	defer SetStaleProbeFail(false)
	// 源不可达：三态 = unknown（不置位不误报——陈旧徽标是提示性面）
	if changed, ok := SourceChanged(root, []string{"a.txt"}, base); changed || ok {
		t.Fatalf("source gone: changed=%v ok=%v, want false/false", changed, ok)
	}
	// 采样同样失败：无基准
	if b, ok := CaptureSourceMtimes(root, []string{"a.txt"}); ok || b != nil {
		t.Fatalf("capture with dead source: ok=%v, want false", ok)
	}
}

func TestCaptureBatchRoots(t *testing.T) {
	root := staleTree(t)
	rels := []string{"a.txt", "sub/deep", "sub/b.txt"}
	base, ok := CaptureSourceMtimes(root, rels)
	if !ok {
		t.Fatal("batch capture failed")
	}
	if len(base) != len(rels) {
		t.Fatalf("baseline keys = %d, want %d", len(base), len(rels))
	}
	for _, rel := range rels {
		if _, present := base[rel]; !present {
			t.Fatalf("baseline missing key %q", rel)
		}
	}
	// 单独动其中一个根：整单判定变更（逐根短路返回 true）
	touchFile(t, root, "sub/b.txt")
	changed, ok := SourceChanged(root, rels, base)
	if !changed || !ok {
		t.Fatalf("batch detect: changed=%v ok=%v, want true/true", changed, ok)
	}
}

func TestHasStaleBaseline(t *testing.T) {
	if HasStaleBaseline(nil) || HasStaleBaseline(map[string]int64{}) {
		t.Fatal("nil/empty baseline must report false (未采样不追踪)")
	}
	if !HasStaleBaseline(map[string]int64{"a": 1}) {
		t.Fatal("non-empty baseline must report true")
	}
}
