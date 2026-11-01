package store_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupTestLockStore 构造一个基于临时目录的 LockStore
func setupTestLockStore(t *testing.T) store.LockStore {
	t.Helper()
	tmpDir := t.TempDir()
	docStoreDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(docStoreDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ds := filestore.New(docStoreDir)
	return store.NewForTesting(ds)
}

func TestLockStore_InitDefault(t *testing.T) {
	s := setupTestLockStore(t)

	if s.HasConfig() {
		t.Fatal("expected no config initially")
	}

	if err := s.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}

	if !s.HasConfig() {
		t.Fatal("expected config after InitDefault")
	}

	cfg := s.GetConfig()
	if !cfg.Enabled {
		t.Error("expected Enabled=true by default")
	}
	if !cfg.AutoLockEnabled {
		t.Error("expected AutoLockEnabled=true by default")
	}
	if cfg.AutoLockMinutes != 120 {
		t.Errorf("expected AutoLockMinutes=120, got %d", cfg.AutoLockMinutes)
	}
	if cfg.TokenTTLMinutes != 120 {
		t.Errorf("expected TokenTTLMinutes=120, got %d", cfg.TokenTTLMinutes)
	}
	if !s.IsDefaultPassword() {
		t.Error("expected IsDefaultPassword=true after InitDefault")
	}
}

func TestLockStore_VerifyPassword(t *testing.T) {
	s := setupTestLockStore(t)
	if err := s.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}

	if !s.VerifyPassword("admin") {
		t.Error("expected admin password to verify")
	}
	if s.VerifyPassword("wrong") {
		t.Error("expected wrong password to fail")
	}
}

func TestLockStore_UpdatePassword(t *testing.T) {
	s := setupTestLockStore(t)
	if err := s.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}

	// 错误旧密码
	if err := s.UpdatePassword("wrong", "newpass"); err == nil {
		t.Error("expected error for wrong old password")
	}

	// 正确旧密码
	if err := s.UpdatePassword("admin", "newpass123"); err != nil {
		t.Fatalf("UpdatePassword: %v", err)
	}

	if !s.VerifyPassword("newpass123") {
		t.Error("expected new password to verify")
	}
	if s.VerifyPassword("admin") {
		t.Error("expected old password to fail after update")
	}
	if s.IsDefaultPassword() {
		t.Error("expected IsDefaultPassword=false after update")
	}
}

// TestLockStore_UpdatePassword_RejectsEmpty 新密码为空（含纯空白）应返回 ErrPasswordEmpty
func TestLockStore_UpdatePassword_RejectsEmpty(t *testing.T) {
	s := setupTestLockStore(t)
	if err := s.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}

	cases := []string{"", "   ", "\t\n"}
	for i, newPlain := range cases {
		err := s.UpdatePassword("admin", newPlain)
		if err == nil {
			t.Errorf("case %d: expected error for empty new password %q", i, newPlain)
			continue
		}
		if !errors.Is(err, store.ErrPasswordEmpty) {
			t.Errorf("case %d: expected ErrPasswordEmpty, got %v", i, err)
		}
	}

	// 空密码校验失败不应改写哈希
	if !s.IsDefaultPassword() {
		t.Error("password hash should not change after empty rejection")
	}
}

func TestLockStore_IssueAndValidateToken(t *testing.T) {
	s := setupTestLockStore(t)

	token, err := s.IssueToken()
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if !strings.HasPrefix(token, "scl_") {
		t.Errorf("expected token prefix scl_, got %s", token)
	}
	if !s.ValidateToken(token) {
		t.Error("expected ValidateToken=true for issued token")
	}
	if s.ValidateToken("scl_invalid") {
		t.Error("expected ValidateToken=false for invalid token")
	}
}

func TestLockStore_RevokeToken(t *testing.T) {
	s := setupTestLockStore(t)

	t1, _ := s.IssueToken()
	t2, _ := s.IssueToken()

	if !s.ValidateToken(t1) || !s.ValidateToken(t2) {
		t.Fatal("both tokens should be valid")
	}

	s.RevokeToken(t1)

	if s.ValidateToken(t1) {
		t.Error("t1 should be invalid after RevokeToken")
	}
	if !s.ValidateToken(t2) {
		t.Error("t2 should still be valid (RevokeToken isolates)")
	}
}

