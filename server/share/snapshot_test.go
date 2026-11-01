package share

// 冻结快照管理（P-20261003-320）单元测试：复制回环（含符号链接跳过）、
// 双体积护栏（单份/总量）、删除幂等、孤儿对账、访客面冻结解析
//（resolveFrozen 经注入的 SnapshotDirs 读副本，内容随源变更不变）

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/store"
)

// snapEnv 把数据目录隔离进临时目录（SC_DATA_DIR 供 config.DataDir 读取），
// 返回快照根路径
func snapEnv(t *testing.T) string {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	root := SnapshotsRoot()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func mustFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCreateFrozenSnapshotRoundtrip(t *testing.T) {
	snapRoot := snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "docs", "readme.md"), "# v1")
	mustFile(t, filepath.Join(src, "docs", "sub", "note.txt"), "note")
	mustFile(t, filepath.Join(src, "outside.txt"), "not in share root")

	copied, err := CreateFrozenSnapshot(src, "docs", fixedToken("snap1"))
	if err != nil {
		t.Fatalf("create snapshot: %v", err)
	}
	if copied == 0 {
		t.Fatal("copied bytes should be > 0")
	}
	// 镜像布局：副本在 <snapRoot>/<token>/docs/... 下（访客面 rel=Path[/q] 同构）
	b, err := os.ReadFile(filepath.Join(snapRoot, fixedToken("snap1"), "docs", "readme.md"))
	if err != nil || string(b) != "# v1" {
		t.Fatalf("snapshot content missing/wrong: %v %q", err, b)
	}
	if _, err := os.Stat(filepath.Join(snapRoot, fixedToken("snap1"), "docs", "sub", "note.txt")); err != nil {
		t.Fatalf("nested file not copied: %v", err)
	}
	if _, err := os.Stat(filepath.Join(snapRoot, fixedToken("snap1"), "outside.txt")); !os.IsNotExist(err) {
		t.Fatal("content outside share root must not leak into snapshot")
	}

	// 幂等重创建：目标目录已有残壳时整体重建（内容只来自本次复制）
	mustFile(t, filepath.Join(snapRoot, fixedToken("snap1"), "docs", "stale.txt"), "stale")
	if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("snap1")); err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if _, err := os.Stat(filepath.Join(snapRoot, fixedToken("snap1"), "docs", "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("stale content must be wiped by re-create")
	}
}

func TestCreateFrozenSnapshotSkipsSymlinks(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "docs", "real.txt"), "real")
	// 平台差异：Windows 无特权建不了符号链接——建不了就跳过本用例的链接断言
	//（linuxVerify 门禁的 Linux 侧真实执行）
	if os.Symlink(filepath.Join(src, "docs", "real.txt"), filepath.Join(src, "docs", "link.txt")) == nil {
		if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("snaplk")); err != nil {
			t.Fatalf("create snapshot: %v", err)
		}
		if _, err := os.Lstat(filepath.Join(SnapshotsRoot(), fixedToken("snaplk"), "docs", "link.txt")); !os.IsNotExist(err) {
			t.Fatal("symlink must not be followed or recreated in snapshot")
		}
	}
	if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("snaplk")); err != nil {
		t.Fatalf("create snapshot without symlink support: %v", err)
	}
}

func TestCreateFrozenSnapshotSizeGuard(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "docs", "big.bin"), strings.Repeat("x", 1<<20))

	// 单份护栏：小档位注入不可行（const 上限），直接用真实内容难造 200MB——
	// 预算护栏（总量）经预置残壳逼近：往快照库塞一份大的假内容
	dirs := filepath.Join(SnapshotsRoot(), fixedToken("quota0"))
	mustFile(t, filepath.Join(dirs, "fake.bin"), strings.Repeat("y", MaxFrozenTotalBytes-512<<10))

	if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("quota1")); err == nil {
		t.Fatal("quota guard should reject when store is full")
	} else if !errors.Is(err, ErrFrozenQuota) {
		t.Fatalf("want ErrFrozenQuota, got %v", err)
	}
	// 半成品回滚：失败后不留目标目录残壳
	if _, err := os.Stat(filepath.Join(SnapshotsRoot(), fixedToken("quota1"))); !os.IsNotExist(err) {
		t.Fatal("failed create must roll back partial copy")
	}
}

