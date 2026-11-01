package store_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

func newShareStoreForTest(t *testing.T) store.ShareStore {
	t.Helper()
	return store.New(filestore.New(t.TempDir())).Share
}

func TestDeriveShareTokenStableAndDistinct(t *testing.T) {
	pepper := []byte("unit-test-pepper")

	// 跨版本稳定金标：gen=0 派生逐字节固定——存量落库记录的 token 由此保证
	// 永远可解析（改派生 = 全部存量短链失效，禁止）
	if got, want := store.DeriveShareToken([]byte("golden-pepper"), "p1", "docs/readme.md", 0), "2315s8zyxrj82squ"; got != want {
		t.Fatalf("gen-0 derivation drifted across versions: got %s, want %s", got, want)
	}

	// 同一 (project, path) 反复派生 → 短链不变
	a1 := store.DeriveShareToken(pepper, "p1", "docs/readme.md", 0)
	a2 := store.DeriveShareToken(pepper, "p1", "docs/readme.md", 0)
	if a1 != a2 {
		t.Fatalf("same input produced different tokens: %s vs %s", a1, a2)
	}

	if len(a1) != 16 {
		t.Fatalf("token length = %d, want 16", len(a1))
	}
	for _, c := range a1 {
		if !strings.ContainsRune("0123456789abcdefghijklmnopqrstuvwxyz", c) {
			t.Fatalf("token contains non-base36 char %q", c)
		}
	}

	// 不同项目/不同层级的同名文件 → 短链互不相同（同名隔离）
	cases := [][2]string{
		{"p1", "docs/readme.md"},
		{"p2", "docs/readme.md"},
		{"p1", "other/readme.md"},
		{"p1", ""},
	}
	seen := map[string]string{}
	for _, c := range cases {
		tok := store.DeriveShareToken(pepper, c[0], c[1], 0)
		if prev, dup := seen[tok]; dup {
			t.Fatalf("token collision between %v and %v", prev, c)
		}
		seen[tok] = c[0] + "|" + c[1]
	}

	// 换 pepper → 全部变化（token 不可脱离部署密钥预测）
	if store.DeriveShareToken([]byte("other-pepper"), "p1", "docs/readme.md", 0) == a1 {
		t.Fatal("different pepper must derive different token")
	}

	// 轮换代际参与派生：gen≥1 与 gen0、彼此互不相同且确定性重放一致
	g0 := store.DeriveShareToken(pepper, "p1", "docs/readme.md", 0)
	g1 := store.DeriveShareToken(pepper, "p1", "docs/readme.md", 1)
	g2 := store.DeriveShareToken(pepper, "p1", "docs/readme.md", 2)
	if g1 == g0 || g2 == g0 || g1 == g2 {
		t.Fatalf("rotated generations must derive distinct tokens: %s %s %s", g0, g1, g2)
	}
	if g1 != store.DeriveShareToken(pepper, "p1", "docs/readme.md", 1) {
		t.Fatal("rotated derivation must stay deterministic")
	}
}

func TestShareStoreIdempotentCreate(t *testing.T) {
	st := newShareStoreForTest(t)

	first, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "a/b.txt", Name: "b.txt", Size: 10})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	again, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "a\\b.txt", Name: "b.txt", Size: 99})
	if err != nil {
		t.Fatalf("recreate with backslash path: %v", err)
	}
	if first.Token != again.Token {
		t.Fatalf("idempotent create changed token: %s vs %s", first.Token, again.Token)
	}
	if !again.CreatedAt.Equal(first.CreatedAt) {
		t.Fatal("idempotent create must keep original CreatedAt")
	}
	if again.Size != 99 {
		t.Fatalf("idempotent create should refresh size snapshot, got %d", again.Size)
	}

	list, err := st.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list length = %d, want 1", len(list))
	}
	if list[0].Path != "a/b.txt" {
		t.Fatalf("path not normalized: %q", list[0].Path)
	}
}