func TestLockStore_RevokeAllTokens(t *testing.T) {
	s := setupTestLockStore(t)

	t1, _ := s.IssueToken()
	t2, _ := s.IssueToken()
	t3, _ := s.IssueToken()

	s.RevokeAllTokens()

	for i, tk := range []string{t1, t2, t3} {
		if s.ValidateToken(tk) {
			t.Errorf("token %d should be invalid after RevokeAllTokens", i)
		}
	}
}

func TestLockStore_ConcurrentIssueValidate(t *testing.T) {
	s := setupTestLockStore(t)

	var wg sync.WaitGroup
	// 并发 Issue
	tokens := make([]string, 50)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			tk, _ := s.IssueToken()
			tokens[idx] = tk
		}(i)
	}
	wg.Wait()

	// 并发 Validate
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			if !s.ValidateToken(tokens[idx]) {
				t.Errorf("token %d invalid under concurrent validate", idx)
			}
		}(i)
	}
	wg.Wait()

	// 全部撤销
	s.RevokeAllTokens()

	// 并发校验已撤销
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			if s.ValidateToken(tokens[idx]) {
				t.Errorf("token %d should be revoked", idx)
			}
		}(i)
	}
	wg.Wait()
}

// TestLockStore_WSConnRegisterAndRevoke 撤销 token 时所有注册的 closer 应被调用
func TestLockStore_WSConnRegisterAndRevoke(t *testing.T) {
	s := setupTestLockStore(t)

	token, _ := s.IssueToken()

	var closed1, closed2 atomic.Bool
	closer1 := func() { closed1.Store(true) }
	closer2 := func() { closed2.Store(true) }

	s.RegisterWSConn(token, closer1)
	s.RegisterWSConn(token, closer2)

	// 撤销 token 时所有 closer 应被调用
	s.RevokeToken(token)

	if !closed1.Load() {
		t.Error("closer 1 should be called")
	}
	if !closed2.Load() {
		t.Error("closer 2 should be called")
	}
}

// TestLockStore_WSConnUnregister 反注册的 closer 不应被调用
func TestLockStore_WSConnUnregister(t *testing.T) {
	s := setupTestLockStore(t)
	token, _ := s.IssueToken()

	var called atomic.Bool
	closer := func() { called.Store(true) }

	id := s.RegisterWSConn(token, closer)
	if id == 0 {
		t.Fatal("RegisterWSConn should return non-zero closerID")
	}
	s.UnregisterWSConn(token, id)

	s.RevokeToken(token)

	if called.Load() {
		t.Error("unregistered closer should not be called")
	}
}

// TestLockStore_RegisterWSConnStableIDs 验证多个相同闭包不会冲突
// Issue 3 的回归测试：closerID 自增而非 reflect.Pointer
func TestLockStore_RegisterWSConnStableIDs(t *testing.T) {
	s := setupTestLockStore(t)
	token, _ := s.IssueToken()

	// 同一个变量绑定到不同 close 计数：每次循环创建独立闭包，
	// 模拟 Phase 5 多个 WS handler 注册相同模板的 closer
	var callCount atomic.Int64
	mkCloser := func(i int) func() {
		return func() { callCount.Add(int64(i + 1)) }
	}

	ids := make([]int64, 0, 5)
	for i := 0; i < 5; i++ {
		id := s.RegisterWSConn(token, mkCloser(i))
		if id == 0 {
			t.Fatalf("RegisterWSConn %d returned zero ID", i)
		}
		for _, prev := range ids {
			if prev == id {
				t.Fatalf("duplicate closerID %d: reflect.Pointer collision risk", id)
			}
		}
		ids = append(ids, id)
	}

	// 反注册中间一个，剩余的应仍能被 RevokeToken 调用
	s.UnregisterWSConn(token, ids[2])

	s.RevokeToken(token)

	// 4 个 close 应被调用（5 - 1）
	// callCount 累加值 = (0+1)+(1+1)+(3+1)+(4+1) = 1+2+4+5 = 12（ids[2]=i=2 被反注册）
	got := callCount.Load()
	if got != 12 {
		t.Errorf("expected callCount=12 (sum of non-unregistered closers), got %d", got)
	}
}