func TestDeleteFrozenSnapshotIdempotent(t *testing.T) {
	snapEnv(t)
	if err := DeleteFrozenSnapshot(fixedToken("gone")); err != nil {
		t.Fatalf("delete missing snapshot should be nil, got %v", err)
	}
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "docs", "a.txt"), "a")
	if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("gone")); err != nil {
		t.Fatal(err)
	}
	if !HasFrozenSnapshot(fixedToken("gone")) {
		t.Fatal("snapshot should exist after create")
	}
	if err := DeleteFrozenSnapshot(fixedToken("gone")); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if HasFrozenSnapshot(fixedToken("gone")) {
		t.Fatal("snapshot should be gone after delete")
	}
}

func TestGcOrphanSnapshots(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "docs", "a.txt"), "a")
	for _, tok := range []string{"keep000000000001", "keep000000000002", "orphan000000001"} {
		if _, err := CreateFrozenSnapshot(src, "docs", fixedToken(tok)); err != nil {
			t.Fatal(err)
		}
	}
	// keep 为 nil = 调用方事故（List 失败），拒绝清账
	if _, err := GcOrphanSnapshots(nil); err == nil {
		t.Fatal("nil keep set must be refused")
	}
	removed, err := GcOrphanSnapshots(map[string]bool{
		fixedToken("keep000000000001"): true,
		fixedToken("keep000000000002"): true,
	})
	if err != nil {
		t.Fatalf("gc: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if !HasFrozenSnapshot(fixedToken("keep000000000001")) || !HasFrozenSnapshot(fixedToken("keep000000000002")) {
		t.Fatal("keep set must survive gc")
	}
	if HasFrozenSnapshot(fixedToken("orphan000000001")) {
		t.Fatal("orphan must be removed")
	}
}

// TestSnapshotUsage 快照库占用统计（P-20261005-176）：逐目录字节量 + 总量、
// 撤销后回落、护栏满额量级（稀疏截断大文件按 Size() 计量，不真写盘）
func TestSnapshotUsage(t *testing.T) {
	// 快照根不存在 = 零占用非错误（从未冻结过）
	t.Setenv("CC_DATA_DIR", filepath.Join(t.TempDir(), "never-frozen"))
	total, perToken, err := SnapshotUsage()
	if err != nil || total != 0 || len(perToken) != 0 {
		t.Fatalf("missing root usage = %d, %v, err %v", total, perToken, err)
	}

	snapRoot := snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "docs", "a.txt"), "aaaa") // 4 字节
	if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("u1")); err != nil {
		t.Fatal(err)
	}
	mustFile(t, filepath.Join(src, "docs", "big.bin"), strings.Repeat("b", 1<<20))
	if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("u2")); err != nil {
		t.Fatal(err)
	}
	total, perToken, err = SnapshotUsage()
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	// u1 冻结于加 big.bin 之前只有 4 字节；u2 冻结时 docs 整树已含两文件
	if perToken[fixedToken("u1")] != 4 || perToken[fixedToken("u2")] != 4+1<<20 {
		t.Fatalf("per-token usage wrong: %v", perToken)
	}
	if total != 8+1<<20 {
		t.Fatalf("total = %d, want %d", total, 8+1<<20)
	}

	// 撤销即删 → 统计数字同步回落（占用治理的闭环）
	if err := DeleteFrozenSnapshot(fixedToken("u2")); err != nil {
		t.Fatal(err)
	}
	total, perToken, err = SnapshotUsage()
	if err != nil {
		t.Fatalf("usage after delete: %v", err)
	}
	if _, ok := perToken[fixedToken("u2")]; ok {
		t.Fatalf("revoked token still in usage map: %v", perToken)
	}
	if total != 4 {
		t.Fatalf("total after delete = %d, want 4", total)
	}

	// 护栏满额量级：总量统计与创建护栏同口径（整棵快照根逐文件 Size()）——
	// 稀疏截断到上限即统计 ≥ cap（超阈值态的数值正确性，不真写 1GB）
	stuffing := filepath.Join(snapRoot, fixedToken("big0"))
	if err := os.MkdirAll(stuffing, 0o755); err != nil {
		t.Fatal(err)
	}
	filler, err := os.Create(filepath.Join(stuffing, "filler.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := filler.Truncate(MaxFrozenTotalBytes); err != nil {
		t.Fatal(err)
	}
	_ = filler.Close()
	total, _, err = SnapshotUsage()
	if err != nil {
		t.Fatalf("usage at cap: %v", err)
	}
	if total < MaxFrozenTotalBytes {
		t.Fatalf("total = %d, want >= cap %d", total, MaxFrozenTotalBytes)
	}
}