func TestShareStoreGetDelete(t *testing.T) {
	st := newShareStoreForTest(t)
	s, err := st.Create(store.Share{ProjectID: "p1", Name: "docs", Path: "docs", IsDir: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := st.Get(s.Token)
	if err != nil || got.Path != "docs" || !got.IsDir {
		t.Fatalf("get: %v %+v", err, got)
	}

	if _, err := st.Get("nonexistent-token"); err != store.ErrNotFound {
		t.Fatalf("get unknown token err = %v, want ErrNotFound", err)
	}

	if err := st.Delete(s.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := st.Get(s.Token); err != store.ErrNotFound {
		t.Fatal("share should be gone after delete")
	}
}

// TestShareStoreRotate 文件分享轮换（P-20261002-72）：代际 +1 迁键——旧
// token 立即失效、新 token 即刻可用、元数据保留；幂等创建固定返回当前代际
// 链（不复活旧链、不产生重复记录）；可连续轮换；撤销/未知 token 拒绝
func TestShareStoreRotate(t *testing.T) {
	st := newShareStoreForTest(t)

	first, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "a/b.txt", Name: "b.txt", Size: 10})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	rotated, err := st.Rotate(first.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.Token == first.Token {
		t.Fatal("rotate must derive a new token")
	}
	if rotated.Path != "a/b.txt" || rotated.Name != "b.txt" || !rotated.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("rotate must keep metadata: %+v (old %+v)", rotated, first)
	}
	if !rotated.ExpiresAt.IsZero() {
		t.Fatal("file share must stay non-expiring after rotate")
	}

	// 旧 token 立即失效，新 token 可取
	if _, err := st.Get(first.Token); err != store.ErrNotFound {
		t.Fatal("old token must be gone immediately after rotate")
	}
	if _, err := st.Get(rotated.Token); err != nil {
		t.Fatalf("new token must resolve: %v", err)
	}

	// 幂等创建跟随当前代际：同目标再分享拿到轮换后的链，列表不出现重复记录
	again, err := st.Create(store.Share{ProjectID: "p1", Path: "a/b.txt", Name: "b.txt", Size: 12})
	if err != nil {
		t.Fatalf("recreate after rotate: %v", err)
	}
	if again.Token != rotated.Token {
		t.Fatalf("recreate must return the rotated token %s, got %s", rotated.Token, again.Token)
	}
	if again.Size != 12 {
		t.Fatalf("recreate should refresh size snapshot, got %d", again.Size)
	}
	list, err := st.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("list len = %d (err %v), want exactly 1", len(list), err)
	}

	// 可连续轮换：每代都拿到新链、上一代即时失效
	second, err := st.Rotate(rotated.Token)
	if err != nil {
		t.Fatalf("rotate again: %v", err)
	}
	if second.Token == rotated.Token || second.Token == first.Token {
		t.Fatalf("second rotate must derive another new token: %s", second.Token)
	}
	if _, err := st.Get(rotated.Token); err != store.ErrNotFound {
		t.Fatal("previous generation must be gone after re-rotate")
	}

	// 撤销后轮换 → ErrNotFound；未知 token 同拒
	if err := st.Delete(second.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := st.Rotate(second.Token); err != store.ErrNotFound {
		t.Fatalf("rotate after revoke err = %v, want ErrNotFound", err)
	}
	if _, err := st.Rotate("zzzzzzzzzzzzzzzz"); err != store.ErrNotFound {
		t.Fatalf("rotate unknown err = %v, want ErrNotFound", err)
	}
}

// TestShareStoreRotateSnippet 片段轮换：与文件同构的迁键语义 + ExpiresAt
// 不续期（倒计时是安全边界，轮换不得成为续期通道）；轮换后同内容幂等创建
// 跟随当前代际；撤销/过期残留拒绝轮换
func TestShareStoreRotateSnippet(t *testing.T) {
	st := newShareStoreForTest(t)

	s, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Name: "报错", Content: "panic: boom"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	rotated, err := st.Rotate(s.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.Token == s.Token {
		t.Fatal("snippet rotate must derive a new token")
	}
	if !rotated.ExpiresAt.Equal(s.ExpiresAt) {
		t.Fatalf("rotate must not extend snippet expiry: %v (old %v)", rotated.ExpiresAt, s.ExpiresAt)
	}
	if rotated.Content != "panic: boom" || rotated.Size != int64(len("panic: boom")) {
		t.Fatalf("rotate must keep content: %+v", rotated)
	}

	// 轮换后同内容再分享 → 当前代际链（不复活旧链），CreatedAt/ExpiresAt 不变
	again, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "panic: boom"})
	if err != nil {
		t.Fatalf("recreate after rotate: %v", err)
	}
	if again.Token != rotated.Token {
		t.Fatalf("recreate must follow rotated token %s, got %s", rotated.Token, again.Token)
	}
	if !again.CreatedAt.Equal(s.CreatedAt) || !again.ExpiresAt.Equal(s.ExpiresAt) {
		t.Fatal("recreate after rotate must keep original CreatedAt/ExpiresAt")
	}

	// 已撤销 → ErrNotFound；已过期未及清理的残留同拒
	if err := st.Delete(rotated.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := st.Rotate(rotated.Token); err != store.ErrNotFound {
		t.Fatalf("rotate after revoke err = %v, want ErrNotFound", err)
	}
	stale, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "stale-body", ExpiresAt: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatalf("create stale: %v", err)
	}
	if _, err := st.Rotate(stale.Token); err != store.ErrNotFound {
		t.Fatalf("rotate expired err = %v, want ErrNotFound", err)
	}
}

