package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// P-20261109-9 伴随资产：skipCache 重拉 + 下载前拒绝 + 缓存语义。
//
// 下载地址恒被 ValidatePublicHTTPSURL 拒（测试用 http 回环占位）——「越过伴随
// 预检进入下载」的证据取失败落点：download 阶段报错而非伴随拒绝；「不进下载」
// 的证据取本次临时目录未创建（MkdirAll 在预检之后）

const fakeDownloadURL = "http://127.0.0.1:1/never-fetched"

// countedSource 固定应答 + 到达计数（重拉次数与 skipCache 语义的断言依据）
type countedSource struct {
	info *ReleaseInfo
	err  error
	hits atomic.Int32
}

func (c *countedSource) FetchLatest(_ context.Context, _, _ string) (*ReleaseInfo, error) {
	c.hits.Add(1)
	if c.info == nil {
		return nil, c.err
	}
	cp := *c.info // 每次给新副本：缓存与调用方持有的 info 不互相别名
	return &cp, c.err
}

func failing(reason string) *ReleaseInfo {
	return &ReleaseInfo{Version: "9.9.9", DownloadURL: fakeDownloadURL, ChecksumFetchErr: reason}
}

func healthy() *ReleaseInfo {
	return &ReleaseInfo{Version: "9.9.9", DownloadURL: fakeDownloadURL, ChecksumSHA256: "ab"}
}

// companionManager 干净管理器 + 生产同款 1h 缓存窗（粘性正是本组要处置的对象）。
// 逃生门两名清空、公钥置空：断言依赖「默认拒绝」口径，开发机若设了逃生门 env
// 会让拒绝路径变放行；重拉时限压缩防挂
func companionManager(t *testing.T, src UpdateSource) *Manager {
	t.Helper()
	old := companionRefetchTimeout
	companionRefetchTimeout = 2 * time.Second
	t.Cleanup(func() { companionRefetchTimeout = old })
	t.Setenv(AllowUnverifiedEnv, "")
	t.Setenv(AllowUnverifiedEnvOld, "")
	resetPubKey(t, "")
	m := testManager(t)
	m.cacheDuration = time.Hour
	m.SetSource(src)
	return m
}

func tmpDirCreated(m *Manager) bool {
	_, err := os.Stat(filepath.Join(m.dataDir, "tmp", "update-9.9.9"))
	return err == nil
}

// skipCache 语义双向：命中缓存不读；拉取失败也不回落过期缓存（skipCache 是
// 「要实时结果」，回落会把旧结果冒充成新结果透出）；普通路径回落语义不变
func TestCheckUpdateWithCacheSkipCacheSemantics(t *testing.T) {
	src := &countedSource{info: &ReleaseInfo{Version: "0.0.3"}}
	m := companionManager(t, src)

	for i := 0; i < 2; i++ {
		if _, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil {
			t.Fatal(err)
		}
	}
	if n := src.hits.Load(); n != 1 {
		t.Fatalf("cache hit should not fetch, hits = %d", n)
	}
	if fresh, err := m.CheckUpdateWithCache(context.Background(), "0.0.1", true); err != nil || fresh.Version != "0.0.3" || src.hits.Load() != 2 {
		t.Fatalf("skipCache must bypass cache: %v / hits %d", err, src.hits.Load())
	}
	src.err = context.DeadlineExceeded
	if _, err := m.CheckUpdateWithCache(context.Background(), "0.0.1", true); err == nil {
		t.Fatal("skipCache must surface fetch errors (no stale fallback)")
	}
	m.cacheDuration = 0 // 让缓存过期，验普通路径的过期回落
	if back, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil || back.Version != "0.0.3" {
		t.Fatalf("non-skip path should still fall back to stale cache: %v", err)
	}
}

// 检查不覆写在途更新状态（伴随重拉拉长闸门前检查窗，并发第二个 apply 不得
// 因 Checking→Idle 的覆写在闸门处误判可起跑）。状态机覆盖面与
// TestCheckUpdateKeepsInFlightStatus（manager_async_test.go，09-10）互补：那条
// 钉四态守卫本体，本条钉「守卫生效后重拉窗内的并发闸门仍拒绝」
func TestApplyUpdateGateDuringRefetchWindow(t *testing.T) {
	src := &countedSource{info: failing("still down")}
	m := companionManager(t, src)
	m.status = StatusDownloading
	m.errMsg = ""
	// 带失败标记的 info 撞上在途更新：重拉照走（skipCache 检查不抹在途态），
	// 闸门拒绝在先——伴随拒绝落账在闸门之后，不得把在途更新改写成 failed
	err := m.ApplyUpdate(context.Background(), failing("cached"), "0.0.1", 0, nil)
	if !errors.Is(err, ErrUpdateInProgress) {
		t.Fatalf("concurrent apply must hit the in-flight gate first, got %v", err)
	}
	if src.hits.Load() != 1 {
		t.Fatalf("refetch should still run before the gate, hits = %d", src.hits.Load())
	}
	if st := m.GetStatus(); st.Status != StatusDownloading || st.ErrMsg != "" {
		t.Fatalf("in-flight state clobbered: status=%s errMsg=%q", st.Status, st.ErrMsg)
	}
}

