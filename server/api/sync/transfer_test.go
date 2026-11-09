package sync

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 传输链集成测试（P-20261023-1 拆解步骤 2）：本端真实 handler × 对端「land
// 后端」httptest 存根——对端落位复用本包 landUnits（同一实现），全链覆盖
// 客户端拨号/流式打包/对端落位/账本回账/自动注册。双真实实例的进程级隔离
// 受 store 全局单例限制，由 e2e 双实例形态覆盖（工作流编排侧）。

// peerStub 对端存根：/api/sync/manifest + /api/sync/units GET/POST。
// dir = 对端数据目录（land 复用真实落位链，destRoot 由测试指定）
type peerStub struct {
	server   *httptest.Server
	manifest *ManifestResponse
	// gotPush 记录推送落位结果（断言用）
	gotPush   *LandResult
	gotGet    []string // 收到的 keys 查询
	withMeta  bool
	rejectZip bool // 模拟传输中断：body 截断
	// gotDeliverMeta 记录 deliver 面收到的元数据头（预扫断言用）
	gotDeliverMeta *TransferMeta
}

func newPeerStub(t *testing.T, m *ManifestResponse) *peerStub {
	t.Helper()
	ps := &peerStub{manifest: m}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/meta", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version":      map[string]string{"version": "9.9.9-stub"},
			"capabilities": []string{syncCapability},
		})
	})
	mux.HandleFunc("/api/sync/manifest", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": ps.manifest})
	})
	mux.HandleFunc("/api/sync/units", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			ps.gotGet = strings.Split(r.URL.Query().Get("keys"), ",")
			// 打包一份小 zip 回流（单元内容无关紧要——落位断言聚焦链路）
			ps.withMeta = true
			var buf bytes.Buffer
			zw := zip.NewWriter(&buf)
			cw, _ := zw.Create("u0/pulled.txt")
			_, _ = cw.Write([]byte("from-peer"))
			_ = zw.Close()
			meta := &TransferMeta{Units: []TransferUnit{{Key: ps.gotGet[0], Kind: UnitProject, Name: "pulled", DirName: "pulled", Fingerprint: "peerfp"}}}
			w.Header().Set(syncMetaHeader, mustJSON(meta))
			w.Header().Set("Content-Type", "application/zip")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(buf.Bytes())
		case http.MethodPost:
			raw := r.Header.Get(syncMetaHeader)
			if raw == "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			var meta TransferMeta
			if json.Unmarshal([]byte(raw), &meta) != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if r.URL.Query().Get("mode") == "deliver" {
				// deliver 面只回执不落位（本端 landUnits 不识别 deliver 单元）：
				// 记录元数据供预扫断言，回执按成功单元回
				ps.gotDeliverMeta = &meta
				_ = json.NewEncoder(w).Encode(map[string]any{"data": LandResult{
					DestRoot: "stub", Units: []LandUnitResult{{Key: meta.Units[0].Key, OK: true}},
				}})
				return
			}
			if ps.rejectZip {
				// 模拟传输中断：只收一半 body 即断开
				buf := make([]byte, 16)
				_, _ = io.ReadFull(r.Body, buf)
				panic(http.ErrAbortHandler)
			}
			lr, err := landUnits(r.Context(), r.Body, &meta, t.TempDir(), nil)
			if err != nil {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(err.Error()))
				return
			}
			ps.gotPush = lr
			_ = json.NewEncoder(w).Encode(map[string]any{"data": lr})
		}
	})
	ps.server = httptest.NewServer(mux)
	t.Cleanup(ps.server.Close)
	return ps
}

// registerPeer 实例注册（对端 URL + 令牌，走真实 InstanceStore 加密链）
func registerPeer(t *testing.T, url string) config.InstanceConfig {
	t.Helper()
	inst := store.Get().Instance.NewRemote("stub-peer", url, "sc_e2e_peer_token")
	if err := store.Get().Instance.Save(inst); err != nil {
		t.Fatal(err)
	}
	return inst
}