func TestShareStoreSnippetLifecycle(t *testing.T) {
	st := newShareStoreForTest(t)

	// 创建：不绑项目（projectId/path 清空）、大小=内容字节、过期≈now+24h
	before := time.Now()
	s, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Name: "报错输出", Content: "panic: boom\n  at main()"})
	if err != nil {
		t.Fatalf("create snippet: %v", err)
	}
	if s.Kind != store.ShareKindSnippet || s.ProjectID != "" || s.Path != "" || s.IsDir {
		t.Fatalf("snippet fields not normalized: %+v", s)
	}
	if s.Size != int64(len(s.Content)) {
		t.Fatalf("size = %d, want content bytes %d", s.Size, len(s.Content))
	}
	if s.ExpiresAt.IsZero() || s.ExpiresAt.Sub(before) > store.SnippetTTL+time.Minute {
		t.Fatalf("expiresAt not ~now+24h: %v", s.ExpiresAt)
	}
	if !s.Expired(s.ExpiresAt.Add(time.Second)) || s.Expired(before) {
		t.Fatal("Expired predicate inconsistent with ExpiresAt")
	}

	// 幂等：同内容重复分享 → 同一 token，且保留原 CreatedAt/ExpiresAt（不续期）
	again, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Name: "换个标题", Content: "panic: boom\n  at main()"})
	if err != nil {
		t.Fatalf("recreate snippet: %v", err)
	}
	if again.Token != s.Token {
		t.Fatalf("same content must derive same token: %s vs %s", s.Token, again.Token)
	}
	if !again.CreatedAt.Equal(s.CreatedAt) || !again.ExpiresAt.Equal(s.ExpiresAt) {
		t.Fatalf("idempotent recreate must keep CreatedAt/ExpiresAt: %+v vs %+v", s, again)
	}
	if again.Name != "报错输出" {
		t.Fatal("get-or-create must return the existing stored record")
	}

	// 过期残留重建：同内容再分享且旧记录已过期（未及清理）→ 删旧重建新周期，
	// 绝不返回已失效的旧记录
	stale, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "stale-body", ExpiresAt: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatalf("create stale snippet: %v", err)
	}
	revived, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "stale-body"})
	if err != nil {
		t.Fatalf("recreate expired snippet: %v", err)
	}
	if revived.Token != stale.Token {
		t.Fatal("same content derives the same token even after expiry")
	}
	if revived.Expired(time.Now()) || !revived.ExpiresAt.After(stale.ExpiresAt) {
		t.Fatalf("recreate must start a fresh TTL window: %+v (old %+v)", revived, stale)
	}

	// 不同内容 → 不同 token（同名隔离的内容版）
	other, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "different content"})
	if err != nil || other.Token == s.Token {
		t.Fatalf("different content must derive different token: %v %s", err, other.Token)
	}

	// 上限：32KB 恰好可过，超 1 字节拒绝；空内容拒绝
	exact := strings.Repeat("a", store.MaxSnippetBytes)
	if _, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: exact}); err != nil {
		t.Fatalf("content exactly at limit must pass: %v", err)
	}
	if _, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: exact + "x"}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("content over limit err = %v, want ErrInvalidArg", err)
	}
	if _, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: ""}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("empty content err = %v, want ErrInvalidArg", err)
	}

	// file 形态不受影响：缺省 kind 落为 file，且与 snippet token 空间隔离
	f, err := st.Create(store.Share{ProjectID: "p1", Path: "a.txt", Name: "a.txt", Size: 1})
	if err != nil {
		t.Fatalf("create file share: %v", err)
	}
	if f.Kind != store.ShareKindFile || f.ExpiresAt != (time.Time{}) {
		t.Fatalf("file share must stay non-expiring file kind: %+v", f)
	}
	if f.Token == s.Token || f.Token == other.Token {
		t.Fatal("file token must not collide with snippet token space")
	}
}