// TestLockStore_StartCleanupLoopStoppable StartCleanupLoop 在 close(stop) 时应退出
func TestLockStore_StartCleanupLoopStoppable(t *testing.T) {
	s := setupTestLockStore(t)

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		s.StartCleanupLoop(stop)
		close(done)
	}()

	close(stop)
	select {
	case <-done:
		// ok: goroutine 在 stop 关闭后退出
	case <-time.After(2 * time.Second):
		t.Fatal("StartCleanupLoop did not stop after close(stop)")
	}
}

// TestLockStore_CleanupExpiredRemovesAndClosesWS cleanupOnce 应清理过期 token 并调用其 closer
// Issue 2 的核心测试：覆盖过期清理路径
func TestLockStore_CleanupExpiredRemovesAndClosesWS(t *testing.T) {
	s := setupTestLockStore(t)

	// 配置极短 TTL（100ms）
	store.SetTokenTTLForTesting(s, 100*time.Millisecond)

	token, _ := s.IssueToken()

	var closed atomic.Bool
	s.RegisterWSConn(token, func() { closed.Store(true) })

	// 立即触发清理：token 仍新鲜，不应被清理，closer 不应被调用
	store.TriggerCleanupExpiredForTesting(s)
	if closed.Load() {
		t.Fatal("closer should NOT be called for fresh token")
	}

	// 等待超过 TTL，避免调用 ValidateToken（会刷新 LastSeen）
	time.Sleep(200 * time.Millisecond)

	// 触发过期清理
	store.TriggerCleanupExpiredForTesting(s)

	// closer 应被调用
	if !closed.Load() {
		t.Error("closer should be called after token expired and cleanupOnce ran")
	}

	// token 应已失效
	if s.ValidateToken(token) {
		t.Error("token should be invalid after expired cleanup")
	}
}

// TestLockStore_CleanupExpiredSkipsFreshTokens cleanupOnce 不应清理未过期 token
func TestLockStore_CleanupExpiredSkipsFreshTokens(t *testing.T) {
	s := setupTestLockStore(t)
	store.SetTokenTTLForTesting(s, 10*time.Second)

	token, _ := s.IssueToken()

	var closed atomic.Bool
	s.RegisterWSConn(token, func() { closed.Store(true) })

	store.TriggerCleanupExpiredForTesting(s)

	if closed.Load() {
		t.Error("closer should NOT be called for fresh token")
	}
	if !s.ValidateToken(token) {
		t.Error("fresh token should remain valid after cleanup")
	}
}

// TestLockStore_CloserBlockingDoesNotDeadlock 验证 Issue 1 修复：
// 慢 closer 不应阻塞其他 ValidateToken / IssueToken 调用
func TestLockStore_CloserBlockingDoesNotDeadlock(t *testing.T) {
	s := setupTestLockStore(t)

	t1, _ := s.IssueToken()
	t2, _ := s.IssueToken()

	// 注册一个会阻塞 200ms 的 closer
	s.RegisterWSConn(t1, func() { time.Sleep(200 * time.Millisecond) })

	start := time.Now()

	// 在另一个 goroutine 中撤销 t1（会触发慢 closer）
	go s.RevokeToken(t1)

	// 主 goroutine 立即 ValidateToken(t2)，应在 closer 阻塞期间也能完成
	// 给 go 调度器一点时间让 RevokeToken 抢到锁
	time.Sleep(10 * time.Millisecond)

	if !s.ValidateToken(t2) {
		t.Fatal("ValidateToken(t2) blocked by slow closer on t1 — deadlock regression")
	}

	elapsed := time.Since(start)
	// 如果 ValidateToken(t2) 被阻塞到 closer 完成之后（>180ms），说明锁没释放
	if elapsed > 180*time.Millisecond {
		t.Errorf("ValidateToken(t2) took %v, expected <180ms (closer blocked lock)", elapsed)
	}
}

// TestLockStore_TokenSurvivesRestart 验证解锁 token 跨重启持久化：
// 服务重启（同一 docstore 重建 store）后浏览器持有的旧 token 仍有效，
// 用户无需重新解锁（此前 token 纯内存，每次重启全员被踢回锁定屏）
func TestLockStore_TokenSurvivesRestart(t *testing.T) {
	tmpDir := t.TempDir()
	docStoreDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(docStoreDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ds := filestore.New(docStoreDir)

	s1 := store.NewForTesting(ds)
	if err := s1.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}
	token, err := s1.IssueToken()
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	// 模拟重启：同一 docstore 上重建 store（active 内存 map 为空）
	s2 := store.NewForTesting(ds)
	if !s2.ValidateToken(token) {
		t.Fatal("token lost after restart — persistence regression")
	}

	// 重启后撤销也必须落盘：第三个实例（再次重启）不得复活已撤销 token
	s2.RevokeToken(token)
	s3 := store.NewForTesting(ds)
	if s3.ValidateToken(token) {
		t.Fatal("revoked token resurrected after restart")
	}
}