// 重拉成功（伴随资产恢复）→ 越过预检照常进下载；缓存随之刷新（面板再查即恢复）
func TestApplyUpdateRefetchRecovers(t *testing.T) {
	src := &countedSource{info: healthy()}
	m := companionManager(t, src)

	err := m.ApplyUpdate(context.Background(), failing("transient 502"), "0.0.1", 0, nil)
	if err == nil || strings.Contains(err.Error(), "companion asset fetch failed") {
		t.Fatalf("refetch recovered — must not be refused for companions, got %v", err)
	}
	if st := m.GetStatus(); !strings.HasPrefix(st.ErrMsg, "download failed") {
		t.Fatalf("should have reached the download stage, errMsg=%q", st.ErrMsg)
	}
	if n := src.hits.Load(); n != 1 {
		t.Fatalf("want exactly one skipCache refetch, hits = %d", n)
	}
	if m.cachedInfo == nil || m.cachedInfo.CompanionFetchFailed() || m.cachedInfo.ChecksumSHA256 != "ab" {
		t.Fatalf("cache should hold the recovered info, got %+v", m.cachedInfo)
	}
}

// 重拉后仍失败：透出三态真实原因（带拉取原因与重试指引，不再误报「release
// 没提供」）且不进下载；errMsg 落账；终态可重试语义保持
func TestApplyUpdateRefusedWhenRefetchStillFails(t *testing.T) {
	src := &countedSource{info: failing("status 503 (after 3 attempts)")}
	m := companionManager(t, src)

	err := m.ApplyUpdate(context.Background(), failing("stale reason"), "0.0.1", 0, nil)
	if err == nil {
		t.Fatal("expected refusal when companions still failing after retry")
	}
	msg := err.Error()
	if !strings.Contains(msg, "companion asset fetch failed") || !strings.Contains(msg, "status 503") ||
		!strings.Contains(msg, AllowUnverifiedEnv+"=1") || strings.Contains(msg, "release provides no checksum") {
		t.Fatalf("refusal must carry the re-fetched real reason + guidance, got: %v", err)
	}
	if strings.Contains(msg, "stale reason") {
		t.Fatalf("re-fetched reason supersedes the cached one, got: %v", err)
	}
	if src.hits.Load() != 1 {
		t.Fatalf("want exactly one refetch, hits = %d", src.hits.Load())
	}
	if tmpDirCreated(m) {
		t.Fatal("must refuse before the download stage (tmp dir created)")
	}
	if st := m.GetStatus(); st.Status != StatusFailed || !strings.Contains(st.ErrMsg, "companion asset fetch failed") {
		t.Fatalf("errMsg landing: status=%s errMsg=%q", st.Status, st.ErrMsg)
	}
	if err := m.ApplyUpdate(context.Background(), failing("x"), "0.0.1", 0, nil); err == nil ||
		strings.Contains(err.Error(), "already in progress") {
		t.Fatalf("failed state must stay retryable (refused again, not 409), got %v", err)
	}
}

// 重拉本身失败（release 端点不可达）：缓存里的旧原因保留，「re-fetch failed」
// 并入原因段（前端按「; retry or set」截取原因段插值，须整段在其前）
func TestApplyUpdateRefetchErrorAppended(t *testing.T) {
	stale := &ReleaseInfo{Version: "9.9.9", DownloadURL: fakeDownloadURL, SigFetchErr: "cached transient failure"}
	m := companionManager(t, &countedSource{err: context.DeadlineExceeded})

	err := m.ApplyUpdate(context.Background(), stale, "0.0.1", 0, nil)
	if err == nil {
		t.Fatal("expected refusal")
	}
	reason := strings.SplitN(err.Error(), "; retry or set", 2)[0]
	if !strings.Contains(reason, "cached transient failure") || !strings.Contains(reason, "re-fetch failed") {
		t.Fatalf("stale reason + refetch error must both sit in the reason segment, got: %v", err)
	}
	if tmpDirCreated(m) {
		t.Fatal("must refuse before the download stage")
	}
}