func TestShareStoreCleanupExpired(t *testing.T) {
	st := newShareStoreForTest(t)

	expired, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "stale", ExpiresAt: time.Now().Add(-time.Hour)})
	if err != nil {
		t.Fatalf("create expired snippet: %v", err)
	}
	live, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "fresh"})
	if err != nil {
		t.Fatalf("create live snippet: %v", err)
	}
	file, err := st.Create(store.Share{ProjectID: "p1", Path: "keep.txt", Name: "keep.txt"})
	if err != nil {
		t.Fatalf("create file share: %v", err)
	}

	// 恰好等于过期时点也算过期（边界含端点）
	n, err := st.CleanupExpired(time.Now())
	if err != nil || n != 1 {
		t.Fatalf("cleanup removed = %d, err = %v, want 1", n, err)
	}
	if _, err := st.Get(expired.Token); err != store.ErrNotFound {
		t.Fatal("expired snippet should be gone")
	}
	if _, err := st.Get(live.Token); err != nil {
		t.Fatalf("live snippet must survive: %v", err)
	}
	if _, err := st.Get(file.Token); err != nil {
		t.Fatalf("file share must survive cleanup: %v", err)
	}

	// 幂等：再清一轮无事可做
	if n, err := st.CleanupExpired(time.Now()); err != nil || n != 0 {
		t.Fatalf("second cleanup removed = %d, err = %v, want 0", n, err)
	}
}

// TestShareStoreFileTTL 文件/目录分享的 opt-in TTL（P-20261003-29）：过期
// 判定与 snippet 同一 Expired 谓词；到期记录同走 CleanupExpired；默认永久
// 路径零变化（A2 决策不变）；SetExpiry 显式设定/恢复永久、snippet 拒绝、
// 未知/已过期拒绝；幂等重建不刷新有效期
func TestShareStoreFileTTL(t *testing.T) {
	st := newShareStoreForTest(t)

	// 默认创建：零值 ExpiresAt = 永久，Expired 恒 false（A2 默认语义不变）
	perm, err := st.Create(store.Share{ProjectID: "p1", Path: "forever.txt", Name: "forever.txt", Size: 1})
	if err != nil {
		t.Fatalf("create permanent: %v", err)
	}
	if perm.ExpiresAt != (time.Time{}) || perm.Expired(time.Now().AddDate(10, 0, 0)) {
		t.Fatalf("default share must stay permanent: %+v", perm)
	}

	// SetExpiry 设定 1 天窗口：Expired 判定随窗口翻转，其余字段原样
	expiry := time.Now().Add(24 * time.Hour)
	ttl, err := st.SetExpiry(perm.Token, expiry)
	if err != nil {
		t.Fatalf("set expiry: %v", err)
	}
	if !ttl.ExpiresAt.Equal(expiry) {
		t.Fatalf("expiresAt = %v, want %v", ttl.ExpiresAt, expiry)
	}
	if ttl.Token != perm.Token || !ttl.CreatedAt.Equal(perm.CreatedAt) || ttl.Size != perm.Size {
		t.Fatalf("set expiry must keep identity/metadata: %+v (old %+v)", ttl, perm)
	}
	if ttl.Expired(time.Now()) || !ttl.Expired(expiry.Add(time.Second)) {
		t.Fatal("Expired predicate inconsistent with opt-in window")
	}

	// 幂等重建不刷新有效期：同目标重复分享保留 TTL（倒计时安全边界，
	// 不得被重复分享暗中续成永久）
	again, err := st.Create(store.Share{ProjectID: "p1", Path: "forever.txt", Name: "forever.txt", Size: 2})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if !again.ExpiresAt.Equal(expiry) {
		t.Fatalf("idempotent recreate must keep opt-in TTL: %v (want %v)", again.ExpiresAt, expiry)
	}

	// 恢复永久：零值 SetExpiry 清窗，Expired 恒 false（回到 A2 默认）
	back, err := st.SetExpiry(perm.Token, time.Time{})
	if err != nil {
		t.Fatalf("clear expiry: %v", err)
	}
	if !back.ExpiresAt.IsZero() || back.Expired(time.Now().AddDate(10, 0, 0)) {
		t.Fatalf("zero SetExpiry must restore permanent: %+v", back)
	}

	// 到期文件分享同走 CleanupExpired（与 snippet 同管线）
	ttl2, err := st.SetExpiry(perm.Token, time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatalf("set past expiry: %v", err)
	}
	keep, err := st.Create(store.Share{ProjectID: "p1", Path: "other.txt", Name: "other.txt"})
	if err != nil {
		t.Fatalf("create keeper: %v", err)
	}
	n, err := st.CleanupExpired(time.Now())
	if err != nil || n != 1 {
		t.Fatalf("cleanup removed = %d, err = %v, want 1", n, err)
	}
	if _, err := st.Get(ttl2.Token); err != store.ErrNotFound {
		t.Fatal("expired file share should be swept by CleanupExpired")
	}
	if _, err := st.Get(keep.Token); err != nil {
		t.Fatalf("permanent file share must survive cleanup: %v", err)
	}

	// snippet 拒绝调整（24h 倒计时是固定安全边界）；未知 token 拒绝
	snip, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "fixed-window"})
	if err != nil {
		t.Fatalf("create snippet: %v", err)
	}
	if _, err := st.SetExpiry(snip.Token, time.Now().Add(time.Hour)); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("set snippet expiry err = %v, want ErrInvalidArg", err)
	}
	if _, err := st.SetExpiry("zzzzzzzzzzzzzzzz", time.Now()); err != store.ErrNotFound {
		t.Fatalf("set expiry unknown token err = %v, want ErrNotFound", err)
	}
}