func TestFullChainPlanPullAndPush(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"a.txt": "local"})
	seedProject(t, "p1", "alpha", src)

	peerRoot := t.TempDir()
	// 对端 manifest 带 project:alpha（指纹不同 → peer-newer 预期 pull）
	peer := newPeerStub(t, &ManifestResponse{
		Units: []UnitEntry{{Key: "project:alpha", Kind: UnitProject, Name: "alpha",
			Fingerprint: "peerfp", Size: 9, Files: 1, Exists: true}},
		DestRoot: peerRoot, DiskFree: 1 << 30, Version: "9.9.9-stub",
	})
	inst := registerPeer(t, peer.server.URL)

	// plan（scope 到项目单元）：无基线 → new 档
	plan, err := BuildPlan(context.Background(), inst, []string{"project:alpha"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !plan.PeerOnline || plan.PeerUnsupported {
		t.Fatalf("对端应在线且支持 sync: %+v", plan)
	}
	if len(plan.Rows) != 1 || plan.Rows[0].State != PlanNew {
		t.Fatalf("plan 应 1 行 new 档: %+v", plan.Rows)
	}

	// pull：拉取落地本端
	localRoot := t.TempDir()
	job := &SyncJob{ID: "j1", Direction: "pull", Source: "manual", StartedAt: time.Now(), Outcome: "running", rt: &jobRuntime{}, env: &envCollector{}}
	beginJob(job)
	up := &UnitProgress{Key: "project:alpha", Kind: UnitProject, Name: "alpha", State: "queued"}
	job.Units = append(job.Units, *up)
	req := ExecuteRequest{InstanceIDs: []string{inst.ID}, Units: []string{"project:alpha"}, DestRoot: localRoot}
	if err := pullOneUnitForTest(job, req, inst, "project:alpha"); err != nil {
		t.Fatal(err)
	}
	finishJob(job, "done")
	// 拉取落位（对端包 DirName=pulled）→ 指定落位根出现 pulled 项目
	if _, err := os.Stat(filepath.Join(localRoot, "pulled", "pulled.txt")); err != nil {
		t.Fatalf("拉取应落地: %v", err)
	}
	// 账本回账（对端指纹 peerfp）
	e, err := store.Get().SyncLedger.Get(inst.ID, "project:alpha")
	if err != nil || e.PeerFP != "peerfp" {
		t.Fatalf("拉取应回账: %v %+v", err, e)
	}

	// push：本端推到对端（对端 land 复用真实落位链）
	job2 := &SyncJob{ID: "j2", Direction: "push", Source: "manual", StartedAt: time.Now(), Outcome: "running", rt: &jobRuntime{}, env: &envCollector{}}
	beginJob(job2)
	up2 := &UnitProgress{Key: "project:alpha", Kind: UnitProject, Name: "alpha", State: "queued"}
	job2.Units = append(job2.Units, *up2)
	if err := pushOneUnitForTest(job2, req, inst, "project:alpha"); err != nil {
		t.Fatal(err)
	}
	finishJob(job2, "done")
	if peer.gotPush == nil || len(peer.gotPush.Units) != 1 || !peer.gotPush.Units[0].OK {
		t.Fatalf("对端应成功落位推送: %+v", peer.gotPush)
	}
	// push 后双端账本：LocalFP == PeerFP（对端落地=源内容）
	e2, _ := store.Get().SyncLedger.Get(inst.ID, "project:alpha")
	if e2.LocalFP == "" || e2.LocalFP != e2.PeerFP {
		t.Fatalf("push 后两端指纹应一致: %+v", e2)
	}
}

// TestDeliverChainMetaPrescanned 投递全链（方案④）：元数据头在打包协程启动前
// 预扫定形（Entries/Size/Dest 随头先行）——修复前打包协程就地回写 meta 与
// postPeerDeliver 的头序列化并发（race 门禁口径）；本用例同时让 race 检测器
// 覆盖「打包协程 × 头序列化」的真实并发形态
func TestDeliverChainMetaPrescanned(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{
		"sub/a.txt": "hello", "sub/deep/b.txt": "xy", "top.txt": "z",
	})
	seedProject(t, "p1", "alpha", src)
	peer := newPeerStub(t, &ManifestResponse{DestRoot: t.TempDir()})
	inst := registerPeer(t, peer.server.URL)
	p := findProjectByID("p1")
	if p == nil {
		t.Fatal("项目应已注册")
	}

	// 目录子树投递：2 条目、字节 = 两文件内容长
	lr, err := deliverToPeer(context.Background(), inst, p, "sub", "delivered-sub")
	if err != nil {
		t.Fatal(err)
	}
	if len(lr.Units) != 1 || !lr.Units[0].OK {
		t.Fatalf("投递应成功: %+v", lr)
	}
	dm := peer.gotDeliverMeta
	if dm == nil || len(dm.Units) != 1 {
		t.Fatalf("对端应收到 deliver 元数据: %+v", dm)
	}
	if dm.Units[0].Entries != 2 || dm.Units[0].Size != int64(len("hello")+len("xy")) {
		t.Fatalf("元数据应携带预扫 Entries/Size: %+v", dm.Units[0])
	}
	if dm.Units[0].Dest != "delivered-sub" {
		t.Fatalf("Dest 应随元数据先行: %+v", dm.Units[0])
	}

	// 单文件投递：1 条目、字节 = 内容长
	if _, err := deliverToPeer(context.Background(), inst, p, "top.txt", "delivered-file"); err != nil {
		t.Fatal(err)
	}
	if peer.gotDeliverMeta.Units[0].Entries != 1 || peer.gotDeliverMeta.Units[0].Size != 1 {
		t.Fatalf("单文件元数据应 1 条目 1 字节: %+v", peer.gotDeliverMeta.Units[0])
	}

	// 路径安全：源 relPath 与 dest 的 ".." 在发起前即拒
	if _, err := deliverToPeer(context.Background(), inst, p, "../etc", "x"); err == nil {
		t.Fatal("源路径穿越应拒绝")
	}
	if _, err := deliverToPeer(context.Background(), inst, p, "sub", "../escape"); err == nil {
		t.Fatal("dest 路径穿越应拒绝")
	}
}

