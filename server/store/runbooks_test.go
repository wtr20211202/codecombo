package store_test

import (
	"errors"
	"path/filepath"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newRunbookStoreForTest 独立 DocumentStore 实例（避免污染全局数据目录）
func newRunbookStoreForTest(t *testing.T) store.RunbookStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).Runbook
}

// TestRunbookStore_EmptyFirstList 首次 List 无预置数据（运行书无系统种子，
// 与片段不同——空列表是合法初态）
func TestRunbookStore_EmptyFirstList(t *testing.T) {
	s := newRunbookStoreForTest(t)
	first, err := s.List()
	if err != nil {
		t.Fatalf("first list: %v", err)
	}
	if len(first) != 0 {
		t.Fatalf("first list = %d, want 0 (no system seed)", len(first))
	}
}

// TestRunbookStore_CRUD 创建/更新/删除；ID 服务端生成、客户端伪造字段被忽略、
// 步骤深拷贝与调用方别名脱钩
func TestRunbookStore_CRUD(t *testing.T) {
	s := newRunbookStoreForTest(t)
	steps := []store.RunbookStep{
		{Command: "docker compose pull", Description: "拉镜像"},
		{Command: "docker compose up -d"},
	}
	created, err := s.Create(store.Runbook{Title: "部署三连", Description: "发版清单", Steps: steps})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == "" || len(created.ID) < 8 {
		t.Fatalf("ID = %q, want server-generated", created.ID)
	}
	// 伪造 ID/时间戳被忽略（服务端生成）
	forged, err := s.Create(store.Runbook{Title: "伪造", Steps: []store.RunbookStep{{Command: "id"}}, ID: "sc_rb_forged"})
	if err != nil {
		t.Fatalf("create forged: %v", err)
	}
	if forged.ID == "sc_rb_forged" {
		t.Fatalf("server must generate ID, got client-forged %q", forged.ID)
	}

	// 别名脱钩：Create 后改调用方切片，再走一次 Update 触发 save，原步骤不变
	steps[0].Command = "tampered"
	if _, err := s.Update(created.ID, store.Runbook{Title: "部署三连v2"}); err != nil {
		t.Fatalf("update title: %v", err)
	}
	list, _ := s.List()
	for _, b := range list {
		if b.ID != created.ID {
			continue
		}
		if b.Steps[0].Command != "docker compose pull" {
			t.Fatalf("step alias leaked into store: %q", b.Steps[0].Command)
		}
		if b.Title != "部署三连v2" {
			t.Fatalf("title = %q, want updated", b.Title)
		}
	}

	// Steps 空 = patch 未提供该字段，不清空既有步骤
	patched, err := s.Update(created.ID, store.Runbook{Description: "只改说明"})
	if err != nil {
		t.Fatalf("update desc: %v", err)
	}
	if len(patched.Steps) != 2 || patched.Steps[1].Command != "docker compose up -d" {
		t.Fatalf("empty steps patch must not clear: %+v", patched.Steps)
	}

	// 替换步骤（编辑表单全量回写语义）
	if _, err := s.Update(created.ID, store.Runbook{Steps: []store.RunbookStep{{Command: "docker compose restart"}}}); err != nil {
		t.Fatalf("replace steps: %v", err)
	}
	final, _ := s.List()
	for _, b := range final {
		if b.ID == created.ID && (len(b.Steps) != 1 || b.Steps[0].Command != "docker compose restart") {
			t.Fatalf("steps replace failed: %+v", b.Steps)
		}
	}

	if err := s.Delete(forged.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := s.Delete(forged.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete missing = %v, want ErrNotFound", err)
	}
	if _, err := s.Update("sc_rb_missing", store.Runbook{Title: "x"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update missing = %v, want ErrNotFound", err)
	}
}

// TestRunbookStore_PersistOrderAndSort 列表 Title 字典序；步骤数组序（执行序）
// 落盘重读后保持——逐步发送的顺序语义不能被存储打乱
func TestRunbookStore_PersistOrderAndSort(t *testing.T) {
	s := newRunbookStoreForTest(t)
	if _, err := s.Create(store.Runbook{Title: "b 书", Steps: []store.RunbookStep{{Command: "b3"}, {Command: "b1"}, {Command: "b2"}}}); err != nil {
		t.Fatalf("create b: %v", err)
	}
	if _, err := s.Create(store.Runbook{Title: "a 书", Steps: []store.RunbookStep{{Command: "a1"}}}); err != nil {
		t.Fatalf("create a: %v", err)
	}
	list, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 || list[0].Title != "a 书" || list[1].Title != "b 书" {
		t.Fatalf("list order = %v, want title-sorted", []string{list[0].Title, list[1].Title})
	}
	// 步骤保持写入序（不做任何重排）
	bSteps := list[1].Steps
	if bSteps[0].Command != "b3" || bSteps[1].Command != "b1" || bSteps[2].Command != "b2" {
		t.Fatalf("step order not preserved: %+v", bSteps)
	}
}

// TestRunbookStore_OnFailure 失败语义字段（P-20261004-13）持久化：
// 默认空（=continue）、stop 落盘、patch 空 = 不改写、显式 continue 可切回
func TestRunbookStore_OnFailure(t *testing.T) {
	s := newRunbookStoreForTest(t)
	steps := []store.RunbookStep{{Command: "echo hi"}}

	// 默认创建：OnFailure 空（JSON omitempty 不落盘，读回零值 = continue 语义）
	def, err := s.Create(store.Runbook{Title: "默认书", Steps: steps})
	if err != nil {
		t.Fatalf("create default: %v", err)
	}
	if def.OnFailure != "" {
		t.Fatalf("default OnFailure = %q, want empty (continue)", def.OnFailure)
	}

	// stop 落盘：重读（List 走 docstore）后保持
	if _, err := s.Create(store.Runbook{Title: "停机书", Steps: steps, OnFailure: "stop"}); err != nil {
		t.Fatalf("create stop: %v", err)
	}
	list, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	found := false
	for _, b := range list {
		if b.Title != "停机书" {
			continue
		}
		found = true
		if b.OnFailure != "stop" {
			t.Fatalf("OnFailure = %q, want stop persisted", b.OnFailure)
		}
	}
	if !found {
		t.Fatalf("stop book missing from list")
	}

	// patch 语义：空 OnFailure = 未提供，不改写既有 stop；显式 continue 可切回
	if _, err := s.Update(def.ID, store.Runbook{Title: "默认书v2"}); err != nil {
		t.Fatalf("patch without onFailure: %v", err)
	}
	patched, err := s.Update(def.ID, store.Runbook{OnFailure: "stop"})
	if err != nil {
		t.Fatalf("patch onFailure stop: %v", err)
	}
	if patched.OnFailure != "stop" {
		t.Fatalf("patched OnFailure = %q, want stop", patched.OnFailure)
	}
	if _, err := s.Update(def.ID, store.Runbook{Title: "默认书v3"}); err != nil {
		t.Fatalf("patch title without onFailure: %v", err)
	}
	reread, err := s.List()
	if err != nil {
		t.Fatalf("re-list: %v", err)
	}
	for _, b := range reread {
		if b.ID != def.ID {
			continue
		}
		if b.OnFailure != "stop" {
			t.Fatalf("empty onFailure patch must not overwrite: got %q", b.OnFailure)
		}
		if b.Title != "默认书v3" {
			t.Fatalf("title patch lost: %q", b.Title)
		}
	}
	patched, err = s.Update(def.ID, store.Runbook{OnFailure: "continue"})
	if err != nil {
		t.Fatalf("patch onFailure continue: %v", err)
	}
	if patched.OnFailure != "continue" {
		t.Fatalf("patched OnFailure = %q, want continue", patched.OnFailure)
	}
}