// TestShareStoreRecordHits 访问计数（P-20261002-14）落盘侧：Hits 累加、
// LastAccessAt 随批刷新、旧文档零值兼容（存量记录无字段 → 从 0 起算）、
// 幂等重建保留历史计数、n≤0 防御性 no-op、未知/已撤销拒绝
func TestShareStoreRecordHits(t *testing.T) {
	st := newShareStoreForTest(t)

	s, err := st.Create(store.Share{ProjectID: "p1", Path: "hit.txt", Name: "hit.txt"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if s.Hits != 0 || !s.LastAccessAt.IsZero() {
		t.Fatalf("fresh share must be zero-access: %+v", s)
	}

	// 首批冲刷 +1：Hits 与 LastAccessAt 同批落定
	at1 := time.Now().Add(-2 * time.Hour)
	if err := st.RecordHits(s.Token, 1, at1); err != nil {
		t.Fatalf("record hits: %v", err)
	}
	got, err := st.Get(s.Token)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Hits != 1 {
		t.Fatalf("hits = %d, want 1", got.Hits)
	}
	if !got.LastAccessAt.Equal(at1) {
		t.Fatalf("lastAccessAt = %v, want %v", got.LastAccessAt, at1)
	}

	// 旧文档零值兼容：手工落一份没有 hits/lastAccessAt 字段的存量形态
	// JSON（字段缺失 → 反序列化零值），RecordHits 从 0 起算不报错
	legacyDir := t.TempDir()
	legacyStore := store.New(filestore.New(legacyDir)).Share
	legacyToken := "legacytoken000000"
	legacyJSON := `{"token":"` + legacyToken + `","projectId":"p1","path":"old.txt","name":"old.txt","createdAt":"2025-01-01T00:00:00Z"}`
	if err := os.MkdirAll(filepath.Join(legacyDir, "data", "shares"), 0o755); err != nil {
		t.Fatalf("mkdir shares kind dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(legacyDir, "data", "shares", legacyToken+".json"), []byte(legacyJSON), 0o644); err != nil {
		t.Fatalf("seed legacy doc: %v", err)
	}
	legacyGot, err := legacyStore.Get(legacyToken)
	if err != nil {
		t.Fatalf("read legacy doc: %v", err)
	}
	if legacyGot.Hits != 0 || !legacyGot.LastAccessAt.IsZero() {
		t.Fatalf("legacy doc must deserialize zero-access: %+v", legacyGot)
	}
	at0 := time.Now().Add(-time.Minute)
	if err := legacyStore.RecordHits(legacyToken, 5, at0); err != nil {
		t.Fatalf("record hits on legacy doc: %v", err)
	}
	legacyGot, err = legacyStore.Get(legacyToken)
	if err != nil {
		t.Fatalf("reread legacy doc: %v", err)
	}
	if legacyGot.Hits != 5 || !legacyGot.LastAccessAt.Equal(at0) {
		t.Fatalf("legacy doc after record = hits %d at %v, want 5 at %v", legacyGot.Hits, legacyGot.LastAccessAt, at0)
	}

	// 多批累加：1 + 2 = 3，LastAccessAt 取最新批
	at2 := time.Now()
	if err := st.RecordHits(s.Token, 2, at2); err != nil {
		t.Fatalf("record hits batch 2: %v", err)
	}
	got, err = st.Get(s.Token)
	if err != nil {
		t.Fatalf("get after batch 2: %v", err)
	}
	if got.Hits != 3 {
		t.Fatalf("hits = %d, want 3", got.Hits)
	}
	if !got.LastAccessAt.Equal(at2) {
		t.Fatalf("lastAccessAt = %v, want latest batch %v", got.LastAccessAt, at2)
	}

	// 幂等重建保留历史计数（短链恒定语义：重复分享不把暴露量清零）
	again, err := st.Create(store.Share{ProjectID: "p1", Path: "hit.txt", Name: "hit-renamed.txt", Size: 9})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if again.Token != s.Token || again.Hits != 3 || !again.LastAccessAt.Equal(at2) {
		t.Fatalf("idempotent recreate must keep access stats: %+v", again)
	}

	// 防御：n ≤ 0 no-op；未知 token → ErrNotFound
	if err := st.RecordHits(s.Token, 0, time.Now()); err != nil {
		t.Fatalf("zero-count must be no-op, got %v", err)
	}
	if err := st.RecordHits(s.Token, -1, time.Now()); err != nil {
		t.Fatalf("negative-count must be no-op, got %v", err)
	}
	if err := st.RecordHits("zzzzzzzzzzzzzzzz", 1, time.Now()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token err = %v, want ErrNotFound", err)
	}

	// 已撤销：计数拒绝（不给死链记账）
	if err := st.Delete(s.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := st.RecordHits(s.Token, 1, time.Now()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked token err = %v, want ErrNotFound", err)
	}
}

// 终端只读直播分享（P-20261003-306）：默认 TTL 30 分钟 / 幂等同链不续期 /
// 轮换同构 / 过期即 404 / 缺 terminalId 拒绝
func TestShareStoreTerminalLive(t *testing.T) {
	st := newShareStoreForTest(t)

	// 缺 terminalId → ErrInvalidArg
	if _, err := st.Create(store.Share{Kind: store.ShareKindTerminal}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("missing terminalId err = %v, want ErrInvalidArg", err)
	}

	// 创建：默认 30 分钟 TTL，token 按 (terminal 命名空间, 会话 ID) 派生
	s1, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "tmux-sc-abc123", Name: "build 终端"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if s1.Token == "" || len(s1.Token) != 16 {
		t.Fatalf("token = %q, want 16 base36 chars", s1.Token)
	}
	if s1.ProjectID != "" || s1.Path != "" || s1.IsDir {
		t.Fatalf("terminal share must not bind project fs: %+v", s1)
	}
	if remain := time.Until(s1.ExpiresAt); remain < 29*time.Minute || remain > 31*time.Minute {
		t.Fatalf("default ttl = %v, want ~30m", remain)
	}

	// 幂等重建：同一会话同链，倒计时不续期（安全边界）
	s2, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "tmux-sc-abc123"})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if s2.Token != s1.Token {
		t.Fatalf("idempotent create drifted: %s vs %s", s2.Token, s1.Token)
	}
	if !s2.ExpiresAt.Equal(s1.ExpiresAt) {
		t.Fatalf("idempotent create must not refresh expiry")
	}

	// 不同会话 → 不同链（会话隔离）；显式 TTL 超上限被钳到 24h
	s3, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-xyz"})
	if err != nil {
		t.Fatalf("create other session: %v", err)
	}
	if s3.Token == s1.Token {
		t.Fatal("different sessions must derive different tokens")
	}
	s4, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-cap", ExpiresAt: time.Now().Add(48 * time.Hour)})
	if err != nil {
		t.Fatalf("create capped: %v", err)
	}
	if remain := time.Until(s4.ExpiresAt); remain > 24*time.Hour+time.Minute {
		t.Fatalf("ttl not capped to 24h: %v", remain)
	}

	// 轮换同构：新链即刻可用、旧链 404、幂等创建跟随新代际
	rot, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rot.Token == s1.Token {
		t.Fatal("rotate must derive a new token")
	}
	if _, err := st.Get(s1.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("old token after rotate err = %v, want ErrNotFound", err)
	}
	again, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "tmux-sc-abc123"})
	if err != nil {
		t.Fatalf("idempotent after rotate: %v", err)
	}
	if again.Token != rot.Token {
		t.Fatalf("idempotent create must follow current generation: %s vs %s", again.Token, rot.Token)
	}

	// SetExpiry 允许（terminal 非 snippet 固定窗口）；过期即 Get 仍返回但
	// Expired 为真，CleanupExpired 清走
	if _, err := st.SetExpiry(rot.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("set expiry on terminal share: %v", err)
	}
	if n, err := st.CleanupExpired(time.Now()); err != nil || n != 1 { // 仅 rot 过期（s1 已随轮换迁键删除；s3/s4 存活）
		t.Fatalf("cleanup = %d, %v; want 2 expired removed", n, err)
	}
	if _, err := st.Get(rot.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired token after cleanup err = %v, want ErrNotFound", err)
	}
}