// TestLockStore_RevokeAllPersistsAcrossRestart 改密码路径（RevokeAllTokens）的持久化
func TestLockStore_RevokeAllPersistsAcrossRestart(t *testing.T) {
	tmpDir := t.TempDir()
	docStoreDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(docStoreDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ds := filestore.New(docStoreDir)

	s1 := store.NewForTesting(ds)
	if err := s1.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}
	token, _ := s1.IssueToken()

	if err := s1.UpdatePassword("admin", "new-pass"); err != nil {
		t.Fatalf("UpdatePassword: %v", err)
	}

	s2 := store.NewForTesting(ds)
	if s2.ValidateToken(token) {
		t.Fatal("token survived password change + restart — revoke-all persistence regression")
	}
}

// TestLockStore_TouchTokenKeepsAlive 验证活连接续期：
// 纯 WS 会话（无 HTTP 流量）期间 TouchToken 持续滑动 LastSeen，
// token 不会因 TTL 静默过期（过期会连带强制断开 WS，表现为功能突然失效）
func TestLockStore_TouchTokenKeepsAlive(t *testing.T) {
	s := setupTestLockStore(t)
	store.SetTokenTTLForTesting(s, 60*time.Millisecond)
	defer store.SetTokenTTLForTesting(s, 0)

	token, err := s.IssueToken()
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	// 每 30ms touch 一次（模拟 WS 续期循环），持续 150ms（> 2 个 TTL 周期）
	deadline := time.Now().Add(150 * time.Millisecond)
	for time.Now().Before(deadline) {
		time.Sleep(30 * time.Millisecond)
		s.TouchToken(token)
	}

	if !s.ValidateToken(token) {
		t.Fatal("token expired despite periodic touch — touch regression")
	}

	// 停止 touch 后过期：ValidateToken 应拒绝并清理
	store.SetTokenTTLForTesting(s, 20*time.Millisecond)
	time.Sleep(40 * time.Millisecond)
	if s.ValidateToken(token) {
		t.Fatal("token should expire after touch stops")
	}
}

// TestLockStore_TouchTokenNoRevive 验证 TouchToken 不复活已失效 token
func TestLockStore_TouchTokenNoRevive(t *testing.T) {
	s := setupTestLockStore(t)

	if err := s.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}
	token, _ := s.IssueToken()
	s.RevokeToken(token)

	s.TouchToken(token)
	if s.ValidateToken(token) {
		t.Fatal("TouchToken revived a revoked token")
	}

	// 未知 token 同样静默
	s.TouchToken("")
	s.TouchToken("scl_unknown")
}

// TestLockStore_IsDefaultPassword_SurvivesSameValueResave：bcrypt 每次加盐，
// admin→admin 同值回写（e2e 密码用例的清理路径）后存储哈希必然改变——
// 旧实现与出厂哈希常量做字符串等值，会把仍为默认密码的实例永久误报为非默认
func TestLockStore_IsDefaultPassword_SurvivesSameValueResave(t *testing.T) {
	s := setupTestLockStore(t)

	if err := s.InitDefault(); err != nil {
		t.Fatalf("InitDefault: %v", err)
	}
	if !s.IsDefaultPassword() {
		t.Fatal("InitDefault 后应报告默认密码")
	}

	if err := s.UpdatePassword("admin", "admin"); err != nil {
		t.Fatalf("UpdatePassword(admin→admin): %v", err)
	}
	if !s.IsDefaultPassword() {
		t.Fatal("同值回写后 IsDefaultPassword 误报非默认密码")
	}

	if err := s.UpdatePassword("admin", "changed-pass"); err != nil {
		t.Fatalf("UpdatePassword(admin→changed): %v", err)
	}
	if s.IsDefaultPassword() {
		t.Fatal("真改密码后 IsDefaultPassword 仍报告默认密码")
	}
	if !s.VerifyPassword("changed-pass") {
		t.Fatal("改密后新密码应可验证")
	}
}