// fakeSnapshotDirs 把目录解析钉到给定快照根 + 记录 token（访客面冻结解析
// 测试；测试里快照目录名 = 记录 token，与装配层 FrozenNativeToken 重算同构）
type fakeSnapshotDirs struct{ dir string }

func (f fakeSnapshotDirs) DirOf(sh *store.Share) (string, error) {
	if !sh.Frozen {
		return "", errors.New("not frozen")
	}
	return filepath.Join(f.dir, sh.Token), nil
}

// TestFrozenRootShareGuestPath 项目根冻结分享（Path=""）：副本内容即快照根
// （非镜像子目录），访客 rel = q 或 "."——与 live 项目根分享同语义
func TestFrozenRootShareGuestPath(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "README.md"), "# root v1")
	mustFile(t, filepath.Join(src, "sub", "note.txt"), "note")

	if _, err := CreateFrozenSnapshot(src, "", fixedToken("frozenroot01")); err != nil {
		t.Fatal(err)
	}
	token := fixedToken("frozenroot01")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "proj",
		Path: "", IsDir: true, Frozen: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": src}}, nil).
		WithSnapshotDirs(fakeSnapshotDirs{dir: SnapshotsRoot()})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	// 分享根本身（rel="."）：meta 出项目名
	meta := get(t, srv.URL+"/s/"+token+"/meta")
	defer meta.Body.Close()
	metaBody, _ := io.ReadAll(meta.Body)
	if !strings.Contains(string(metaBody), `"name":"proj"`) {
		t.Fatalf("root meta wrong: %s", metaBody)
	}
	// 子路径浏览（rel=q）：列表/raw 命中内容根
	list := get(t, srv.URL+"/s/"+token+"/list")
	defer list.Body.Close()
	listBody, _ := io.ReadAll(list.Body)
	if !strings.Contains(string(listBody), `"README.md"`) {
		t.Fatalf("root list wrong: %s", listBody)
	}
	raw := get(t, srv.URL+"/s/"+token+"/raw?path=README.md")
	defer raw.Body.Close()
	rawBody, _ := io.ReadAll(raw.Body)
	if string(rawBody) != "# root v1" {
		t.Fatalf("root raw wrong: %q", rawBody)
	}
	raw2 := get(t, srv.URL+"/s/"+token+"/raw?path=sub/note.txt")
	defer raw2.Body.Close()
	raw2Body, _ := io.ReadAll(raw2.Body)
	if string(raw2Body) != "note" {
		t.Fatalf("root nested raw wrong: %q", raw2Body)
	}
}