// TestShareStoreTermFrozen 终端输出冻结分享（P-20261005-205）的 store 语义：
// 键 = 会话 ID + 内容哈希（同段输出恒同链）、默认 30 天 TTL、不绑项目、
// 轮换同构、SetExpiry 可调、过期清理同管线
func TestShareStoreTermFrozen(t *testing.T) {
	st := newShareStoreForTest(t)

	// 缺 terminalId / contentHash → ErrInvalidArg
	if _, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, ContentHash: "ab"}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("missing terminalId err = %v, want ErrInvalidArg", err)
	}
	if _, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "s1"}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("missing contentHash err = %v, want ErrInvalidArg", err)
	}

	// 创建：默认 ~30 天 TTL，不绑项目文件系统
	s1, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-a", ContentHash: "hash-1", Name: "build 终端"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if s1.Token == "" || len(s1.Token) != 16 {
		t.Fatalf("token = %q, want 16 base36 chars", s1.Token)
	}
	if s1.ProjectID != "" || s1.Path != "" || s1.IsDir || s1.Frozen {
		t.Fatalf("term-frozen must not bind project fs: %+v", s1)
	}
	if remain := time.Until(s1.ExpiresAt); remain < 29*24*time.Hour || remain > 31*24*time.Hour {
		t.Fatalf("default ttl = %v, want ~30d", remain)
	}

	// 幂等重建：同 (TerminalID, ContentHash) 同链，倒计时不续期
	s2, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-a", ContentHash: "hash-1"})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if s2.Token != s1.Token {
		t.Fatalf("idempotent create drifted: %s vs %s", s2.Token, s1.Token)
	}
	if !s2.ExpiresAt.Equal(s1.ExpiresAt) {
		t.Fatalf("idempotent create must not refresh expiry")
	}

	// 同会话不同输出（哈希不同）→ 不同链；与直播形态命名空间物理隔离
	s3, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-a", ContentHash: "hash-2"})
	if err != nil {
		t.Fatalf("create other content: %v", err)
	}
	if s3.Token == s1.Token {
		t.Fatal("different content hashes must derive different tokens")
	}
	live, err := st.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-a"})
	if err != nil {
		t.Fatalf("create live: %v", err)
	}
	if live.Token == s1.Token || live.Token == s3.Token {
		t.Fatal("live and term-frozen namespaces must not collide")
	}

	// 轮换同构：新链即刻可用、旧链 404、幂等创建跟随新代际（快照目录锚零代际值）
	rot, err := st.Rotate(s1.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rot.Token == s1.Token {
		t.Fatal("rotate must derive a new token")
	}
	if _, err := st.Get(s1.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("old token after rotate err = %v, want ErrNotFound", err)
	}
	if again := st_rotateProbe(t, st, "term-a", "hash-1"); again != rot.Token {
		t.Fatalf("idempotent after rotate = %s, want current generation %s", again, rot.Token)
	}

	// SetExpiry 允许（非 snippet 固定窗口）；过期清理同管线
	if _, err := st.SetExpiry(rot.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("set expiry on term-frozen: %v", err)
	}
	if _, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-b", ContentHash: "h"}); err != nil {
		t.Fatalf("create term-b: %v", err)
	}
	// 过期记录未及清理时重复定格：删旧重建（新时钟周期，落回零代际 token），
	// 不给过期快照借尸还魂
	reborn, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-a", ContentHash: "hash-1"})
	if err != nil {
		t.Fatalf("recreate after expiry: %v", err)
	}
	if reborn.Token != s1.Token {
		t.Fatalf("reborn token = %s, want native (zero-gen) %s", reborn.Token, s1.Token)
	}
	if remain := time.Until(reborn.ExpiresAt); remain < 29*24*time.Hour {
		t.Fatalf("reborn ttl = %v, want fresh ~30d", remain)
	}
	// 造一条已过期记录验证清理管线（rot 已随上面的删旧重建消亡）
	sc, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-c", ContentHash: "h"})
	if err != nil {
		t.Fatalf("create term-c: %v", err)
	}
	if _, err := st.SetExpiry(sc.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("expire term-c: %v", err)
	}
	if n, err := st.CleanupExpired(time.Now()); err != nil || n != 1 {
		t.Fatalf("cleanup = %d, %v; want 1 expired removed", n, err)
	}
}

