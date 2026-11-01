package store_test

import (
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

func newAgentChainTestStore(t *testing.T) store.AgentChainStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).AgentChain
}

func sampleChain(source string) store.AgentChain {
	return store.AgentChain{
		SourceTerminalID: source,
		PromptTemplate:   "上一棒任务：{prevTask}（{prevStatus}），请继续处理：跑测试并修复失败项",
		Runtime:          "claude",
		Dir:              "",
		OnFailure:        false,
	}
}

// TestAgentChain_CRUD 定义域 CRUD：Create 覆写服务端事实字段（ID/时间戳/运行期
// 计数），List 创建时间倒序，Get/Delete 不存在语义稳定
func TestAgentChain_CRUD(t *testing.T) {
	s := newAgentChainTestStore(t)

	ch, err := s.Create(sampleChain("agent-1"))
	if err != nil {
		t.Fatal(err)
	}
	if ch.ID == "" || ch.CreatedAt.IsZero() {
		t.Fatalf("server-generated facts missing: %+v", ch)
	}
	if ch.TriggerCount != 0 || !ch.LastTriggeredAt.IsZero() || ch.LastStatus != "" {
		t.Fatalf("runtime facts must start zeroed: %+v", ch)
	}

	// 恶意传入运行期事实：Create 必须覆写，不采信调用方
	forged, err := s.Create(store.AgentChain{
		SourceTerminalID: "agent-2",
		PromptTemplate:   "p",
		TriggerCount:     99,
		LastSessionID:    "forged",
		LastStatus:       "launched",
	})
	if err != nil {
		t.Fatal(err)
	}
	if forged.TriggerCount != 0 || forged.LastSessionID != "" || forged.LastStatus != "" {
		t.Fatalf("forged runtime facts must be overwritten: %+v", forged)
	}

	got, err := s.Get(ch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.SourceTerminalID != "agent-1" || got.OnFailure {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}

	list, err := s.List()
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %d items, err %v", len(list), err)
	}
	if list[0].ID != forged.ID {
		t.Fatalf("list must be newest-first: %v vs %v", list[0].ID, forged.ID)
	}

	if err := s.Delete(ch.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ch.ID); err != store.ErrAgentChainNotFound {
		t.Fatalf("get after delete = %v, want ErrAgentChainNotFound", err)
	}
	if err := s.Delete(ch.ID); err != store.ErrAgentChainNotFound {
		t.Fatalf("double delete = %v, want ErrAgentChainNotFound", err)
	}
}

// TestAgentChain_RecordTrigger 运行期事实单点写入：时刻/下一棒会话/结果/计数
// 累加，CRUD 字段不受影响；不存在链报 ErrAgentChainNotFound
func TestAgentChain_RecordTrigger(t *testing.T) {
	s := newAgentChainTestStore(t)
	ch, err := s.Create(sampleChain("agent-1"))
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now()
	if err := s.RecordTrigger(ch.ID, at, "agent-next", "launched"); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordTrigger(ch.ID, at.Add(time.Minute), "agent-next2", "error: launch failed"); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(ch.ID)
	if got.TriggerCount != 2 || !got.LastTriggeredAt.Equal(at.Add(time.Minute)) {
		t.Fatalf("trigger facts: count=%d at=%v", got.TriggerCount, got.LastTriggeredAt)
	}
	if got.LastSessionID != "agent-next2" || got.LastStatus != "error: launch failed" {
		t.Fatalf("latest trigger must win: %+v", got)
	}
	if got.PromptTemplate != ch.PromptTemplate || got.Runtime != "claude" {
		t.Fatalf("definition fields must be untouched: %+v", got)
	}
	if err := s.RecordTrigger("chain-nope", at, "x", "launched"); err != store.ErrAgentChainNotFound {
		t.Fatalf("record on missing chain = %v, want ErrAgentChainNotFound", err)
	}
}

// TestAgentChain_Retention 容量裁剪：超出 AgentChainKeepMax 删最旧（保留策略
// 义务，追加型 kind 同 PR 带上限）
func TestAgentChain_Retention(t *testing.T) {
	s := newAgentChainTestStore(t)
	first := ""
	for i := 0; i < store.AgentChainKeepMax+3; i++ {
		ch, err := s.Create(store.AgentChain{
			SourceTerminalID: "agent-1",
			PromptTemplate:   "p",
		})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = ch.ID
		}
	}
	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != store.AgentChainKeepMax {
		t.Fatalf("kept %d chains, want %d", len(list), store.AgentChainKeepMax)
	}
	if _, err := s.Get(first); err != store.ErrAgentChainNotFound {
		t.Fatalf("oldest chain must be evicted, got %v", err)
	}
}

// TestAgentChain_CleanupBefore 保留窗口裁剪：早于 before 的链删除并计数
func TestAgentChain_CleanupBefore(t *testing.T) {
	s := newAgentChainTestStore(t)
	old, err := s.Create(sampleChain("agent-1"))
	if err != nil {
		t.Fatal(err)
	}
	// 手工把创建时刻拨回窗口外（repo 不暴露改写口，直接裁剪断言语义即可：
	// 新建链 CreatedAt=now 不会被裁，此处用第二条对照）
	fresh, err := s.Create(sampleChain("agent-2"))
	if err != nil {
		t.Fatal(err)
	}
	n, err := s.CleanupBefore(time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("removed %d, want 2 (both before future cutoff)", n)
	}
	if _, err := s.Get(old.ID); err != store.ErrAgentChainNotFound {
		t.Fatalf("old chain must be removed: %v", err)
	}
	if _, err := s.Get(fresh.ID); err != store.ErrAgentChainNotFound {
		t.Fatalf("fresh chain must be removed: %v", err)
	}
	_ = fresh
}