// TestGuestSeesFrozenContent 核心语义端到端：冻结创建 → 项目内继续改 →
// 访客读到的仍是快照内容（meta/list/raw/download 全链走副本）
func TestGuestSeesFrozenContent(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "docs", "readme.md"), "# frozen v1")
	mustFile(t, filepath.Join(src, "docs", "data.csv"), "a,b\n1,2\n")

	if _, err := CreateFrozenSnapshot(src, "docs", fixedToken("frozenreadme")); err != nil {
		t.Fatal(err)
	}
	token := fixedToken("frozenreadme")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "docs",
		Path: "docs", IsDir: true, Frozen: true,
	}}
	// roots 故意指向会漂移的项目目录：frozen 分支绝不许触达
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": src}}, nil).
		WithSnapshotDirs(fakeSnapshotDirs{dir: SnapshotsRoot()})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	// 访客首读：meta/list/raw 与快照一致
	meta := get(t, srv.URL+"/s/"+token+"/meta")
	defer meta.Body.Close()
	metaBody, _ := io.ReadAll(meta.Body)
	if !strings.Contains(string(metaBody), `"name":"docs"`) {
		t.Fatalf("meta wrong: %s", metaBody)
	}
	list := get(t, srv.URL+"/s/"+token+"/list")
	defer list.Body.Close()
	listBody, _ := io.ReadAll(list.Body)
	if !strings.Contains(string(listBody), `"readme.md"`) {
		t.Fatalf("list wrong: %s", listBody)
	}
	raw := get(t, srv.URL+"/s/"+token+"/raw?path=readme.md")
	defer raw.Body.Close()
	rawBody, _ := io.ReadAll(raw.Body)
	if string(rawBody) != "# frozen v1" {
		t.Fatalf("raw should read snapshot, got %q", rawBody)
	}

	// 项目内继续改：访客内容不变（冻结的核心承诺）
	mustFile(t, filepath.Join(src, "docs", "readme.md"), "# DRIFTED v2")
	mustFile(t, filepath.Join(src, "docs", "added.txt"), "new file")
	raw2 := get(t, srv.URL+"/s/"+token+"/raw?path=readme.md")
	defer raw2.Body.Close()
	raw2Body, _ := io.ReadAll(raw2.Body)
	if string(raw2Body) != "# frozen v1" {
		t.Fatalf("frozen content drifted after project change: %q", raw2Body)
	}
	raw3 := get(t, srv.URL+"/s/"+token+"/raw?path=added.txt")
	defer raw3.Body.Close()
	if raw3.StatusCode != 404 {
		t.Fatalf("post-freeze file must be invisible to guest, status = %d", raw3.StatusCode)
	}

	// 撤销（副本删除）→ 访客 target_gone（410，与 live「项目已删」同类语义）
	if err := DeleteFrozenSnapshot(token); err != nil {
		t.Fatal(err)
	}
	raw4 := get(t, srv.URL+"/s/"+token+"/raw?path=readme.md")
	defer raw4.Body.Close()
	if raw4.StatusCode != http.StatusGone {
		t.Fatalf("revoked frozen share should 410, status = %d", raw4.StatusCode)
	}
}