// 验收「缓存窗内二次点击能恢复」：API 层每次点击先走缓存检查再 ApplyUpdate——
// 第一次点击时链路仍坏（重拉也失败，失败结果入缓存）；链路恢复后，1h 缓存窗内
// 第二次点击拿到的仍是带失败标记的缓存，但 skipCache 重拉让它越过预检
func TestApplyUpdateSecondClickRecoversWithinCacheWindow(t *testing.T) {
	src := &countedSource{info: failing("dial tcp: i/o timeout")}
	m := companionManager(t, src)
	click := func() error {
		info, err := m.CheckUpdate(context.Background(), "0.0.1") // API 层同款前置
		if err != nil {
			t.Fatalf("check: %v", err)
		}
		return m.ApplyUpdate(context.Background(), info, "0.0.1", 0, nil)
	}

	if err := click(); err == nil || !strings.Contains(err.Error(), "companion asset fetch failed") {
		t.Fatalf("first click while network is bad should be refused, got %v", err)
	}

	src.info = healthy() // 链路恢复
	if cached, _ := m.CheckUpdate(context.Background(), "0.0.1"); !cached.CompanionFetchFailed() {
		t.Fatal("precondition: still inside the sticky cache window with the failure cached")
	}
	if err := click(); err == nil || strings.Contains(err.Error(), "companion asset fetch failed") {
		t.Fatalf("second click within cache window should recover past the preflight, got %v", err)
	}
	if st := m.GetStatus(); !strings.HasPrefix(st.ErrMsg, "download failed") {
		t.Fatalf("second click should reach the download stage, errMsg=%q", st.ErrMsg)
	}
	if after, _ := m.CheckUpdate(context.Background(), "0.0.1"); after.CompanionFetchFailed() {
		t.Fatal("cache should now hold the recovered info (panel re-check shows no warning)")
	}
}

// 健康信息（无失败标记）不触发重拉：零额外请求，流程与旧口径一致
func TestApplyUpdateNoRefetchWhenCompanionsOK(t *testing.T) {
	src := &countedSource{info: healthy()}
	m := companionManager(t, src)
	err := m.ApplyUpdate(context.Background(), healthy(), "0.0.1", 0, nil)
	if err == nil || !strings.HasPrefix(m.GetStatus().ErrMsg, "download failed") {
		t.Fatalf("healthy flow should go straight to download, got %v", err)
	}
	if n := src.hits.Load(); n != 0 {
		t.Fatalf("healthy info must not trigger refetch, hits = %d", n)
	}
}

// 逃生门开：伴随失败仍先重拉（尽量拿到校验数据），重拉仍失败时按原语义放行
// 进入下载（放行/拒绝判定零变化）
func TestApplyUpdateEscapeHatchUnchanged(t *testing.T) {
	src := &countedSource{info: failing("still down")}
	m := companionManager(t, src)
	t.Setenv(AllowUnverifiedEnv, "1")
	err := m.ApplyUpdate(context.Background(), failing("down"), "0.0.1", 0, nil)
	if err == nil || strings.Contains(err.Error(), "companion asset fetch failed") {
		t.Fatalf("escape hatch must not be refused for companions, got %v", err)
	}
	if !strings.HasPrefix(m.GetStatus().ErrMsg, "download failed") {
		t.Fatalf("escape hatch should proceed to download, errMsg=%q", m.GetStatus().ErrMsg)
	}
	if src.hits.Load() != 1 {
		t.Fatalf("should still try one refetch first, hits = %d", src.hits.Load())
	}
}

// 换源/切通道清缓存：SetSource 后立即可见新源版本，而非最长 1h 的旧缓存
// （切预发布通道「保存即生效」的缓存侧补全）
func TestSetSourceInvalidatesCache(t *testing.T) {
	first := &countedSource{info: &ReleaseInfo{Version: "0.0.2"}}
	m := companionManager(t, first)
	if _, err := m.CheckUpdate(context.Background(), "0.0.1"); err != nil {
		t.Fatal(err)
	}
	second := &countedSource{info: &ReleaseInfo{Version: "0.0.3-beta.1"}}
	m.SetSource(second)
	info, err := m.CheckUpdate(context.Background(), "0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != "0.0.3-beta.1" || second.hits.Load() != 1 {
		t.Fatalf("stale cache survived source switch: got %s (new source hits %d)", info.Version, second.hits.Load())
	}
}