// pullOneUnitForTest / pushOneUnitForTest 执行单测缝：绕开 executeSync 的
// store 全量编排，直测单单元链
func pullOneUnitForTest(job *SyncJob, req ExecuteRequest, inst config.InstanceConfig, key string) error {
	ctx := context.Background()
	lr, err := pullOneUnit(ctx, job, req, inst, key)
	if err != nil {
		return err
	}
	_ = lr
	return nil
}

func pushOneUnitForTest(job *SyncJob, req ExecuteRequest, inst config.InstanceConfig, key string) error {
	return pushOneUnit(context.Background(), job, req, inst, key)
}

func TestTransferInterruptedNoResidue(t *testing.T) {
	setupSyncEnv(t)
	peer := newPeerStub(t, &ManifestResponse{DestRoot: t.TempDir()})
	peer.rejectZip = true
	_ = registerPeer(t, peer.server.URL) // 实例注册链烟测（本用例直接打 landUnits）

	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"a.txt": strings.Repeat("x", 4096)})
	seedProject(t, "p1", "alpha", src)
	destRoot := t.TempDir()

	// 直接对 landUnits 喂截断 zip：报错且不留半个项目（原子落位纪律）
	payloads, _ := resolveUnitPayloads([]string{"project:alpha"}, false)
	var buf bytes.Buffer
	meta, err := packUnitsStream(context.Background(), &buf, payloads, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	truncated := buf.Bytes()[:buf.Len()/2]
	_, err = landUnits(context.Background(), bytes.NewReader(truncated), meta, destRoot, nil)
	if err == nil {
		t.Fatal("截断 zip 应报错")
	}
	if _, err := os.Stat(filepath.Join(destRoot, "alpha")); !os.IsNotExist(err) {
		t.Fatal("中断落位不应留半个项目")
	}
	entries, _ := os.ReadDir(destRoot)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), syncStagingName) {
			t.Fatalf("中断不应留 staging（zip 随机访问前置校验拦在解包前）: %s", e.Name())
		}
	}
}

func TestRedLineNoCredentialsInPayload(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"a.txt": "x"})
	seedProject(t, "p1", "alpha", src)
	// 播种「永不同步」红线载荷：git 凭据 secret（凭据库不在同步单元词表内，
	// 红线断言 = 全量可同步载荷中 secret 字节不出现）
	const secret = "sc-redline-secret-DONT-SYNC-42"
	if err := store.Get().Credential.Save(&store.Credential{
		ID: "cred-1", Host: "github.com", Platform: "github", AuthType: "basic",
		Username: "e2e-user", Secret: secret, Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	// 打包全部可同步单元（项目本体+全局；笔记单元 P-20261108-3 起退役不在列），
	// 断言 secret 字节不在任何载荷
	payloads, errs := resolveUnitPayloads([]string{"project:alpha",
		"snippets", "runtimes", "approvals", "chains", "uistate"}, false)
	for _, e := range errs {
		if !strings.Contains(e, "has no content") && !strings.Contains(e, "not found") &&
			!strings.Contains(e, "no sessions") && !strings.Contains(e, "empty") {
			t.Fatalf("意外解析错误: %v", e)
		}
	}
	var buf bytes.Buffer
	if _, err := packUnitsStream(context.Background(), &buf, payloads, true, true, nil); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(buf.Bytes(), []byte(secret)) {
		t.Fatal("红线：凭据 secret 出现在同步载荷中")
	}
	// manifest 面同样不带
	m := buildLocalManifest()
	if strings.Contains(mustJSON(&m), secret) {
		t.Fatal("红线：凭据 secret 出现在 manifest 中")
	}
}