// TestFrozenFileShareGuestPath 文件冻结分享：快照按项目内路径镜像，
// 访客 rel = Path[/q] 与 live 同构（下载/raw 均命中镜像落点）
func TestFrozenFileShareGuestPath(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "web", "src", "app.ts"), "export const v = 1")

	if _, err := CreateFrozenSnapshot(src, filepath.ToSlash(filepath.Join("web", "src", "app.ts")), fixedToken("frozenfile01")); err != nil {
		t.Fatal(err)
	}
	token := fixedToken("frozenfile01")
	shares := fakeShares{token: {
		Token: token, ProjectID: "p1", ProjectName: "proj", Name: "app.ts",
		Path: "web/src/app.ts", IsDir: false, Frozen: true,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": src}}, nil).
		WithSnapshotDirs(fakeSnapshotDirs{dir: SnapshotsRoot()})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	raw := get(t, srv.URL+"/s/"+token+"/raw")
	defer raw.Body.Close()
	b, _ := io.ReadAll(raw.Body)
	if string(b) != "export const v = 1" {
		t.Fatalf("frozen file share raw wrong: %q", b)
	}
	dl := get(t, srv.URL+"/s/"+token+"/download")
	defer dl.Body.Close()
	if dl.StatusCode != 200 {
		t.Fatalf("download status = %d", dl.StatusCode)
	}
}

// ── 多路径冻结快照（P-20261008-1） ──

// TestCreateFrozenSnapshotMultiRoundtrip 多路径复制：各自子树保留项目内相对
// 结构落入同一副本、嵌套选择随父路径去重（同内容单份）、合计字节准确、
// 分享根之外的内容不泄漏、重复创建抹掉旧残壳
func TestCreateFrozenSnapshotMultiRoundtrip(t *testing.T) {
	snapRoot := snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "src", "a.ts"), "const a = 1")
	mustFile(t, filepath.Join(src, "docs", "b.md"), "# b")
	mustFile(t, filepath.Join(src, "docs", "sub", "c.txt"), "c")
	mustFile(t, filepath.Join(src, "outside.txt"), "not selected")

	tok := fixedToken("batchrt0001")
	copied, err := CreateFrozenSnapshotMulti(src, []string{
		"src/a.ts", "docs", "docs/b.md", "docs/sub/c.txt", // 后三项应随 docs 去重
	}, tok)
	if err != nil {
		t.Fatalf("create multi snapshot: %v", err)
	}
	// 合计字节 = 三个被选文件（嵌套项不双份计费）
	want := int64(len("const a = 1") + len("# b") + len("c"))
	if copied != want {
		t.Fatalf("copied = %d, want %d", copied, want)
	}
	// 镜像布局：副本在 <root>/<token>/<rel> 下
	for rel, content := range map[string]string{
		"src/a.ts":       "const a = 1",
		"docs/b.md":      "# b",
		"docs/sub/c.txt": "c",
	} {
		b, err := os.ReadFile(filepath.Join(snapRoot, tok, filepath.FromSlash(rel)))
		if err != nil || string(b) != content {
			t.Fatalf("snapshot %s missing/wrong: %v %q", rel, err, b)
		}
	}
	if _, err := os.Stat(filepath.Join(snapRoot, tok, "outside.txt")); !os.IsNotExist(err) {
		t.Fatal("unselected content must not leak into batch snapshot")
	}

	// 幂等重创建：旧残壳整体抹掉（只留本次复制内容）
	mustFile(t, filepath.Join(snapRoot, tok, "stale.txt"), "stale")
	if _, err := CreateFrozenSnapshotMulti(src, []string{"docs", "src/a.ts"}, tok); err != nil {
		t.Fatalf("recreate multi: %v", err)
	}
	if _, err := os.Stat(filepath.Join(snapRoot, tok, "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("stale content must be wiped by multi recreate")
	}
}

// TestCreateFrozenSnapshotMultiSizeGuard 合计单份护栏：两个 101MB 稀疏文件
// 单个都在 200MB 内、合计超限——复制到第二个时按累计量拒绝并整体回滚
// （护栏语义 = N 路径合计预算，而非逐路径各自限额）
func TestCreateFrozenSnapshotMultiSizeGuard(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	for _, name := range []string{"a.bin", "b.bin"} {
		f, err := os.Create(filepath.Join(src, name))
		if err != nil {
			t.Fatal(err)
		}
		// 稀疏截断：不真占盘，复制路径会读到 101MB 零值
		if err := f.Truncate(101 << 20); err != nil {
			f.Close()
			t.Fatal(err)
		}
		_ = f.Close()
	}
	tok := fixedToken("batchguard01")
	if _, err := CreateFrozenSnapshotMulti(src, []string{"a.bin", "b.bin"}, tok); !errors.Is(err, ErrFrozenTooLarge) {
		t.Fatalf("want ErrFrozenTooLarge, got %v", err)
	}
	if HasFrozenSnapshot(tok) {
		t.Fatal("failed multi create must roll back partial copy")
	}
}