// blockingSource 拉取挂住直到放行（换源竞态窗口的可控复现）
type blockingSource struct {
	info    *ReleaseInfo
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockingSource) FetchLatest(ctx context.Context, _, _ string) (*ReleaseInfo, error) {
	b.once.Do(func() { close(b.started) })
	select {
	case <-b.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	cp := *b.info
	return &cp, nil
}

// 拉取途中换源（设置保存热接线撞上在途检查）：旧源结果不得回写缓存——否则刚
// 清掉的旧通道结果又盖住新源 1h（换源代际守卫）
func TestSetSourceDuringFetchDoesNotRepopulateCache(t *testing.T) {
	slow := &blockingSource{
		info:    &ReleaseInfo{Version: "0.0.2"},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	m := companionManager(t, slow)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = m.CheckUpdate(context.Background(), "0.0.1")
	}()
	<-slow.started
	next := &countedSource{info: &ReleaseInfo{Version: "0.0.3-beta.1"}}
	m.SetSource(next)
	close(slow.release)
	<-done

	info, err := m.CheckUpdate(context.Background(), "0.0.1")
	if err != nil || info.Version != "0.0.3-beta.1" || next.hits.Load() != 1 {
		t.Fatalf("old-source result leaked into cache: %v / %+v (new source hits %d)", err, info, next.hits.Load())
	}
}

// 09-10 异步受理下的伴随前置（HTTP 入口 StartUpdate）：重拉仍失败 = 受理前拒绝
// ——三态真实原因同步交还请求方（不进异步下载）；零通知（「开始更新」是假话）、
// 不清上一轮结果文件、不建临时目录；errMsg 落账（/updates/status 诊断落点）
func TestStartUpdateCompanionRefusalIsSynchronous(t *testing.T) {
	src := &countedSource{info: failing("status 503 (after 3 attempts)")}
	m := companionManager(t, src)
	notes := captureNotifications(t)
	if err := SaveUpdateResult(m.dataDir, &UpdateResult{Status: "success", Version: "1.0.0"}); err != nil {
		t.Fatal(err)
	}

	err := m.StartUpdate(failing("stale reason"), "0.0.1", 0)
	if err == nil || !strings.Contains(err.Error(), "companion asset fetch failed: checksum: status 503") ||
		!strings.Contains(err.Error(), AllowUnverifiedEnv+"=1") {
		t.Fatalf("refusal must come back synchronously with the re-fetched reason, got %v", err)
	}
	if errors.Is(err, ErrUpdateInProgress) || errors.Is(err, ErrNpmManaged) {
		t.Fatalf("companion refusal must not masquerade as gate/npm rejection, got %v", err)
	}
	if st := m.GetStatus(); st.Status != StatusFailed || st.ErrMsg != err.Error() || st.Version != "9.9.9" {
		t.Fatalf("errMsg landing: %+v", st)
	}
	if n := len(notes()); n != 0 {
		t.Fatalf("pre-admission refusal must not notify, got %d", n)
	}
	if r, _ := LoadUpdateResult(m.dataDir); r == nil {
		t.Fatal("pre-admission refusal must leave the previous result file alone")
	}
	if tmpDirCreated(m) {
		t.Fatal("must refuse before the download stage")
	}
	// 失败态可重试：下一次点击照常走重拉/裁决，不被闸门当在途 409
	if err := m.StartUpdate(failing("x"), "0.0.1", 0); err == nil || errors.Is(err, ErrUpdateInProgress) {
		t.Fatalf("failed state must stay retryable (refused again, not 409), got %v", err)
	}
}

// 重拉恢复 → 受理（「开始」通知）后进后台下载；重拉换来更新的 release 时，
// 受理版本以流水线实际采用的为准（通知与状态机不报请求方缓存里的旧版本号）
func TestStartUpdateCompanionRefetchRecoversThenAdmits(t *testing.T) {
	newer := healthy()
	newer.Version = "9.9.10"
	src := &countedSource{info: newer}
	m := companionManager(t, src)
	notes := captureNotifications(t)

	if err := m.StartUpdate(failing("transient"), "0.0.1", 0); err != nil {
		t.Fatalf("recovered refetch should be admitted, got %v", err)
	}
	if v := m.GetStatus().Version; v != "9.9.10" {
		t.Fatalf("admitted version = %q, want the re-fetched 9.9.10", v)
	}
	// fakeDownloadURL 被 https 公网校验拒：后台落 download failed（越过了伴随预检的证据）
	waitFor(t, "background failure", func() bool { return m.GetStatus().Status == StatusFailed })
	if st := m.GetStatus(); !strings.HasPrefix(st.ErrMsg, "download failed") {
		t.Fatalf("should fail at the download stage, not the companion preflight: %q", st.ErrMsg)
	}
	waitFor(t, "two notifications", func() bool { return len(notes()) == 2 })
	got := notes()
	if got[0].TitleKey != notifyStartedTitleKey || got[0].MsgParams["version"] != "9.9.10" {
		t.Fatalf("started notification should carry the admitted version, got %+v", got[0])
	}
	if got[1].TitleKey != notifyFailedTitleKey || got[1].MsgParams["version"] != "9.9.10" {
		t.Fatalf("failed notification should carry the admitted version, got %+v", got[1])
	}
}
