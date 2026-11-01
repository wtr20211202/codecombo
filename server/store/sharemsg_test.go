package store_test

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 分享访客留言附表（P-20261006-13）store 层纪律锁：追加/排序/上限裁剪/
// 单删清空/级联删除/轮换迁键/孤儿对账/死链拒写——生命周期与分享一体是
// 本附表的第一语义，每条用例都锚在「随分享消亡」或「跟记录走」上

func newShareStoresForTest(t *testing.T) (*store.Store, store.ShareStore, store.ShareMessageStore) {
	t.Helper()
	s := store.New(filestore.New(t.TempDir()))
	return s, s.Share, s.ShareMsg
}

func mustCreateFileShare(t *testing.T, shares store.ShareStore, tokenSeed string) *store.Share {
	t.Helper()
	created, err := shares.Create(store.Share{
		Kind: store.ShareKindFile, ProjectID: "p1", Path: tokenSeed,
		Name: tokenSeed, ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("create share: %v", err)
	}
	return created
}

func TestShareMsgAddListOrder(t *testing.T) {
	_, shares, msgs := newShareStoresForTest(t)
	sh := mustCreateFileShare(t, shares, "docs/a.md")

	if _, err := msgs.Add(sh.Token, "alice", "第一条", time.Now()); err != nil {
		t.Fatalf("add #1: %v", err)
	}
	if _, err := msgs.Add(sh.Token, "", "第二条", time.Now().Add(time.Second)); err != nil {
		t.Fatalf("add #2: %v", err)
	}
	list, err := msgs.List(sh.Token, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("list len = %d, want 2", len(list))
	}
	// 新到旧：后写的在前；匿名（后写）昵称为空，先写带昵称
	if list[0].Text != "第二条" || list[1].Text != "第一条" {
		t.Fatalf("list order wrong: %q then %q", list[0].Text, list[1].Text)
	}
	if list[0].Nickname != "" {
		t.Fatalf("anonymous nickname should be empty, got %q", list[0].Nickname)
	}
	if list[1].Nickname != "alice" {
		t.Fatalf("first message nickname = %q, want alice", list[1].Nickname)
	}
	if list[0].Token != sh.Token {
		t.Fatalf("message token = %q, want %q", list[0].Token, sh.Token)
	}
	// 计数投影跟随写入
	cur, _ := shares.Get(sh.Token)
	if cur.MessageCount != 2 {
		t.Fatalf("MessageCount = %d, want 2", cur.MessageCount)
	}
}

func TestShareMsgTokenCap(t *testing.T) {
	_, shares, msgs := newShareStoresForTest(t)
	sh := mustCreateFileShare(t, shares, "docs/cap.md")

	for i := 0; i < store.ShareMsgMaxPerToken+7; i++ {
		if _, err := msgs.Add(sh.Token, "n", "msg", time.Now()); err != nil {
			t.Fatalf("add #%d: %v", i, err)
		}
	}
	list, _ := msgs.List(sh.Token, 0)
	if len(list) != store.ShareMsgMaxPerToken {
		t.Fatalf("kept = %d, want cap %d", len(list), store.ShareMsgMaxPerToken)
	}
	cur, _ := shares.Get(sh.Token)
	if cur.MessageCount != store.ShareMsgMaxPerToken {
		t.Fatalf("MessageCount = %d, want cap", cur.MessageCount)
	}
	// 裁剪逐最旧：现存的最老一条应是第 8 次写入之后的时间线（无 FromNow
	// 断言手段，用「最早与最晚 id 时序递增」锁定保新弃旧的方向）
	for i := 1; i < len(list); i++ {
		if list[i-1].CreatedAt.Before(list[i].CreatedAt) {
			t.Fatalf("list not newest-first at %d", i)
		}
	}
}

func TestShareMsgDeleteAndClear(t *testing.T) {
	_, shares, msgs := newShareStoresForTest(t)
	sh := mustCreateFileShare(t, shares, "docs/del.md")

	m1, _ := msgs.Add(sh.Token, "a", "one", time.Now())
	if _, err := msgs.Add(sh.Token, "b", "two", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := msgs.Delete(sh.Token, m1.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := msgs.Delete(sh.Token, "nope"); err == nil {
		t.Fatal("delete unknown id should fail")
	}
	cur, _ := shares.Get(sh.Token)
	if cur.MessageCount != 1 {
		t.Fatalf("MessageCount after delete = %d, want 1", cur.MessageCount)
	}
	removed, err := msgs.Clear(sh.Token)
	if err != nil || removed != 1 {
		t.Fatalf("clear: removed=%d err=%v", removed, err)
	}
	list, _ := msgs.List(sh.Token, 0)
	if len(list) != 0 {
		t.Fatalf("list after clear = %d, want 0", len(list))
	}
	cur, _ = shares.Get(sh.Token)
	if cur.MessageCount != 0 {
		t.Fatalf("MessageCount after clear = %d, want 0", cur.MessageCount)
	}
}

func TestShareMsgCascadeOnRevokeAndExpiry(t *testing.T) {
	_, shares, msgs := newShareStoresForTest(t)
	sh := mustCreateFileShare(t, shares, "docs/gone.md")
	if _, err := msgs.Add(sh.Token, "a", "will die with the share", time.Now()); err != nil {
		t.Fatal(err)
	}

	// 撤销即级联：短链删除，附表不留尸
	if err := shares.Delete(sh.Token); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	list, _ := msgs.List(sh.Token, 0)
	if len(list) != 0 {
		t.Fatalf("messages survived revoke: %d", len(list))
	}

	// 过期清账同样级联（CleanupExpired 管线）：创建 → 留言 → SetExpiry 到
	// 过去时点（幂等 Create 不刷新倒计时，显式调整才落库）→ 巡检清账
	sh2 := mustCreateFileShare(t, shares, "docs/expired.md")
	if _, err := msgs.Add(sh2.Token, "a", "expired carrier", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := shares.SetExpiry(sh2.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatalf("expire share: %v", err)
	}
	n, err := shares.CleanupExpired(time.Now())
	if err != nil || n != 1 {
		t.Fatalf("cleanup expired: n=%d err=%v", n, err)
	}
	if _, err := msgs.List(sh2.Token, 0); err == nil {
		t.Fatal("list after expiry cleanup should fail (share gone)")
	}
}

func TestShareMsgRotateMigrates(t *testing.T) {
	_, shares, msgs := newShareStoresForTest(t)
	sh := mustCreateFileShare(t, shares, "docs/rot.md")
	if _, err := msgs.Add(sh.Token, "a", "follows the link", time.Now()); err != nil {
		t.Fatal(err)
	}

	rotated, err := shares.Rotate(sh.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.Token == sh.Token {
		t.Fatal("rotate should change token")
	}
	list, err := msgs.List(rotated.Token, 0)
	if err != nil || len(list) != 1 || list[0].Text != "follows the link" {
		t.Fatalf("messages did not migrate: len=%d err=%v", len(list), err)
	}
	if list[0].Token != rotated.Token {
		t.Fatalf("migrated message token = %q, want %q", list[0].Token, rotated.Token)
	}
	old, _ := msgs.List(sh.Token, 0)
	if len(old) != 0 {
		t.Fatalf("old token still has messages: %d", len(old))
	}
}

func TestShareMsgGCOrphans(t *testing.T) {
	fs := filestore.New(t.TempDir())
	st := store.New(fs)
	shares, msgs := st.Share, st.ShareMsg
	sh := mustCreateFileShare(t, shares, "docs/live.md")
	if _, err := msgs.Add(sh.Token, "a", "alive", time.Now()); err != nil {
		t.Fatal(err)
	}
	// 伪造孤儿：分享记录不存在 + 创建时点超过宽限期（SeedShareMessageForTest
	// 绕过 Add 的存活校验与时钟，构造「分享键已消亡、留言残留」的崩溃窗口态）
	orphan := &store.ShareMessage{ID: "orphan-id-1", Token: "orphan0000000000",
		Text: "leftover", CreatedAt: time.Now().Add(-2 * time.Hour)}
	if err := store.SeedShareMessageForTest(fs, orphan); err != nil {
		t.Fatalf("seed orphan: %v", err)
	}
	// 宽限期内的新孤儿：不清算（防误删在途轮换中间态）
	fresh := &store.ShareMessage{ID: "fresh-id-1", Token: "orphan0000000001",
		Text: "in flight", CreatedAt: time.Now()}
	if err := store.SeedShareMessageForTest(fs, fresh); err != nil {
		t.Fatalf("seed fresh orphan: %v", err)
	}

	isLive := func(token string) bool {
		s, err := shares.Get(token)
		return err == nil && !s.Expired(time.Now())
	}
	removed, err := msgs.GCOrphans(isLive, time.Now())
	if err != nil {
		t.Fatalf("gc: %v", err)
	}
	if removed != 1 {
		t.Fatalf("gc removed = %d, want 1", removed)
	}
	if list, _ := msgs.List(sh.Token, 0); len(list) != 1 {
		t.Fatal("live share messages must survive gc")
	}
	// 宽限期内的孤儿不清算：第二轮 gc 应零删除（fresh 留观）
	if removed, err := msgs.GCOrphans(isLive, time.Now()); err != nil || removed != 0 {
		t.Fatalf("second gc should be no-op: removed=%d err=%v", removed, err)
	}
}

func TestShareMsgDeadShareRejected(t *testing.T) {
	_, shares, msgs := newShareStoresForTest(t)
	// 未知 token：写/读/删/清一律 ErrNotFound（不借尸还魂）
	dead := "deadtoken00000000"
	if _, err := msgs.Add(dead, "a", "x", time.Now()); err == nil {
		t.Fatal("add to unknown token should fail")
	}
	if _, err := msgs.List(dead, 0); err == nil {
		t.Fatal("list unknown token should fail")
	}
	if err := msgs.Delete(dead, "x"); err == nil {
		t.Fatal("delete unknown token should fail")
	}
	if _, err := msgs.Clear(dead); err == nil {
		t.Fatal("clear unknown token should fail")
	}

	// 已过期未及清账的记录：同拒（与访客面 lookup 惰性删除同口径）。
	// SetExpiry 到过去时点（幂等 Create 不刷新倒计时，显式调整才落库）
	sh := mustCreateFileShare(t, shares, "docs/dead.md")
	if _, err := shares.SetExpiry(sh.Token, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := msgs.Add(sh.Token, "a", "x", time.Now()); err == nil {
		t.Fatal("add to expired share should fail")
	}
}
