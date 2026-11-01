package store_test

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newQueueStoreForTest 独立 DocumentStore 实例（避免污染全局数据目录）
func newQueueStoreForTest(t *testing.T) store.AgentSessionQueueStore {
	t.Helper()
	s := store.New(filestore.New(filepath.Join(t.TempDir(), "data")))
	return s.AgentQueue
}

// 排队指令仓储单测（P-20261003-248 拆解第 1 步）：存取/上限/规整/弹出/清空

func TestAgentSessionQueue_AppendAndGet(t *testing.T) {
	repo := newQueueStoreForTest(t)

	if q, _ := repo.Get("agent-1"); q != nil {
		t.Fatalf("absent queue should be nil, got %+v", q)
	}
	q, err := repo.Append("agent-1", "跑一遍测试")
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if len(q.Items) != 1 || q.Items[0].Text != "跑一遍测试" {
		t.Fatalf("unexpected items: %+v", q.Items)
	}
	if q.Items[0].QueuedAt.IsZero() {
		t.Fatalf("queuedAt should be stamped")
	}
	if _, err := repo.Append("agent-1", "\n  再修一下 lint \t"); err != nil {
		t.Fatalf("append 2: %v", err)
	}
	got, err := repo.Get("agent-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	// 换行/制表符折叠为空格 + trim：单行语义
	if got.Items[1].Text != "再修一下 lint" {
		t.Fatalf("sanitize failed: %q", got.Items[1].Text)
	}
	// FIFO 序保持
	if got.Items[0].Text != "跑一遍测试" {
		t.Fatalf("order broken: %+v", got.Items)
	}
}

func TestAgentSessionQueue_CapFive(t *testing.T) {
	repo := newQueueStoreForTest(t)
	for i := 0; i < store.AgentQueueMaxItems; i++ {
		if _, err := repo.Append("agent-cap", strings.Repeat("x", 10)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	if _, err := repo.Append("agent-cap", "第六条"); !errors.Is(err, store.ErrQueueFull) {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	// 满队拒绝后原队列不动（仍 5 条）
	q, _ := repo.Get("agent-cap")
	if len(q.Items) != store.AgentQueueMaxItems {
		t.Fatalf("queue mutated on full: %d", len(q.Items))
	}
}

func TestAgentSessionQueue_InvalidInstruction(t *testing.T) {
	repo := newQueueStoreForTest(t)
	if _, err := repo.Append("agent-inv", "   \n  "); !errors.Is(err, store.ErrQueueInvalid) {
		t.Fatalf("blank should be invalid, got %v", err)
	}
	long := strings.Repeat("字", store.AgentQueueItemMaxRunes+1)
	if _, err := repo.Append("agent-inv", long); !errors.Is(err, store.ErrQueueInvalid) {
		t.Fatalf("overlong should be invalid, got %v", err)
	}
	// 上限值本身合法
	ok := strings.Repeat("字", store.AgentQueueItemMaxRunes)
	if _, err := repo.Append("agent-inv", ok); err != nil {
		t.Fatalf("boundary length should pass: %v", err)
	}
}

func TestAgentSessionQueue_Replace(t *testing.T) {
	repo := newQueueStoreForTest(t)
	for _, s := range []string{"a", "b", "c"} {
		if _, err := repo.Append("agent-r", s); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	// 编辑/删除/重排都走整表替换
	q, err := repo.Replace("agent-r", []string{"c", "改过的"})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if len(q.Items) != 2 || q.Items[0].Text != "c" || q.Items[1].Text != "改过的" {
		t.Fatalf("unexpected replace result: %+v", q.Items)
	}
	// 超上限整表拒绝
	many := make([]string, store.AgentQueueMaxItems+1)
	if _, err := repo.Replace("agent-r", many); !errors.Is(err, store.ErrQueueFull) {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	// 含非法条目整表拒绝（不半写）
	if _, err := repo.Replace("agent-r", []string{"ok", " "}); !errors.Is(err, store.ErrQueueInvalid) {
		t.Fatalf("want ErrQueueInvalid, got %v", err)
	}
	q, _ = repo.Get("agent-r")
	if len(q.Items) != 2 {
		t.Fatalf("half-write on invalid replace: %+v", q.Items)
	}
	// 空表 = 清空：文档删除，Get 回到 nil,nil
	if _, err := repo.Replace("agent-r", nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if q, _ := repo.Get("agent-r"); q != nil {
		t.Fatalf("cleared queue should be nil, got %+v", q)
	}
}

func TestAgentSessionQueue_PopHeadAndDelete(t *testing.T) {
	repo := newQueueStoreForTest(t)
	if _, ok, err := repo.PopHead("agent-p"); ok || err != nil {
		t.Fatalf("empty pop: ok=%v err=%v", ok, err)
	}
	for _, s := range []string{"first", "second"} {
		if _, err := repo.Append("agent-p", s); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	head, ok, err := repo.PopHead("agent-p")
	if err != nil || !ok || head.Text != "first" {
		t.Fatalf("pop: ok=%v err=%v head=%+v", ok, err, head)
	}
	head, ok, _ = repo.PopHead("agent-p")
	if !ok || head.Text != "second" {
		t.Fatalf("pop 2: ok=%v head=%+v", ok, head)
	}
	// 弹空后文档即删（不留空壳文档）
	if q, _ := repo.Get("agent-p"); q != nil {
		t.Fatalf("emptied queue should be nil, got %+v", q)
	}
	if err := repo.Delete("agent-x"); err != nil {
		t.Fatalf("delete absent should be noop-ok, got %v", err)
	}
}

func TestAgentSessionQueue_List(t *testing.T) {
	repo := newQueueStoreForTest(t)
	if _, err := repo.Append("agent-l1", "一"); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := repo.Append("agent-l2", "二"); err != nil {
		t.Fatalf("append: %v", err)
	}
	list, err := repo.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 queues, got %d", len(list))
	}
}

func TestAgentSessionQueue_InstructionRuneBounded(t *testing.T) {
	// 长度按 rune 计（中文一条 = 1 rune），非字节——2000 汉字应通过
	repo := newQueueStoreForTest(t)
	text := strings.Repeat("汉", store.AgentQueueItemMaxRunes)
	if utf8.RuneCountInString(text) != store.AgentQueueItemMaxRunes {
		t.Fatalf("fixture broken")
	}
	if _, err := repo.Append("agent-rune", text); err != nil {
		t.Fatalf("rune-bounded append should pass: %v", err)
	}
}
