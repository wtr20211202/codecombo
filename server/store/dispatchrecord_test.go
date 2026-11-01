package store_test

import (
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 联邦派发记录（P-20261004-131）──
// 覆盖：Append/List 排序与必填校验、环形上限裁最旧、TTL 惰性剪枝、
// Delete 幂等、CleanupBefore 兜底清理、持久化重启存活。

func newDispatchRecordStoreForTest(t *testing.T) store.DispatchRecordStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).DispatchRecord
}

func TestDispatchRecordAppendListOrderAndValidation(t *testing.T) {
	s := newDispatchRecordStoreForTest(t)
	if err := s.Append(store.DispatchRecord{RemoteSessionID: "term-1"}); err == nil {
		t.Fatal("缺 instanceId 应拒绝")
	}
	if err := s.Append(store.DispatchRecord{InstanceID: "inst-1"}); err == nil {
		t.Fatal("缺 remoteSessionId 应拒绝")
	}
	base := time.Now().Add(-time.Hour)
	for i, sess := range []string{"term-a", "term-b", "term-c"} {
		if err := s.Append(store.DispatchRecord{
			InstanceID:      "inst-1",
			RemoteSessionID: sess,
			At:              base.Add(time.Duration(i) * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("应 3 条，得 %d", len(list))
	}
	// 新在前
	if list[0].RemoteSessionID != "term-c" || list[2].RemoteSessionID != "term-a" {
		t.Fatalf("排序错误：%v", list)
	}
	if list[0].ID == "" || list[0].At.IsZero() {
		t.Fatal("Append 应补 ID/At 缺省")
	}
}

func TestDispatchRecordRingCapAndTTLPrune(t *testing.T) {
	s := newDispatchRecordStoreForTest(t)
	now := time.Now()
	// 环形上限：201 条只留最新 200
	for i := 0; i < store.DispatchKeepMax+1; i++ {
		if err := s.Append(store.DispatchRecord{
			InstanceID:      "inst-1",
			RemoteSessionID: "term-" + string(rune('a'+i%26)) + string(rune('0'+i/26)),
			At:              now.Add(time.Duration(i) * time.Second),
		}); err != nil {
			t.Fatal(err)
		}
	}
	list, _ := s.List()
	if len(list) != store.DispatchKeepMax {
		t.Fatalf("环形上限应 %d，得 %d", store.DispatchKeepMax, len(list))
	}
	// 裁的是最旧
	if list[0].At.Before(list[len(list)-1].At) {
		t.Fatal("List 应新在前")
	}
	// TTL：过期条目 List 惰性剪枝
	s2 := newDispatchRecordStoreForTest(t)
	_ = s2.Append(store.DispatchRecord{InstanceID: "i", RemoteSessionID: "old", At: now.Add(-2 * store.DispatchTTL)})
	_ = s2.Append(store.DispatchRecord{InstanceID: "i", RemoteSessionID: "fresh", At: now})
	got, _ := s2.List()
	if len(got) != 1 || got[0].RemoteSessionID != "fresh" {
		t.Fatalf("过期记录应被剪枝，得 %+v", got)
	}
}

func TestDispatchRecordDeleteIdempotentAndCleanup(t *testing.T) {
	s := newDispatchRecordStoreForTest(t)
	now := time.Now()
	_ = s.Append(store.DispatchRecord{InstanceID: "i", RemoteSessionID: "t1", At: now})
	_ = s.Append(store.DispatchRecord{InstanceID: "i", RemoteSessionID: "t2", At: now})
	list, _ := s.List()
	if err := s.Delete(list[0].ID); err != nil {
		t.Fatal(err)
	}
	// 幂等：未知 id 不报错
	if err := s.Delete("no-such-id"); err != nil {
		t.Fatalf("Delete 应幂等：%v", err)
	}
	got, _ := s.List()
	if len(got) != 1 {
		t.Fatalf("删后应剩 1 条，得 %d", len(got))
	}
	// CleanupBefore：截止前的清掉
	if n, err := s.CleanupBefore(now.Add(time.Minute)); err != nil || n != 1 {
		t.Fatalf("CleanupBefore 应清 1 条，得 n=%d err=%v", n, err)
	}
	if n, err := s.CleanupBefore(now.Add(time.Minute)); err != nil || n != 0 {
		t.Fatalf("重复清理应为 0，得 n=%d err=%v", n, err)
	}
}

func TestDispatchRecordPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	s1 := store.New(filestore.New(filepath.Join(dir, "data"))).DispatchRecord
	if err := s1.Append(store.DispatchRecord{
		InstanceID:      "inst-9",
		RemoteSessionID: "term-keep",
		At:              time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	s2 := store.New(filestore.New(filepath.Join(dir, "data"))).DispatchRecord
	got, err := s2.List()
	if err != nil || len(got) != 1 || got[0].RemoteSessionID != "term-keep" {
		t.Fatalf("重启后记录应存活：%v %v", got, err)
	}
}