// st_rotateProbe 幂等创建探针（返回当前代际 token；独立 helper 让主流程可读）
func st_rotateProbe(t *testing.T, st store.ShareStore, terminalID, hash string) string {
	t.Helper()
	s, err := st.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: terminalID, ContentHash: hash})
	if err != nil {
		t.Fatalf("rotate probe create: %v", err)
	}
	return s.Token
}

// TestShareStorePassphraseGate 口令门存储面（P-20261006-25）：创建带哈希、
// 幂等重建「不带=保持 / 带新=更换」、SetPassphrase 设置/移除、过期与未知
// token 拒绝（与 SetExpiry/Rotate 同口径）
func TestShareStorePassphraseGate(t *testing.T) {
	st := newShareStoreForTest(t)
	hashA, hashB := "$2a$10$AAAA", "$2a$10$BBBB"

	// 创建带口令哈希：原样落库（store 不接触明文）
	s, err := st.Create(store.Share{Kind: store.ShareKindFile, ProjectID: "p1", Path: "docs", Name: "docs", PassphraseHash: hashA})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got, _ := st.Get(s.Token); got.PassphraseHash != hashA {
		t.Fatalf("stored hash = %q, want %q", got.PassphraseHash, hashA)
	}

	// 幂等重建不带哈希：保持既有口令（重复分享不得暗中拆门）
	again, err := st.Create(store.Share{Kind: store.ShareKindFile, ProjectID: "p1", Path: "docs", Name: "docs"})
	if err != nil || again.Token != s.Token {
		t.Fatalf("idempotent create: %v, %s", err, again.Token)
	}
	if again.PassphraseHash != hashA {
		t.Fatalf("idempotent recreate dropped passphrase: %q", again.PassphraseHash)
	}

	// 幂等重建带新哈希：更换门（访客会话 cookie 绑定哈希，即全体失效）
	changed, err := st.Create(store.Share{Kind: store.ShareKindFile, ProjectID: "p1", Path: "docs", Name: "docs", PassphraseHash: hashB})
	if err != nil || changed.Token != s.Token {
		t.Fatalf("idempotent create with new hash: %v", err)
	}
	if changed.PassphraseHash != hashB {
		t.Fatalf("recreate with new hash not applied: %q", changed.PassphraseHash)
	}

	// SetPassphrase：换门与移除（空串）都是整字段覆写、短链不变
	removed, err := st.SetPassphrase(s.Token, "")
	if err != nil || removed.Token != s.Token || removed.PassphraseHash != "" {
		t.Fatalf("remove passphrase: %v, %+v", err, removed)
	}
	if got, _ := st.Get(s.Token); got.PassphraseHash != "" {
		t.Fatalf("remove not persisted: %q", got.PassphraseHash)
	}
	set, err := st.SetPassphrase(s.Token, hashA)
	if err != nil || set.PassphraseHash != hashA {
		t.Fatalf("set passphrase: %v, %+v", err, set)
	}

	// 未知 token → ErrNotFound
	if _, err := st.SetPassphrase("zzzzzzzzzzzzzzzz", hashA); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token err = %v, want ErrNotFound", err)
	}

	// 已过期 → ErrNotFound（对访客面已死亡，不接受借尸还魂）
	exp, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "exp-body", PassphraseHash: hashA, ExpiresAt: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatalf("create expired: %v", err)
	}
	if _, err := st.SetPassphrase(exp.Token, ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired token err = %v, want ErrNotFound", err)
	}

	// snippet 幂等重建同款语义：不带=保持、带新=更换
	sn, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "snippet-pass", PassphraseHash: hashA})
	if err != nil {
		t.Fatalf("create snippet: %v", err)
	}
	keep, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "snippet-pass"})
	if err != nil || keep.Token != sn.Token || keep.PassphraseHash != hashA {
		t.Fatalf("snippet idempotent must keep passphrase: %v %+v", err, keep)
	}
	renew, err := st.Create(store.Share{Kind: store.ShareKindSnippet, Content: "snippet-pass", PassphraseHash: hashB})
	if err != nil || renew.PassphraseHash != hashB {
		t.Fatalf("snippet idempotent must apply new passphrase: %v %+v", err, renew)
	}
}
