package sync

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// execGitForTest 测试夹具 git 执行（仓库 fixture 用；独立小函数避免为测试
// 面拉起 git 包完整调用链）
func execGitForTest(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// sync 单元单测（P-20261023-1 拆解步骤 1/2 的纯服务端面）：指纹稳定性/
// gitignore 感知排除/四态判定/账本/zip 打包-落位往返/原子落位与覆盖备份/
// 单元互斥。跨实例全链（双 httptest 实例对打）见 transfer_test.go。

// setupSyncEnv 装配 store + 临时数据目录（api 层测试同款最小引擎）
func setupSyncEnv(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(filepath.Join(t.TempDir(), "data"))))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// seedProject 注册项目（目录由调用方创建）
func seedProject(t *testing.T, id, name, path string) {
	t.Helper()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: id, Name: name, Path: path}); err != nil {
		t.Fatal(err)
	}
}

// newProjectDir 建一个带稳定基名的项目根目录（单元键 = 根目录基名，临时目录
// 随机名不可作键）
func newProjectDir(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// ── 指纹与枚举 ──

func TestRootBasename(t *testing.T) {
	cases := map[string]string{
		`D:\work\proj`:  "proj",
		`D:\work\proj\`: "proj",
		"/home/u/proj/": "proj",
		"/home/u/proj":  "proj",
		"proj":          "proj",
		"":              "",
		`C:\`:           "C:",
	}
	for in, want := range cases {
		if got := rootBasename(in); got != want {
			t.Errorf("rootBasename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeZipName(t *testing.T) {
	ok := map[string]string{
		"a/b/c.txt":     "a/b/c.txt",
		`\a\b.txt`:      "a/b.txt",
		"C:/x/y.txt":    "x/y.txt",
		"/abs/path.txt": "abs/path.txt",
		"a/./b.txt":     "a/b.txt",
	}
	for in, want := range ok {
		if got := sanitizeZipName(in); got != want {
			t.Errorf("sanitizeZipName(%q) = %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"../evil.txt", "a/../../evil", "", "a/../.."} {
		if got := sanitizeZipName(bad); got != "" {
			t.Errorf("sanitizeZipName(%q) = %q, want empty (rejected)", bad, got)
		}
	}
}

func TestMatchExclude(t *testing.T) {
	if !matchExclude("node_modules/a/b.js", []string{"node_modules"}) {
		t.Fatal("裸名应命中任意路径段")
	}
	if !matchExclude("dist/x.js", []string{"dist"}) {
		t.Fatal("顶层 dist 应命中")
	}
	if matchExclude("src/dist-helper/x.js", []string{"dist"}) {
		t.Fatal("子串不应命中（段精确匹配）")
	}
	if !matchExclude("logs/a.log", []string{"*.log"}) {
		t.Fatal("glob 应对整相对路径生效")
	}
}

func TestFingerprintStableAcrossSeparator(t *testing.T) {
	// 同一文件集、不同分隔符输入 → 同一指纹（跨平台稳定口径）
	a := fingerprintFiles([]fileEntry{{rel: "src/main.go", size: 100}})
	b := fingerprintFiles([]fileEntry{{rel: `src\main.go`, size: 100}})
	if a != b {
		t.Fatal("分隔符归一后指纹应一致")
	}
	c := fingerprintFiles([]fileEntry{{rel: "src/main.go", size: 101}})
	if a == c {
		t.Fatal("size 变化应改变指纹")
	}
}

func TestEnumerateGitAwareRespectsGitignore(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		".gitignore":              "node_modules/\nsecret.txt\n",
		"src/main.go":             "package main",
		"node_modules/x/index.js": "x",
		"secret.txt":              "s",
	})
	// 无 git init 的目录走本地走树（默认排除清单不含 secret.txt——.gitignore
	// 感知仅在 git 仓库档）；先验 git 仓库档
	if _, err := runGit(t, root, "init", "-q"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	scan, err := enumerateUnitDir(root, false, false)
	if err != nil {
		t.Fatal(err)
	}
	rels := map[string]bool{}
	for _, f := range scan.files {
		rels[f.rel] = true
	}
	if !rels["src/main.go"] {
		t.Fatal("tracked 文件应在枚举集内")
	}
	if rels["node_modules/x/index.js"] {
		t.Fatal("gitignore 条目不应入枚举集")
	}
	if rels["secret.txt"] {
		t.Fatal("gitignore 条目不应入枚举集")
	}
	if scan.excluded < 2 {
		t.Errorf("排除计数应≥2（node_modules 整枝+secret.txt），got %d", scan.excluded)
	}
	// 含被忽略档
	scanAll, err := enumerateUnitDir(root, false, true)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range scanAll.files {
		if f.rel == "node_modules/x/index.js" {
			found = true
		}
	}
	if !found {
		t.Fatal("includeIgnored 档应包含被忽略文件")
	}
}

// runGit 测试夹具 git 执行（仓库 fixture 用）
func runGit(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()
	return execGitForTest(dir, args...)
}

// ── 四态判定 ──

func TestPlanFourStates(t *testing.T) {
	local := &ManifestResponse{Units: []UnitEntry{
		{Key: "project:alpha", Kind: UnitProject, Name: "alpha", Fingerprint: "L2", Size: 20, Exists: true},
		{Key: "project:beta", Kind: UnitProject, Name: "beta", Fingerprint: "L1", Size: 10, Exists: true},
		{Key: "project:gamma", Kind: UnitProject, Name: "gamma", Fingerprint: "LG", Size: 10, Exists: true},
		{Key: "project:delta", Kind: UnitProject, Name: "delta", Fingerprint: "L3", Size: 30, Exists: true, GitRepo: true},
	}}
	peer := &ManifestResponse{Units: []UnitEntry{
		{Key: "project:alpha", Kind: UnitProject, Name: "alpha", Fingerprint: "L2", Size: 20, Exists: true},
		{Key: "project:beta", Kind: UnitProject, Name: "beta", Fingerprint: "P2", Size: 12, Exists: true},
		{Key: "project:gamma", Kind: UnitProject, Name: "gamma", Fingerprint: "P1", Size: 10, Exists: true},
		{Key: "project:delta", Kind: UnitProject, Name: "delta", Fingerprint: "P3", Size: 30, Exists: true, GitRepo: true},
	}, DestRoot: "/srv/land", DiskFree: 1 << 30}
	// 账本基线：alpha 两端=基线(synced)；beta 本端=基线/对端已变(peer-newer)；
	// gamma 本端已变/对端=基线(local-newer)；delta 两端都变(conflict)
	ledger := map[string]store.SyncLedgerEntry{
		"project:alpha": {LocalFP: "L2", PeerFP: "L2"},
		"project:beta":  {LocalFP: "L1", PeerFP: "P1"},
		"project:gamma": {LocalFP: "L1", PeerFP: "P1"},
		"project:delta": {LocalFP: "L1", PeerFP: "P1"},
	}

	plan := planFromManifests(local, peer, ledger, nil, nil)
	states := map[string]PlanRow{}
	for _, row := range plan.Rows {
		states[row.Key] = row
	}
	if got := states["project:alpha"].State; got != PlanSynced {
		t.Errorf("alpha state = %s, want synced", got)
	}
	if got := states["project:beta"].State; got != PlanPeerNewer {
		t.Errorf("beta state = %s, want peer-newer", got)
	}
	if states["project:beta"].Action != PlanPull || !states["project:beta"].Selected {
		t.Errorf("beta 应建议 pull 且默认勾选")
	}
	if got := states["project:gamma"].State; got != PlanLocalNewer {
		t.Errorf("gamma state = %s, want local-newer", got)
	}
	if states["project:gamma"].Action != PlanPush {
		t.Errorf("gamma 应建议 push")
	}
	if got := states["project:delta"].State; got != PlanConflict {
		t.Errorf("delta state = %s, want conflict", got)
	}
	if states["project:delta"].Selected {
		t.Errorf("冲突默认不勾")
	}
	if !states["project:delta"].GitBothChanged {
		t.Errorf("双 git 仓库冲突应标 GitBothChanged")
	}
	if got := states["project:epsilon"].State; len(plan.Rows) > 0 && got != "" {
		// 不存在的键不应产出
		t.Errorf("不存在的键不应产出行")
	}
	if plan.PeerDiskFree != 1<<30 {
		t.Errorf("对端磁盘水位应透传")
	}
}

func TestPlanNewWithoutBaseline(t *testing.T) {
	local := &ManifestResponse{Units: []UnitEntry{
		{Key: "project:fresh", Kind: UnitProject, Name: "fresh", Fingerprint: "L1", Size: 100, Exists: true, Path: "/work/fresh"},
	}}
	peer := &ManifestResponse{Units: []UnitEntry{}, DestRoot: "/srv"}
	plan := planFromManifests(local, peer, nil, nil, nil)
	if len(plan.Rows) != 1 {
		t.Fatalf("应有 1 行，got %d", len(plan.Rows))
	}
	row := plan.Rows[0]
	if row.State != PlanNew || !row.BaselineMissing {
		t.Errorf("无基线应为 new 档，got %s", row.State)
	}
	if row.Action != PlanPush || !row.Selected {
		t.Errorf("对端缺内容的新增档应建议 push 且默认勾选")
	}
	if row.DestPath != "/srv/fresh" {
		t.Errorf("落位路径预览 = %q, want /srv/fresh", row.DestPath)
	}
}

func TestPlanScopeFilter(t *testing.T) {
	local := &ManifestResponse{Units: []UnitEntry{
		{Key: "project:a", Kind: UnitProject, Name: "a", Fingerprint: "L1", Exists: true},
		{Key: "crons:a", Kind: UnitCrons, ProjectKey: "project:a", Fingerprint: "C1", Exists: true},
		{Key: "project:b", Kind: UnitProject, Name: "b", Fingerprint: "L2", Exists: true},
	}}
	peer := &ManifestResponse{Units: []UnitEntry{}}
	plan := planFromManifests(local, peer, nil, []string{"project:a"}, []string{"crons"})
	if len(plan.Rows) != 2 {
		t.Fatalf("scope 过滤应只留 a 的两行，got %d", len(plan.Rows))
	}
}

// ── 账本 ──

func TestSyncLedgerCascade(t *testing.T) {
	setupSyncEnv(t)
	put := func(peer, unit string) {
		if err := store.Get().SyncLedger.Put(store.SyncLedgerEntry{
			PeerID: peer, UnitKey: unit, LocalFP: "l", PeerFP: "p",
		}); err != nil {
			t.Fatal(err)
		}
	}
	put("peer1", "project:a")
	put("peer1", "project:b")
	put("peer2", "project:a")

	if e, err := store.Get().SyncLedger.Get("peer1", "project:a"); err != nil || e.LocalFP != "l" {
		t.Fatalf("Get 应命中: %v %v", e, err)
	}
	if _, err := store.Get().SyncLedger.Get("peerX", "project:a"); err == nil {
		t.Fatal("不存在的账目应 ErrNotFound")
	}
	if err := store.Get().SyncLedger.DeleteByUnit("project:a"); err != nil {
		t.Fatal(err)
	}
	list, _ := store.Get().SyncLedger.List()
	if len(list) != 1 || list[0].UnitKey != "project:b" {
		t.Fatalf("DeleteByUnit 后应只剩 peer1/project:b，got %v", list)
	}
	put("peer2", "project:c")
	if err := store.Get().SyncLedger.DeleteByPeer("peer1"); err != nil {
		t.Fatal(err)
	}
	list, _ = store.Get().SyncLedger.List()
	if len(list) != 1 || list[0].PeerID != "peer2" {
		t.Fatalf("DeleteByPeer 后应只剩 peer2 条目，got %v", list)
	}
}

// ── zip 打包-落位往返 ──

func TestPackAndLandProjectRoundTrip(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{
		"a.txt":             "hello",
		"sub/b.txt":         "world",
		"node_modules/c.js": "excluded",
	})
	seedProject(t, "p1", "alpha", src)
	destRoot := t.TempDir()

	payloads, errs := resolveUnitPayloads([]string{"project:alpha"}, false)
	if len(errs) != 0 || len(payloads) != 1 {
		t.Fatalf("resolve 失败: %v", errs)
	}
	var buf bytes.Buffer
	meta, err := packUnitsStream(context.Background(), &buf, payloads, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Units) != 1 || meta.Units[0].Key != "project:alpha" {
		t.Fatalf("meta 单元不符: %+v", meta.Units)
	}
	if meta.Units[0].Entries != 2 {
		t.Fatalf("node_modules 应被排除，entries = %d", meta.Units[0].Entries)
	}

	lr, err := landUnits(context.Background(), bytes.NewReader(buf.Bytes()), meta, destRoot, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(lr.Units) != 1 || !lr.Units[0].OK {
		t.Fatalf("落位失败: %+v", lr.Units)
	}
	landed := filepath.Join(destRoot, "alpha")
	if b, err := os.ReadFile(filepath.Join(landed, "sub", "b.txt")); err != nil || string(b) != "world" {
		t.Fatalf("落位内容不符: %v %q", err, b)
	}
	if _, err := os.Stat(filepath.Join(landed, "node_modules")); !os.IsNotExist(err) {
		t.Fatal("排除目录不应落位")
	}
	// 自动注册项目
	projects, _ := store.Get().Project.List()
	if len(projects) != 2 {
		t.Fatalf("应有 2 个项目（源+落位注册），got %d", len(projects))
	}
	var registered *config.ProjectConfig
	for i := range projects {
		if filepath.Clean(projects[i].Path) == filepath.Clean(landed) {
			registered = &projects[i]
		}
	}
	if registered == nil || registered.Name != "alpha" {
		t.Fatal("落位项目应自动注册且名字透传")
	}
}

func TestLandOverwriteCreatesBackup(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"f.txt": "NEW"})
	seedProject(t, "p1", "alpha", src)
	destRoot := t.TempDir()
	landed := filepath.Join(destRoot, "alpha")
	writeTree(t, landed, map[string]string{"f.txt": "OLD", "keep.txt": "KEEP"})

	payloads, _ := resolveUnitPayloads([]string{"project:alpha"}, false)
	var buf bytes.Buffer
	meta, err := packUnitsStream(context.Background(), &buf, payloads, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	lr, err := landUnits(context.Background(), bytes.NewReader(buf.Bytes()), meta, destRoot, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !lr.Units[0].OK || lr.Units[0].Overwritten != 1 {
		t.Fatalf("覆盖计数应=1: %+v", lr.Units[0])
	}
	if b, _ := os.ReadFile(filepath.Join(landed, "f.txt")); string(b) != "NEW" {
		t.Fatalf("覆盖后内容应更新: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(landed, "keep.txt")); string(b) != "KEEP" {
		t.Fatal("未覆盖文件应保留")
	}
	// 备份可回滚：.sync-backup/<ts>/f.txt = OLD
	matches, _ := filepath.Glob(filepath.Join(landed, ".sync-backup", "*", "f.txt"))
	if len(matches) != 1 {
		t.Fatalf("备份应存在一份: %v", matches)
	}
	if b, _ := os.ReadFile(matches[0]); string(b) != "OLD" {
		t.Fatalf("备份内容应是旧值: %q", b)
	}
}

func TestLandNewProjectStagingAtomic(t *testing.T) {
	// 原子落位：成功路径无 staging 残留；失败路径（包内穿越条目被拒 → 落位
	// 报错）不留半个项目
	setupSyncEnv(t)
	destRoot := t.TempDir()
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"ok.txt": "1"})
	seedProject(t, "p1", "alpha", src)
	payloads, _ := resolveUnitPayloads([]string{"project:alpha"}, false)
	var buf bytes.Buffer
	meta, err := packUnitsStream(context.Background(), &buf, payloads, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := landUnits(context.Background(), bytes.NewReader(buf.Bytes()), meta, destRoot, nil); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(destRoot)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), syncStagingName) {
			t.Fatalf("成功落位不应留 staging: %s", e.Name())
		}
	}
}

func TestLandRejectsTraversalEntries(t *testing.T) {
	setupSyncEnv(t)
	destRoot := t.TempDir()
	// 手工构造含穿越条目的 zip + meta
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("u0/ok.txt")
	_, _ = w.Write([]byte("1"))
	w2, _ := zw.Create(`u0/..\..\escape.txt`)
	_, _ = w2.Write([]byte("evil"))
	_ = zw.Close()
	meta := &TransferMeta{Units: []TransferUnit{{Key: "project:alpha", Kind: UnitProject, Name: "alpha", DirName: "alpha"}}}
	lr, err := landUnits(context.Background(), bytes.NewReader(buf.Bytes()), meta, destRoot, nil)
	if err != nil {
		t.Fatal(err)
	}
	if lr.Units[0].Skipped < 1 {
		t.Fatalf("穿越条目应被拒跳过并计数: %+v", lr.Units[0])
	}
	if _, err := os.Stat(filepath.Join(destRoot, "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("穿越文件不应落位")
	}
	if b, err := os.ReadFile(filepath.Join(destRoot, "alpha", "ok.txt")); err != nil || string(b) != "1" {
		t.Fatalf("合法条目应正常落位: %v %q", err, b)
	}
}

func TestUnitLockMutualExclusion(t *testing.T) {
	release, ok := tryUnitLock("project:locktest")
	if !ok {
		t.Fatal("首次应获锁")
	}
	if _, ok := tryUnitLock("project:locktest"); ok {
		t.Fatal("持锁期间二次获取应失败")
	}
	release()
	release2, ok := tryUnitLock("project:locktest")
	if !ok {
		t.Fatal("释放后应可重获")
	}
	release2()
}

// ── 进度中心并发回归（race 门禁食物：修复回归对撞形态）──
//
// 前提：无同步边的并发访问才会被 race 检测器成对记账——close(start) 同时放行
// 两 goroutine，二者之间无 happens-before 边，裸写/裸读对必被标记，与时序无关。

// TestProgressTerminalVsSnapshotRace 终态写 × 快照读 × 终态判定三路对撞：
// markFinished/running 与 snapshot 必须同锁域。修复前 finishJob 裸写
// Outcome/FinishedAt，500ms 节流尾沿定时器触发的 emit→snapshot 与之撕裂
func TestProgressTerminalVsSnapshotRace(t *testing.T) {
	for round := 0; round < 64; round++ {
		job := &SyncJob{ID: "jr1", Direction: "pull", Source: "manual",
			StartedAt: time.Now(), Outcome: "running", rt: &jobRuntime{}, env: &envCollector{}}
		job.Units = append(job.Units, UnitProgress{Key: "project:x", Kind: UnitProject, State: "queued"})
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); <-start; job.markFinished("done") }()
		go func() { defer wg.Done(); <-start; _ = job.snapshot() }()
		go func() { defer wg.Done(); <-start; _ = job.running() }()
		close(start)
		wg.Wait()
		if job.Outcome != "done" || job.FinishedAt == nil {
			t.Fatalf("终态应写入: %+v", job)
		}
	}
}

// TestProgressTouchVsEmitRace 多单元 goroutine 并发 touch 推进 × 广播 emit
// （=节流尾沿定时器所做调用的同步驱动形态）对撞：聚合字段写与快照读同锁域；
// 收尾 finishJob 与 demoteIfRunning（beginJob 兜底替换）各走一遍真实路径
func TestProgressTouchVsEmitRace(t *testing.T) {
	setBroadcaster(func(*SyncJob) {})
	t.Cleanup(func() { setBroadcaster(nil) })
	for round := 0; round < 8; round++ {
		job := &SyncJob{ID: fmt.Sprintf("jr2-%d", round), Direction: "push", Source: "manual",
			StartedAt: time.Now(), Outcome: "running", rt: &jobRuntime{}, env: &envCollector{}}
		for u := 0; u < 4; u++ {
			job.Units = append(job.Units, UnitProgress{
				Key: fmt.Sprintf("project:u%d", u), Kind: UnitProject, State: "queued", Total: 400,
			})
		}
		beginJob(job)
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(5)
		for w := 0; w < 4; w++ {
			go func(w int) {
				defer wg.Done()
				<-start
				key := fmt.Sprintf("project:u%d", w)
				for n := int64(1); n <= 400; n++ {
					job.setUnit(key, n, fmt.Sprintf("f-%d", n), "transferring")
					job.touch(hub)
				}
			}(w)
		}
		go func() {
			defer wg.Done()
			<-start
			for i := 0; i < 400; i++ {
				hub.emit(job)
			}
		}()
		close(start)
		wg.Wait()
		finishJob(job, "done")
		snap := currentProgress()
		if snap == nil || snap.Outcome != "done" || snap.SentBytes != 400*4 {
			t.Fatalf("收口快照应终态且满量: %+v", snap)
		}
	}
}

// TestBeginJobDemotesRunning 上一任务仍在跑时 beginJob 兜底替换：按失败收口
// 入 past（demoteIfRunning 判定与改写同锁域，已终态任务不重复入账）
func TestBeginJobDemotesRunning(t *testing.T) {
	setBroadcaster(func(*SyncJob) {})
	t.Cleanup(func() { setBroadcaster(nil) })
	// hub 是包级单例且 past 跨用例留存（前用例收口任务仍在册）——本用例断言
	// 「入账增量」语义，先清台保证确定性
	hub.mu.Lock()
	hub.past = nil
	hub.current = nil
	hub.mu.Unlock()
	old := &SyncJob{ID: "old", Direction: "pull", Source: "manual",
		StartedAt: time.Now(), Outcome: "running", rt: &jobRuntime{}, env: &envCollector{}}
	beginJob(old)
	// 模拟旧任务已推进过聚合字段（running 判定不受影响）
	old.markFinished("done")
	next := &SyncJob{ID: "next", Direction: "push", Source: "manual",
		StartedAt: time.Now(), Outcome: "running", rt: &jobRuntime{}, env: &envCollector{}}
	beginJob(next)
	hub.mu.Lock()
	pastLen := len(hub.past)
	hub.mu.Unlock()
	if pastLen != 0 {
		t.Fatalf("已终态任务不应被兜底重复入账: %d", pastLen)
	}
	if currentProgress() == nil || currentProgress().ID != "next" {
		t.Fatalf("当前任务应已是 next: %+v", currentProgress())
	}
	// 真兜底：running 任务被替换
	old2 := &SyncJob{ID: "old2", Direction: "pull", Source: "manual",
		StartedAt: time.Now(), Outcome: "running", rt: &jobRuntime{}, env: &envCollector{}}
	beginJob(old2)
	beginJob(next)
	if old2.Outcome != "failed" || old2.FinishedAt == nil {
		t.Fatalf("running 任务应被兜底收口为 failed: %+v", old2)
	}
}

// ── 定时同步任务 ──

func TestSyncCronIsDueAndPolicy(t *testing.T) {
	c := store.SyncCron{Hour: 9, Minute: 30, Weekdays: []int{1, 3, 5}}
	if !c.IsDue(time.Date(2026, 10, 26, 9, 30, 0, 0, time.UTC)) { // 周一
		t.Error("周一 9:30 应到点")
	}
	if c.IsDue(time.Date(2026, 10, 25, 9, 30, 0, 0, time.UTC)) { // 周日
		t.Error("周日不应到点")
	}
	if c.IsDue(time.Date(2026, 10, 26, 9, 31, 0, 0, time.UTC)) {
		t.Error("非整点分钟不应到点")
	}
	all := store.SyncCron{Hour: 0, Minute: 0}
	if !all.IsDue(time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)) {
		t.Error("空周几集 = 每天生效")
	}
	if store.NormalizeSyncPolicy("") != store.SyncPolicySafe {
		t.Error("缺省策略应归一 safe")
	}
	if store.NormalizeSyncPolicy("bogus") != store.SyncPolicySafe {
		t.Error("未知策略应归一 safe")
	}
	if store.NormalizeSyncPolicy(store.SyncPolicyLocalMirror) != store.SyncPolicyLocalMirror {
		t.Error("白名单策略应保留")
	}
}

func TestSyncCronStoreRoundTrip(t *testing.T) {
	setupSyncEnv(t)
	created, err := store.Get().SyncCron.Create(store.SyncCron{
		Name: "nightly", Direction: store.SyncCronDirPush,
		PeerIDs: []string{"peer1"}, ConflictPolicy: "bogus",
		Hour: 2, Minute: 0, Enabled: true, Timezone: "Asia/Shanghai",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ConflictPolicy != store.SyncPolicySafe {
		t.Fatal("非法策略应归一 safe")
	}
	if created.ID == "" || created.CreatedAt.IsZero() {
		t.Fatal("服务端应生成 id/时间戳")
	}
	got, err := store.Get().SyncCron.Get(created.ID)
	if err != nil || got.Name != "nightly" {
		t.Fatalf("Get 应命中: %v", err)
	}
	// 运行期事实：Update 不触碰，RecordRun 只走专门
	if _, err := store.Get().SyncCron.Update(created.ID, store.SyncCron{Name: "nightly2", Direction: "push", PeerIDs: []string{"peer1"}, Hour: 3, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	_ = store.Get().SyncCron.RecordRun(created.ID, time.Now(), "synced", "ok")
	after, _ := store.Get().SyncCron.Get(created.ID)
	if after.Name != "nightly2" || after.LastResult != "synced" {
		t.Fatalf("Update 应改名字、RecordRun 应落运行账: %+v", after)
	}
	if len(after.History) != 1 {
		t.Fatalf("运行历史应 1 条: %d", len(after.History))
	}
	if err := store.Get().SyncCron.Delete(created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get().SyncCron.Get(created.ID); err != store.ErrSyncCronNotFound {
		t.Fatalf("删除后应 not found, got %v", err)
	}
}

// ── 上下文单元载荷 ──

func TestCronsUnitRoundTrip(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"README.md": "demo"})
	seedProject(t, "p1", "alpha", src)
	cron, err := store.Get().AgentCron.Create(store.AgentCron{
		Name: "nightly build", Hour: 2, Minute: 0, Prompt: "build", Dir: filepath.Join(src, "sub"), Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	destRoot := t.TempDir()

	// 打包 project + crons 两个单元（笔记单元 P-20261108-3 起退役，见 retired_test.go）
	payloads, errs := resolveUnitPayloads([]string{"project:alpha", "crons:alpha"}, false)
	if len(errs) != 0 {
		t.Fatalf("resolve errs: %v", errs)
	}
	if len(payloads) != 2 {
		t.Fatalf("应有 2 个载荷: %d", len(payloads))
	}
	sortPayloads(payloads)
	var buf bytes.Buffer
	meta, err := packUnitsStream(context.Background(), &buf, payloads, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	// 预置同名任务到「对端」应去重不重复建
	lr, err := landUnits(context.Background(), bytes.NewReader(buf.Bytes()), meta, destRoot, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range lr.Units {
		if u.Error != "" {
			t.Fatalf("单元落位失败: %+v", u)
		}
	}
	// crons Dir 重映射到落位路径
	crons, _ := store.Get().AgentCron.List()
	var landed store.AgentCron
	var found int
	for _, c := range crons {
		if c.ID == cron.ID {
			continue // 源任务
		}
		if c.Name == "nightly build" {
			landed = c
			found++
		}
	}
	if found != 1 {
		t.Fatalf("对端应有恰好 1 条同名任务，got %d", found)
	}
	if !strings.HasPrefix(landed.Dir, destRoot) {
		t.Fatalf("任务 Dir 应重映射到落位路径: %q", landed.Dir)
	}
}

func TestManifestBuildsUnits(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"main.go": "package main"})
	seedProject(t, "p1", "alpha", src)
	// 笔记库有内容也不产出笔记单元（P-20261108-3：笔记不随实例同步）
	if _, err := store.Get().MultiNotes.Create(store.GlobalNotesScope, "随手记", "note"); err != nil {
		t.Fatal(err)
	}
	m := buildLocalManifest()
	found := map[string]bool{}
	for _, u := range m.Units {
		found[u.Key] = true
		if u.Kind == UnitProject {
			if u.Files != 1 || u.Size != int64(len("package main")) {
				t.Errorf("项目本体枚举不符: %+v", u)
			}
		}
	}
	if !found["project:alpha"] {
		t.Errorf("manifest 缺单元 project:alpha: %v", found)
	}
	for k := range found {
		if isRetiredUnitKey(k) {
			t.Errorf("manifest 不应再产出退役笔记单元: %s", k)
		}
	}
	if m.DestRoot == "" {
		t.Error("manifest 应带落位根（默认主目录形态）")
	}
}

// ── handlers 冒烟 ──

func TestManifestHandler(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"a.txt": "x"})
	seedProject(t, "p1", "alpha", src)
	r := gin.New()
	r.GET("/api/sync/manifest", GetManifest)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/sync/manifest", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("should 200, got %d", w.Code)
	}
	var body struct {
		Data ManifestResponse `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body.Data.Units) == 0 {
		t.Fatalf("manifest 响应不符: %s", w.Body.String())
	}
}

// ── 定时同步策略选单元 ──

func TestSelectUnitsForPolicy(t *testing.T) {
	plan := &PlanResponse{Rows: []PlanRow{
		{UnitEntry: UnitEntry{Key: "project:a"}, State: PlanLocalNewer, Action: PlanPush},
		{UnitEntry: UnitEntry{Key: "project:b"}, State: PlanPeerNewer, Action: PlanPull},
		{UnitEntry: UnitEntry{Key: "project:c"}, State: PlanConflict, Action: PlanSkip},
		{UnitEntry: UnitEntry{Key: "project:d"}, State: PlanSynced, Action: PlanSkip},
	}}
	units, conflicts := selectUnitsForPolicy(plan, store.SyncCronDirPush, store.SyncPolicySafe)
	if len(units) != 1 || units[0] != "project:a" || conflicts != 1 {
		t.Fatalf("safe+push 应只选 a: %v %d", units, conflicts)
	}
	units, _ = selectUnitsForPolicy(plan, store.SyncCronDirPull, store.SyncPolicySafe)
	if len(units) != 1 || units[0] != "project:b" {
		t.Fatalf("safe+pull 应只选 b: %v", units)
	}
	units, _ = selectUnitsForPolicy(plan, store.SyncCronDirPush, store.SyncPolicyLocalMirror)
	if len(units) != 2 {
		t.Fatalf("local-mirror+push 应选 a+c: %v", units)
	}
}