// TestFrozenBatchGuestManifest 访客面 manifest 语义：根列表逐项列出选择集
// （展示完整项目相对路径）、逐项 raw/meta 可读、整体 zip 打包全部条目，
// 副本删除后 410 target_gone（与单路径 frozen 同语义）
func TestFrozenBatchGuestManifest(t *testing.T) {
	snapEnv(t)
	src := t.TempDir()
	mustFile(t, filepath.Join(src, "src", "a.ts"), "const a = 1")
	mustFile(t, filepath.Join(src, "docs", "b.md"), "# b")
	mustFile(t, filepath.Join(src, "docs", "sub", "c.txt"), "c")

	tok := fixedToken("batchguest01")
	paths := []string{"docs/b.md", "docs/sub/c.txt", "src/a.ts"}
	if _, err := CreateFrozenSnapshotMulti(src, paths, tok); err != nil {
		t.Fatal(err)
	}
	shares := fakeShares{tok: {
		Token: tok, ProjectID: "p1", ProjectName: "proj", Name: "b.md +2",
		Path: "", Frozen: true, Paths: paths,
	}}
	svc := NewService(shares, fakeRoots{byID: map[string]string{"p1": src}}, nil).
		WithSnapshotDirs(fakeSnapshotDirs{dir: SnapshotsRoot()})
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)

	// 根列表 = manifest（3 项，全路径展示，而非快照里的 docs/src 目录树）
	list := get(t, srv.URL+"/s/"+tok+"/list")
	defer list.Body.Close()
	listBody, _ := io.ReadAll(list.Body)
	for _, p := range paths {
		if !strings.Contains(string(listBody), `"name":"`+p+`"`) || !strings.Contains(string(listBody), `"path":"`+p+`"`) {
			t.Fatalf("manifest entry %s missing: %s", p, listBody)
		}
	}
	if strings.Contains(string(listBody), `"name":"docs"`) {
		t.Fatalf("batch root must not expose ancestor directory tree: %s", listBody)
	}

	// 逐项预览：meta + raw 命中副本
	meta := get(t, srv.URL+"/s/"+tok+"/meta?path=docs/b.md")
	defer meta.Body.Close()
	metaBody, _ := io.ReadAll(meta.Body)
	if !strings.Contains(string(metaBody), `"name":"b.md"`) {
		t.Fatalf("per-item meta wrong: %s", metaBody)
	}
	raw := get(t, srv.URL+"/s/"+tok+"/raw?path=docs/b.md")
	defer raw.Body.Close()
	rawBody, _ := io.ReadAll(raw.Body)
	if string(rawBody) != "# b" {
		t.Fatalf("per-item raw wrong: %q", rawBody)
	}

	// 整体 zip：根下载即全集合包（条目保留各自项目相对路径）
	dl := get(t, srv.URL+"/s/"+tok+"/dl/")
	defer dl.Body.Close()
	zipBody, _ := io.ReadAll(dl.Body)
	if dl.StatusCode != http.StatusOK || dl.Header.Get("Content-Type") != "application/zip" {
		t.Fatalf("batch zip status/content-type = %d %q", dl.StatusCode, dl.Header.Get("Content-Type"))
	}
	zr, err := zip.NewReader(bytes.NewReader(zipBody), int64(len(zipBody)))
	if err != nil {
		t.Fatalf("batch zip unreadable: %v", err)
	}
	names := make(map[string]bool, len(zr.File))
	for _, f := range zr.File {
		names[f.Name] = true
	}
	for _, p := range paths {
		if !names[p] {
			t.Fatalf("zip missing %s: %v", p, names)
		}
	}

	// 副本删除 → 410 target_gone（与单路径 frozen 同款坏副本语义）
	if err := DeleteFrozenSnapshot(tok); err != nil {
		t.Fatal(err)
	}
	gone := get(t, srv.URL+"/s/"+tok+"/raw?path=docs/b.md")
	defer gone.Body.Close()
	if gone.StatusCode != http.StatusGone {
		t.Fatalf("removed batch snapshot should 410, status = %d", gone.StatusCode)
	}
}
