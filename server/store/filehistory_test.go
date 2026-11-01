package store_test

import (
	"bytes"
	"path/filepath"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 本地文件历史仓储单测（P-20261002-130）：小容量档位注入，让逐出与条数
// 纪律可观测。覆盖：闭环存取、同内容去重、字节/条数双档逐出（跨文件）、
// 路径与项目隔离、项目级联清理、非法 ID 防御、快速连写不撞键

// newFileHistoryStoreForTest 独立 DocumentStore + 小容量档位（100B / 4 条）
func newFileHistoryStoreForTest(t *testing.T) store.FileHistoryStore {
	t.Helper()
	doc := filestore.New(filepath.Join(t.TempDir(), "data"))
	return store.NewFileHistoryRepoWithLimits(doc, 100, 4)
}

// TestFileHistory_AppendListContent 闭环：两次不同内容快照 → 列表新→旧两条 →
// 按 ID 取回字节级一致内容
func TestFileHistory_AppendListContent(t *testing.T) {
	r := newFileHistoryStoreForTest(t)

	if ok, err := r.Append("p1", "src/a.txt", []byte("v1")); err != nil || !ok {
		t.Fatalf("append v1: ok=%v err=%v", ok, err)
	}
	if ok, err := r.Append("p1", "src/a.txt", []byte("v2-longer-content")); err != nil || !ok {
		t.Fatalf("append v2: ok=%v err=%v", ok, err)
	}

	versions, err := r.List("p1", "src/a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != 2 {
		t.Fatalf("versions = %d, want 2", len(versions))
	}
	// 新→旧：尺寸与时间均降序
	if versions[0].Size != int64(len("v2-longer-content")) || versions[1].Size != 2 {
		t.Fatalf("sizes = %d,%d want %d,%d", versions[0].Size, versions[1].Size, len("v2-longer-content"), 2)
	}
	if versions[0].Ts < versions[1].Ts {
		t.Fatalf("ts not descending: %d < %d", versions[0].Ts, versions[1].Ts)
	}

	got, err := r.Content("p1", "src/a.txt", versions[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "v1" {
		t.Fatalf("content = %q, want v1", got)
	}
}

// TestFileHistory_DedupeSameContent 同内容重复快照静默跳过：无信息量的
// 重复保存/被拒重命名不留噪声版本
func TestFileHistory_DedupeSameContent(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	if _, err := r.Append("p1", "a.txt", []byte("same")); err != nil {
		t.Fatal(err)
	}
	ok, err := r.Append("p1", "a.txt", []byte("same"))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("同内容快照应跳过（ok=false）")
	}
	versions, _ := r.List("p1", "a.txt")
	if len(versions) != 1 {
		t.Fatalf("versions = %d, want 1（去重后不新增）", len(versions))
	}
	// 不同内容再快照 → 正常入档
	if ok, _ := r.Append("p1", "a.txt", []byte("changed")); !ok {
		t.Fatal("不同内容应入档")
	}
}

// TestFileHistory_EvictByBytes 容量治理：总字节超档按最旧跨文件逐出
// （100B 档：A 两版 60+40、B 一版 40 → 累计 140 超档，最旧的 A 旧版被逐出）
func TestFileHistory_EvictByBytes(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	if _, err := r.Append("p1", "a.txt", bytes.Repeat([]byte("A"), 60)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Append("p1", "a.txt", bytes.Repeat([]byte("B"), 40)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Append("p1", "b.txt", bytes.Repeat([]byte("C"), 40)); err != nil {
		t.Fatal(err)
	}

	versions, _ := r.List("p1", "a.txt")
	if len(versions) != 1 {
		t.Fatalf("a.txt versions = %d, want 1（旧版被逐出）", len(versions))
	}
	got, err := r.Content("p1", "a.txt", versions[0].ID)
	if err != nil || !bytes.Equal(got, bytes.Repeat([]byte("B"), 40)) {
		t.Fatalf("a.txt 剩余版本内容不符: err=%v len=%d", err, len(got))
	}
	if versions, _ := r.List("p1", "b.txt"); len(versions) != 1 {
		t.Fatalf("b.txt versions = %d, want 1", len(versions))
	}
}

// TestFileHistory_EvictByEntries 条数档位：超条数按最旧逐出，防小文件海量
// 版本把台账撑爆
func TestFileHistory_EvictByEntries(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	for i := 0; i < 7; i++ {
		if _, err := r.Append("p1", "a.txt", []byte{byte('a' + i)}); err != nil {
			t.Fatal(err)
		}
	}
	versions, _ := r.List("p1", "a.txt")
	if len(versions) != 4 {
		t.Fatalf("versions = %d, want 4（条数档位封顶）", len(versions))
	}
	// 最旧的 a,b,c 被逐出，最旧保留版应为 d
	got, err := r.Content("p1", "a.txt", versions[len(versions)-1].ID)
	if err != nil || string(got) != "d" {
		t.Fatalf("最旧保留版应为 d: err=%v got=%q", err, got)
	}
}

// TestFileHistory_PathIsolation 路径与项目双隔离：同名相对路径跨项目、
// 同项目不同路径互不串档
func TestFileHistory_PathIsolation(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	_, _ = r.Append("p1", "a.txt", []byte("p1-a"))
	_, _ = r.Append("p2", "a.txt", []byte("p2-a"))
	_, _ = r.Append("p1", "b.txt", []byte("p1-b"))

	if vs, _ := r.List("p1", "a.txt"); len(vs) != 1 {
		t.Fatalf("p1/a.txt versions = %d, want 1", len(vs))
	}
	p2Versions, _ := r.List("p2", "a.txt")
	if len(p2Versions) != 1 {
		t.Fatalf("p2/a.txt versions = %d, want 1", len(p2Versions))
	}
	got, err := r.Content("p2", "a.txt", p2Versions[0].ID)
	if err != nil || string(got) != "p2-a" {
		t.Fatalf("p2/a.txt content = %q (err=%v), want p2-a", got, err)
	}
}

// TestFileHistory_DeleteProject 项目删除级联：版本文档与台账一并清理，
// 删除后列表为空、同 ID 项目重建从零开始
func TestFileHistory_DeleteProject(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	_, _ = r.Append("p1", "a.txt", []byte("v1"))
	_, _ = r.Append("p1", "b.txt", []byte("v2"))
	if err := r.DeleteProject("p1"); err != nil {
		t.Fatal(err)
	}
	if vs, _ := r.List("p1", "a.txt"); len(vs) != 0 {
		t.Fatalf("删除后 p1/a.txt versions = %d, want 0", len(vs))
	}
	if vs, _ := r.List("p1", "b.txt"); len(vs) != 0 {
		t.Fatalf("删除后 p1/b.txt versions = %d, want 0", len(vs))
	}
	// 台账一并清理：再快照从零入账
	if ok, err := r.Append("p1", "a.txt", []byte("v1")); err != nil || !ok {
		t.Fatalf("删除后再快照: ok=%v err=%v", ok, err)
	}
	if vs, _ := r.List("p1", "a.txt"); len(vs) != 1 {
		t.Fatalf("重建后 versions = %d, want 1", len(vs))
	}
}

// TestFileHistory_InvalidIDs 非法版本 ID（长度/hex 形态）拒绝且不 panic
func TestFileHistory_InvalidIDs(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	if _, err := r.Append("p1", "a.txt", []byte("v1")); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "short", "zzzzzzzzzzzzzzzz", "00000000000000000"} {
		if _, err := r.Content("p1", "a.txt", id); err == nil {
			t.Fatalf("非法 ID %q 应报错", id)
		}
	}
}

// TestFileHistory_RapidAppendsUniqueKeys 连续快速快照（Windows 墙钟粒度内）
// 不得撞键：每次都成独立版本
func TestFileHistory_RapidAppendsUniqueKeys(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	for i := 0; i < 3; i++ {
		if _, err := r.Append("p1", "a.txt", []byte{'v', byte('0' + i)}); err != nil {
			t.Fatalf("快速连写第 %d 次: %v", i, err)
		}
	}
	if vs, _ := r.List("p1", "a.txt"); len(vs) != 3 {
		t.Fatalf("versions = %d, want 3", len(vs))
	}
}

// TestFileHistory_KeyBlacklistPaths 点开头/含点段的路径（键黑名单高危形态）
// 经哈希键段后正常存取——.env、a..b.txt 这类直排必被 filestore 键校验拒绝
func TestFileHistory_KeyBlacklistPaths(t *testing.T) {
	r := newFileHistoryStoreForTest(t)
	for _, rel := range []string{".env", "dir/.hidden", "a..b.txt"} {
		if _, err := r.Append("p1", rel, []byte("secret")); err != nil {
			t.Fatalf("Append(%q): %v", rel, err)
		}
		if vs, _ := r.List("p1", rel); len(vs) != 1 {
			t.Fatalf("List(%q) versions = %d, want 1", rel, len(vs))
		}
	}
}
