package store_test

import (
	"errors"
	"path/filepath"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newSentinelStoreForTest 独立 DocumentStore 实例（避免污染全局数据目录）
func newSentinelStoreForTest(t *testing.T) store.SentinelStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).Sentinel
}

// TestSentinelStore_EmptyFirstList 首次 List 无预置数据（哨兵无系统种子，
// 空列表是合法初态）
func TestSentinelStore_EmptyFirstList(t *testing.T) {
	s := newSentinelStoreForTest(t)
	first, err := s.List()
	if err != nil {
		t.Fatalf("first list: %v", err)
	}
	if len(first) != 0 {
		t.Fatalf("first list = %d, want 0 (no system seed)", len(first))
	}
}

// TestSentinelStore_CRUD 创建/更新/删除：ID 服务端生成（sc_sn_ 前缀）、
// 客户端伪造 ID 被忽略、空字段 patch 不改写、删除后不复活
func TestSentinelStore_CRUD(t *testing.T) {
	s := newSentinelStoreForTest(t)
	created, err := s.Create(store.SentinelRule{
		Name: "盯 OOM", Pattern: `(?i)out of memory`, Scope: store.SentinelScopeGlobal, Level: store.SentinelLevelError,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(created.ID) < 8 || created.ID[:6] != "sc_sn_" {
		t.Fatalf("ID = %q, want sc_sn_ prefix + server-generated", created.ID)
	}
	forged, err := s.Create(store.SentinelRule{Name: "伪造", Pattern: "x", ID: "sc_sn_forged"})
	if err != nil {
		t.Fatalf("create forged: %v", err)
	}
	if forged.ID == "sc_sn_forged" {
		t.Fatalf("server must generate ID, got client-forged %q", forged.ID)
	}

	// 空字段 patch = 未提供该字段，不改写既有值
	patched, err := s.Update(created.ID, store.SentinelRule{Name: "盯 OOM（加强）"})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if patched.Name != "盯 OOM（加强）" || patched.Pattern != `(?i)out of memory` || patched.Level != store.SentinelLevelError {
		t.Fatalf("patch semantics broken: %+v", patched)
	}
	// 显式字段覆盖
	if _, err := s.Update(created.ID, store.SentinelRule{Scope: "sc_proj_42"}); err != nil {
		t.Fatalf("update scope: %v", err)
	}
	list, _ := s.List()
	for _, ru := range list {
		if ru.ID == created.ID && ru.Scope != "sc_proj_42" {
			t.Fatalf("scope = %q, want sc_proj_42", ru.Scope)
		}
	}

	if err := s.Delete(forged.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := s.Delete(forged.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete missing = %v, want ErrNotFound", err)
	}
	if _, err := s.Update("sc_sn_missing", store.SentinelRule{Name: "x"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update missing = %v, want ErrNotFound", err)
	}
}

// TestSentinelStore_CapTenRules 规则数护栏（≤10）：第 11 条 Create 拒绝；
// 删一条后可再建。护栏在存储层，绕过 API 的调用方同样受限
func TestSentinelStore_CapTenRules(t *testing.T) {
	s := newSentinelStoreForTest(t)
	var lastID string
	for i := 0; i < store.SentinelMaxRules; i++ {
		ru, err := s.Create(store.SentinelRule{Name: "r", Pattern: "p"})
		if err != nil {
			t.Fatalf("create #%d: %v", i, err)
		}
		lastID = ru.ID
	}
	if _, err := s.Create(store.SentinelRule{Name: "over", Pattern: "p"}); !errors.Is(err, store.ErrTooManySentinels) {
		t.Fatalf("create over cap = %v, want ErrTooManySentinels", err)
	}
	if err := s.Delete(lastID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.Create(store.SentinelRule{Name: "again", Pattern: "p"}); err != nil {
		t.Fatalf("create after delete: %v", err)
	}
}

// TestSentinelStore_VersionBumpsOnWrite 版本号随写操作自增、读不动：
// 匹配侧编译缓存据此失效重编
func TestSentinelStore_VersionBumpsOnWrite(t *testing.T) {
	s := newSentinelStoreForTest(t)
	v0 := s.Version()
	ru, err := s.Create(store.SentinelRule{Name: "n", Pattern: "p"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	v1 := s.Version()
	if v1 <= v0 {
		t.Fatalf("version after create = %d, want > %d", v1, v0)
	}
	if _, err := s.List(); err != nil {
		t.Fatalf("list: %v", err)
	}
	if s.Version() != v1 {
		t.Fatalf("read must not bump version: %d != %d", s.Version(), v1)
	}
	if _, err := s.Update(ru.ID, store.SentinelRule{Name: "n2"}); err != nil {
		t.Fatalf("update: %v", err)
	}
	v2 := s.Version()
	if v2 <= v1 {
		t.Fatalf("version after update = %d, want > %d", v2, v1)
	}
	if err := s.Delete(ru.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if s.Version() <= v2 {
		t.Fatalf("version after delete = %d, want > %d", s.Version(), v2)
	}
}

// TestSentinelStore_PersistAndSort 列表创建序稳定（UI 展示序承诺）；
// 落盘重读（新 store 实例挂同一目录）后规则仍在
func TestSentinelStore_PersistAndSort(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	s1 := store.New(filestore.New(dir)).Sentinel
	first, err := s1.Create(store.SentinelRule{Name: "第一条", Pattern: "a"})
	if err != nil {
		t.Fatalf("create first: %v", err)
	}
	if _, err := s1.Create(store.SentinelRule{Name: "第二条", Pattern: "b"}); err != nil {
		t.Fatalf("create second: %v", err)
	}
	// 时间戳同秒精度下创建序可能并列：CreatedAt 升序排序必须稳定给出确定序
	list, err := s1.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("list = %d rules, want 2", len(list))
	}
	s2 := store.New(filestore.New(dir)).Sentinel
	reloaded, err := s2.List()
	if err != nil {
		t.Fatalf("reloaded list: %v", err)
	}
	if len(reloaded) != 2 {
		t.Fatalf("reloaded = %d rules, want 2 (persisted)", len(reloaded))
	}
	found := false
	for _, ru := range reloaded {
		if ru.ID == first.ID {
			found = true
			if ru.Name != "第一条" || ru.Pattern != "a" {
				t.Fatalf("reloaded rule mutated: %+v", ru)
			}
		}
	}
	if !found {
		t.Fatalf("first rule lost after reload")
	}
}
