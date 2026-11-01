package claims

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/kernel/kerneltest"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// storeProject 构造项目记录（项目 repo 的存储形态）
func storeProject(id, name, path string) config.ProjectConfig {
	return config.ProjectConfig{ID: id, Name: name, Path: path}
}

// newRepo 造一个带 .git 目录的项目目录（claim 锚点），返回项目路径
func newRepo(t *testing.T) string {
	t.Helper()
	p := t.TempDir()
	if err := os.MkdirAll(filepath.Join(p, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// plantClaim 在仓库锚点写入一条他实例 claim（age>0 造残留：updatedAt 回拨）
func plantClaim(t *testing.T, repo, instanceID string, port int, age time.Duration) {
	t.Helper()
	now := time.Now().Add(-age)
	c := Claim{InstanceID: instanceID, Port: port, StartedAt: now, UpdatedAt: now}
	gitDir := ResolveGitDir(repo)
	if gitDir == "" {
		t.Fatal("repo has no git dir")
	}
	if err := WriteClaim(gitDir, c); err != nil {
		t.Fatal(err)
	}
}

func TestResolveGitDir(t *testing.T) {
	// 常规仓库：.git 是目录 → 原样作为锚点
	repo := newRepo(t)
	if got := ResolveGitDir(repo); got != filepath.Join(repo, ".git") {
		t.Fatalf("plain repo gitdir = %q", got)
	}

	// linked worktree / submodule：.git 是指针文件，指向真实 gitdir
	//（同一目录树下造相对指针——相对路径以项目目录为基准解析）
	base := t.TempDir()
	wt := filepath.Join(base, "worktree-copy")
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	realGit := filepath.Join(base, "store", "modules", "sub", "gitdir")
	if err := os.MkdirAll(realGit, 0o755); err != nil {
		t.Fatal(err)
	}
	// 绝对路径指针
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: "+realGit+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ResolveGitDir(wt); got != realGit {
		t.Fatalf("worktree (absolute) gitdir = %q, want %q", got, realGit)
	}
	// 相对路径指针（相对项目目录解析）
	if err := os.WriteFile(filepath.Join(wt, ".git"), []byte("gitdir: ../store/modules/sub/gitdir\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ResolveGitDir(wt); got != realGit {
		t.Fatalf("worktree (relative) gitdir = %q, want %q", got, realGit)
	}

	// 非 git 目录：无锚点
	if got := ResolveGitDir(t.TempDir()); got != "" {
		t.Fatalf("non-git dir gitdir = %q, want empty", got)
	}
	// 指针文件指向不存在的目标：无有效锚点
	broken := t.TempDir()
	if err := os.WriteFile(filepath.Join(broken, ".git"), []byte("gitdir: /nonexistent/sc/xyz"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ResolveGitDir(broken); got != "" {
		t.Fatalf("broken pointer gitdir = %q, want empty", got)
	}
}

func TestWriteClaimScanRoundTrip(t *testing.T) {
	repo := newRepo(t)
	gitDir := ResolveGitDir(repo)

	started := time.Now().Add(-time.Hour)
	if err := WriteClaim(gitDir, Claim{InstanceID: "peer-1", Port: 9998, StartedAt: started, UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	peers, err := ScanGitDir(gitDir, "self-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 {
		t.Fatalf("peers = %d, want 1", len(peers))
	}
	if peers[0].InstanceID != "peer-1" || peers[0].Port != 9998 || !peers[0].StartedAt.Equal(started) {
		t.Fatalf("peer roundtrip mismatch: %+v", peers[0])
	}

	// 非法入参防御
	if err := WriteClaim("", Claim{InstanceID: "x"}); err == nil {
		t.Fatal("empty gitDir should be rejected")
	}
	if err := WriteClaim(gitDir, Claim{}); err == nil {
		t.Fatal("empty instanceId should be rejected")
	}
}

func TestScanSkipsSelfAndStale(t *testing.T) {
	repo := newRepo(t)
	gitDir := ResolveGitDir(repo)

	plantClaim(t, repo, "self-1", 9999, 0)                          // 自己的：跳过
	plantClaim(t, repo, "stale-peer", 9998, StaleAfter+time.Minute) // 残留：清理并跳过
	plantClaim(t, repo, "fresh-peer", 9997, 0)                      // 存活他实例：命中

	peers, err := ScanGitDir(gitDir, "self-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].InstanceID != "fresh-peer" {
		t.Fatalf("peers = %+v, want only fresh-peer", peers)
	}
	// 残留文件已被顺手清理；自己与存活者的文件仍在
	claimDir := ClaimDir(gitDir)
	if _, err := os.Stat(filepath.Join(claimDir, "stale-peer.json")); !os.IsNotExist(err) {
		t.Fatalf("stale claim should be GC'd, err=%v", err)
	}
	for _, keep := range []string{"self-1.json", "fresh-peer.json"} {
		if _, err := os.Stat(filepath.Join(claimDir, keep)); err != nil {
			t.Fatalf("claim %s should survive scan: %v", keep, err)
		}
	}
}

// TestListClaimsReadOnlySnapshot 族表聚合（P-20261003-56）的只读快照口：
// 全量返回（含自己 + 残留），且读路径零清理副作用——残留要显死态给用户
// 手动清，不能像 ScanGitDir 那样读取顺手删（两口的分工即本用例的存在理由）
func TestListClaimsReadOnlySnapshot(t *testing.T) {
	repo := newRepo(t)
	gitDir := ResolveGitDir(repo)

	plantClaim(t, repo, "self-1", 9999, 0)
	plantClaim(t, repo, "stale-peer", 9998, StaleAfter+time.Minute)
	plantClaim(t, repo, "fresh-peer", 9997, 0)

	got, err := ListClaims(gitDir)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Claim{}
	for _, c := range got {
		byID[c.InstanceID] = c
	}
	if len(byID) != 3 {
		t.Fatalf("ListClaims should return full snapshot (3 claims), got %+v", byID)
	}
	for id, port := range map[string]int{"self-1": 9999, "stale-peer": 9998, "fresh-peer": 9997} {
		c, ok := byID[id]
		if !ok || c.Port != port {
			t.Fatalf("claim %s = %+v, want port %d", id, c, port)
		}
	}
	// 只读纪律：残留文件原样保留
	if _, err := os.Stat(filepath.Join(ClaimDir(gitDir), "stale-peer.json")); err != nil {
		t.Fatalf("ListClaims must not GC stale claim, stat err=%v", err)
	}

	// 目录不存在：nil 而非错误（无 git 项目 = 空族表的常态）
	empty, err := ListClaims(filepath.Join(t.TempDir(), "no-git"))
	if err != nil || empty != nil {
		t.Fatalf("missing dir should be (nil, nil), got %+v, %v", empty, err)
	}
}

func TestScanIgnoresCorruptAndTmp(t *testing.T) {
	repo := newRepo(t)
	gitDir := ResolveGitDir(repo)
	plantClaim(t, repo, "fresh-peer", 9998, 0)

	claimDir := ClaimDir(gitDir)
	if err := os.WriteFile(filepath.Join(claimDir, "broken.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 原子写的 tmp 中间态：不参与扫描也不被清理
	if err := os.WriteFile(filepath.Join(claimDir, "writing.json.tmp"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	peers, err := ScanGitDir(gitDir, "self-1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].InstanceID != "fresh-peer" {
		t.Fatalf("peers = %+v, want only fresh-peer", peers)
	}
	if _, err := os.Stat(filepath.Join(claimDir, "broken.json")); err != nil {
		t.Fatalf("corrupt file should be left alone (may be mid-write): %v", err)
	}
	if _, err := os.Stat(filepath.Join(claimDir, "writing.json.tmp")); err != nil {
		t.Fatalf("tmp file should be left alone: %v", err)
	}
}

func TestScanMissingDir(t *testing.T) {
	peers, err := ScanGitDir(filepath.Join(t.TempDir(), ".git"), "self-1", time.Now())
	if err != nil || peers != nil {
		t.Fatalf("missing claim dir should scan clean, got peers=%v err=%v", peers, err)
	}
}

func TestRemoveClaim(t *testing.T) {
	repo := newRepo(t)
	gitDir := ResolveGitDir(repo)
	plantClaim(t, repo, "self-1", 9999, 0)
	plantClaim(t, repo, "peer-1", 9998, 0)

	if err := RemoveClaim(gitDir, "self-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(ClaimDir(gitDir), "self-1.json")); !os.IsNotExist(err) {
		t.Fatal("own claim should be removed")
	}
	// 他实例的 claim 不受清理影响（清理只删自己的）
	if _, err := os.Stat(filepath.Join(ClaimDir(gitDir), "peer-1.json")); err != nil {
		t.Fatalf("peer claim should survive: %v", err)
	}
	// 不存在 = 已清理语义
	if err := RemoveClaim(gitDir, "self-1"); err != nil {
		t.Fatalf("removing absent claim should be nil, got %v", err)
	}
	if err := RemoveClaim("", "self-1"); err != nil {
		t.Fatalf("empty gitDir should be no-op, got %v", err)
	}
}

func TestInstanceIDPersistence(t *testing.T) {
	dir := t.TempDir()
	id1, err := InstanceID(dir)
	if err != nil || id1 == "" {
		t.Fatalf("first InstanceID: %q err=%v", id1, err)
	}
	id2, err := InstanceID(dir)
	if err != nil || id2 != id1 {
		t.Fatalf("instance id not persistent: %q vs %q", id2, id1)
	}
	// 落盘内容即该身份（可读校验）
	data, err := os.ReadFile(filepath.Join(dir, "instance-id"))
	if err != nil || string(data) != id1 {
		t.Fatalf("instance-id file mismatch: %q err=%v", data, err)
	}
	// 损坏内容（空白）：重新生成而不是沿用
	if err := os.WriteFile(filepath.Join(dir, "instance-id"), []byte("  \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	id3, err := InstanceID(dir)
	if err != nil || id3 == "" || id3 == id1 {
		t.Fatalf("blank id should regenerate: %q (was %q)", id3, id1)
	}
}

// setupModuleStore 准备 store 与模块注入口，返回捕获的通知切片
func setupModuleStore(t *testing.T) (m *Module, notified *[]notification.Notification) {
	t.Helper()
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	captured := &[]notification.Notification{}
	m = NewModule(9999)
	m.dataDirFn = func() string { return t.TempDir() }
	m.notifyFn = func(n notification.Notification) { *captured = append(*captured, n) }
	return m, captured
}

func TestModuleConformance(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	dataDir := t.TempDir()
	kerneltest.Conformance(t, func() kernel.Module {
		m := NewModule(9999)
		m.dataDirFn = func() string { return dataDir }
		return m
	})
}

func TestStartClaimsAllAndStopCleans(t *testing.T) {
	m, captured := setupModuleStore(t)

	repo := newRepo(t)
	plantClaim(t, repo, "e2e-peer", 9998, 0) // 预置他实例存活 claim
	if err := store.Get().Project.Create(storeProject("p1", "双开项目", repo)); err != nil {
		t.Fatal(err)
	}

	k := kernel.New(slog.Default())
	ctx := context.Background()
	if err := m.Init(ctx, k); err != nil {
		t.Fatal(err)
	}
	if err := m.Start(ctx, k); err != nil {
		t.Fatal(err)
	}

	// 启动即全量 claim：本实例 claim 文件在位（与预置的对端文件共存）
	gitDir := ResolveGitDir(repo)
	own := filepath.Join(ClaimDir(gitDir), m.instanceID+".json")
	data, err := os.ReadFile(own)
	if err != nil {
		t.Fatalf("own claim missing after start: %v", err)
	}
	var c Claim
	if err := json.Unmarshal(data, &c); err != nil {
		t.Fatal(err)
	}
	if c.Port != 9999 || c.InstanceID != m.instanceID {
		t.Fatalf("own claim content mismatch: %+v", c)
	}

	// 启动扫描命中他实例 claim：入账一条冲突通知
	if len(*captured) != 1 {
		t.Fatalf("notifications = %d, want 1", len(*captured))
	}
	n := (*captured)[0]
	if n.Type != "warning" || n.Category != notification.CategorySystem {
		t.Fatalf("notification type/category = %s/%s", n.Type, n.Category)
	}
	if n.TitleKey != ConflictTitleKey || n.BodyKey != ConflictBodyKey {
		t.Fatalf("template keys = %s/%s", n.TitleKey, n.BodyKey)
	}
	if n.MsgParams["port"] != 9998 || n.MsgParams["project"] != "双开项目" {
		t.Fatalf("msgParams = %+v", n.MsgParams)
	}

	// Stop 退出清理：自己的 claim 移除，对端的保留
	if err := m.Stop(ctx, k); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(own); !os.IsNotExist(err) {
		t.Fatalf("own claim should be removed on stop, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(ClaimDir(gitDir), "e2e-peer.json")); err != nil {
		t.Fatalf("peer claim should survive module stop: %v", err)
	}
}

func TestScanDedupPerPeer(t *testing.T) {
	m, captured := setupModuleStore(t)

	repo := newRepo(t)
	plantClaim(t, repo, "peer-a", 9998, 0)
	// 走 Start 前置态（instanceID 装配）但不依赖完整生命周期：直接驱动扫描
	m.instanceID = "self-1"

	gitDir := ResolveGitDir(repo)
	m.scanProject("p1", "双开项目", gitDir)
	m.scanProject("p1", "双开项目", gitDir) // 同冲突重复扫描：去重不再入账
	if len(*captured) != 1 {
		t.Fatalf("notifications = %d, want 1（同对端去重）", len(*captured))
	}

	// 对端重启换号（新实例身份）：视为新冲突再次告知
	plantClaim(t, repo, "peer-b", 9997, 0)
	m.scanProject("p1", "双开项目", gitDir)
	if len(*captured) != 2 {
		t.Fatalf("notifications = %d, want 2（对端换号新冲突）", len(*captured))
	}
	if (*captured)[1].Body != "双开项目 — port 9997, instance peer-b" {
		t.Fatalf("body = %q", (*captured)[1].Body)
	}
}

func TestProjectLifecycleEvents(t *testing.T) {
	m, captured := setupModuleStore(t)

	repo := newRepo(t)
	plantClaim(t, repo, "e2e-peer", 9998, 0) // 添加项目前预置对端 claim
	if err := store.Get().Project.Create(storeProject("p1", "双开项目", repo)); err != nil {
		t.Fatal(err)
	}
	if err := store.Get().Project.Create(storeProject("p2", "普通项目", newRepo(t))); err != nil {
		t.Fatal(err)
	}

	m.instanceID = "self-1"
	// 添加事件：即时 claim + 补扫 → 命中对端入账
	m.onProjectAdded("p1", repo)
	if _, err := os.Stat(filepath.Join(ClaimDir(ResolveGitDir(repo)), m.instanceID+".json")); err != nil {
		t.Fatalf("added project should be claimed: %v", err)
	}
	if len(*captured) != 1 {
		t.Fatalf("notifications = %d, want 1", len(*captured))
	}

	// 移除事件：claim 即时清理
	m.onProjectRemoved("p1", repo)
	if _, err := os.Stat(filepath.Join(ClaimDir(ResolveGitDir(repo)), m.instanceID+".json")); !os.IsNotExist(err) {
		t.Fatalf("removed project claim should be cleaned, err=%v", err)
	}

	// 事件载荷形态不符：静默忽略不 panic
	m.onProjectAdded("", "")
}
