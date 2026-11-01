package store_test

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

func newCompareExpTestStore(t *testing.T) store.CompareExperimentStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).CompareExp
}

func sampleExperiment(sessionA, sessionB string) store.CompareExperiment {
	return store.CompareExperiment{
		Prompt: "实现同一功能",
		Dir:    "/tmp/proj",
		Status: store.CompareExpRunning, // repo Create 会覆写；纯函数用例依赖非零初值
		A:      store.CompareSide{SessionID: sessionA, Runtime: "claude", Launched: true},
		B:      store.CompareSide{SessionID: sessionB, Runtime: "codex", Launched: true},
	}
}

// TestCompareExp_StateTransition 状态机钉死：running → ready（双侧终结回执齐备），
// 迟到/重复/异侧回执幂等
func TestCompareExp_StateTransition(t *testing.T) {
	s := newCompareExpTestStore(t)
	exp, err := s.Create(sampleExperiment("agent-1", "agent-2"))
	if err != nil {
		t.Fatal(err)
	}
	if exp.Status != store.CompareExpRunning {
		t.Fatalf("initial status = %q, want running", exp.Status)
	}

	// 侧 A 完成：仍 running（B 未回）
	if _, err := s.SetSideResult(exp.ID, "agent-1", "done", "claude-sess-1"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(exp.ID)
	if got.Status != store.CompareExpRunning || got.A.Result != "done" || got.A.AgentSessionID != "claude-sess-1" {
		t.Fatalf("after A done: status=%q A=%+v", got.Status, got.A)
	}

	// 侧 B 完成：翻 ready + ReadyAt 记账
	if _, err := s.SetSideResult(exp.ID, "agent-2", "done", ""); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Get(exp.ID)
	if got.Status != store.CompareExpReady || got.ReadyAt.IsZero() {
		t.Fatalf("after B done: status=%q readyAt=%v, want ready+nonzero", got.Status, got.ReadyAt)
	}

	// ready 后迟到回执/未知会话：幂等 no-op，不覆写已终结结果
	if _, err := s.SetSideResult(exp.ID, "agent-2", "failed", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetSideResult(exp.ID, "agent-other", "done", ""); err != nil {
		t.Fatalf("unknown session should be a no-op with nil error, got %v", err)
	}
	got, _ = s.Get(exp.ID)
	if got.B.Result != "done" || got.A.Result != "done" {
		t.Fatalf("late report must not overwrite finalized result: %+v", got.B)
	}
	if got.Status != store.CompareExpReady {
		t.Fatalf("late report must not flip status back: %q", got.Status)
	}
}

// TestCompareExp_ApplySideResultPure 纯函数边界：空参/双结果齐备才翻 ready
func TestCompareExp_ApplySideResultPure(t *testing.T) {
	exp := sampleExperiment("a", "b")
	if store.ApplySideResult(&exp, "", "done", "") {
		t.Fatal("empty sessionID must be no-op")
	}
	if store.ApplySideResult(&exp, "a", "", "") {
		t.Fatal("empty result must be no-op")
	}
	if store.ApplySideResult(&exp, "zzz", "done", "") {
		t.Fatal("unmatched session must be no-op")
	}
	if !store.ApplySideResult(&exp, "a", "failed", "") || !store.ApplySideResult(&exp, "b", "done", "") {
		t.Fatal("both sides reporting should each apply once")
	}
	if exp.Status != store.CompareExpReady {
		t.Fatalf("status = %q, want ready", exp.Status)
	}
	if store.ApplySideResult(&exp, "a", "done", "") {
		t.Fatal("ready experiment must be frozen")
	}
	// failed 也算终结：单侧 failed + 侧 done 同样翻 ready
	exp2 := sampleExperiment("a", "b")
	_ = store.ApplySideResult(&exp2, "a", "failed", "")
	_ = store.ApplySideResult(&exp2, "b", "failed", "")
	if exp2.Status != store.CompareExpReady {
		t.Fatalf("failed+failed should be ready, got %q", exp2.Status)
	}
}

// TestCompareExp_Adopt 采用标注：合法值持久化、非法值拒绝
func TestCompareExp_Adopt(t *testing.T) {
	s := newCompareExpTestStore(t)
	exp, _ := s.Create(sampleExperiment("a", "b"))
	if _, err := s.SetAdopted(exp.ID, store.CompareAdoptA); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(exp.ID)
	if got.Adopted != store.CompareAdoptA {
		t.Fatalf("adopted = %q, want a", got.Adopted)
	}
	if _, err := s.SetAdopted(exp.ID, store.CompareAdoptNone); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Get(exp.ID)
	if got.Adopted != store.CompareAdoptNone {
		t.Fatalf("adopted = %q, want empty", got.Adopted)
	}
	if _, err := s.SetAdopted(exp.ID, "c"); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("invalid side should be ErrInvalidArg, got %v", err)
	}
}

// TestCompareExp_Retention 容量保留：超出上限裁剪最旧（append kind 保留策略义务）
func TestCompareExp_Retention(t *testing.T) {
	s := newCompareExpTestStore(t)
	for i := 0; i < store.CompareExpKeepMax+5; i++ {
		if _, err := s.Create(sampleExperiment("a", "b")); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond) // 保证 CreatedAt 单调可分辨
	}
	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != store.CompareExpKeepMax {
		t.Fatalf("list len = %d, want capped %d", len(list), store.CompareExpKeepMax)
	}
	// 倒序：最新在前
	for i := 1; i < len(list); i++ {
		if list[i-1].CreatedAt.Before(list[i].CreatedAt) {
			t.Fatalf("list not sorted desc at %d", i)
		}
	}
	// TTL 清理
	n, err := s.CleanupBefore(time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n != store.CompareExpKeepMax {
		t.Fatalf("CleanupBefore removed %d, want %d", n, store.CompareExpKeepMax)
	}
}

// TestCompareExp_Delete Get/Delete 哨兵语义
func TestCompareExp_Delete(t *testing.T) {
	s := newCompareExpTestStore(t)
	exp, _ := s.Create(sampleExperiment("a", "b"))
	if _, err := s.Get(exp.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(exp.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(exp.ID); !errors.Is(err, store.ErrCompareExpNotFound) {
		t.Fatalf("want ErrCompareExpNotFound, got %v", err)
	}
	if err := s.Delete(exp.ID); !errors.Is(err, store.ErrCompareExpNotFound) {
		t.Fatalf("double delete should be ErrCompareExpNotFound, got %v", err)
	}
}
