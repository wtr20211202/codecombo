package store_test

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newAgentCronStoreForTest 独立 DocumentStore 实例（避免污染全局数据目录）
func newAgentCronStoreForTest(t *testing.T) store.AgentCronStore {
	t.Helper()
	return store.New(filestore.New(filepath.Join(t.TempDir(), "data"))).AgentCron
}

// 定时任务仓储单测（P-20261002-43）：全量替换语义下运行期事实不可被用户编辑
// 覆盖，RecordRun 单点写入

func TestAgentCron_CRUD(t *testing.T) {
	repo := newAgentCronStoreForTest(t)

	c, err := repo.Create(store.AgentCron{Name: "夜间审查", Hour: 2, Minute: 0, Weekdays: []int{1, 5}, Prompt: "审查", Enabled: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if c.ID == "" || c.CreatedAt.IsZero() {
		t.Fatalf("server-generated fields missing: %+v", c)
	}

	// 用户编辑：替换可编辑字段，保留身份与运行期事实
	if err := repo.RecordRun(c.ID, time.Now(), "launched", ""); err != nil {
		t.Fatalf("record run: %v", err)
	}
	updated, err := repo.Update(c.ID, store.AgentCron{Name: "改名", Hour: 3, Minute: 30, Prompt: "改", Enabled: false})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Name != "改名" || updated.Enabled {
		t.Fatalf("editable fields not replaced: %+v", updated)
	}
	if updated.LastResult != "launched" || updated.LastRunAt.IsZero() {
		t.Fatalf("run facts must survive user edit: %+v", updated)
	}
	if len(updated.History) != 1 || updated.History[0].Result != "launched" {
		t.Fatalf("run history must survive user edit: %+v", updated.History)
	}
	if !updated.CreatedAt.Equal(c.CreatedAt) {
		t.Fatalf("createdAt must be preserved")
	}

	// RecordRun 单独可写结果
	if err := repo.RecordRun(c.ID, time.Now(), "done", ""); err != nil {
		t.Fatalf("record run: %v", err)
	}
	if got, _ := repo.Get(c.ID); got.LastResult != "done" {
		t.Fatalf("lastResult = %q, want done", got.LastResult)
	}

	if err := repo.Delete(c.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := repo.Get(c.ID); !errors.Is(err, store.ErrAgentCronNotFound) {
		t.Fatalf("get after delete = %v, want ErrAgentCronNotFound", err)
	}
}

func TestAgentCron_NotFound(t *testing.T) {
	repo := newAgentCronStoreForTest(t)
	if _, err := repo.Get("sc_cron_missing"); !errors.Is(err, store.ErrAgentCronNotFound) {
		t.Fatalf("get missing = %v", err)
	}
	if err := repo.RecordRun("sc_cron_missing", time.Now(), "x", ""); !errors.Is(err, store.ErrAgentCronNotFound) {
		t.Fatalf("record missing = %v", err)
	}
}

// 依赖链字段（P-20261003-124）：用户编辑可写入/清空；旧数据无 trigger 字段
// 读出即空 = 定时语义（零迁移）
func TestAgentCron_DependencyFields(t *testing.T) {
	repo := newAgentCronStoreForTest(t)

	c, err := repo.Create(store.AgentCron{Name: "旧定时", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if c.IsAfterTrigger() {
		t.Fatal("legacy record (no trigger field) must read as schedule")
	}

	parent, err := repo.Create(store.AgentCron{Name: "父", Hour: 1, Minute: 0, Prompt: "p", Enabled: true})
	if err != nil {
		t.Fatalf("create parent: %v", err)
	}
	child, err := repo.Create(store.AgentCron{
		Name: "子", Hour: 2, Minute: 0, Prompt: "p", Enabled: true,
		Trigger: store.CronTriggerAfter, AfterCronID: parent.ID, AfterMode: store.CronAfterAlways,
	})
	if err != nil {
		t.Fatalf("create child: %v", err)
	}
	if !child.IsAfterTrigger() || child.AfterCronID != parent.ID || child.AfterMode != store.CronAfterAlways {
		t.Fatalf("dependency fields not persisted: %+v", child)
	}

	// 编辑清空依赖字段：任务回归定时语义
	upd, err := repo.Update(child.ID, store.AgentCron{Name: "子", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if upd.IsAfterTrigger() || upd.AfterCronID != "" || upd.AfterMode != "" {
		t.Fatalf("dependency fields should clear on edit, got %+v", upd)
	}
}

// 运行历史环形截断（P-20261002-143）：追加超出上限丢最旧、失败摘要 rune 截断、
// 历史随任务本体同文档持久化
func TestAgentCron_RunHistoryRingAndSummary(t *testing.T) {
	repo := newAgentCronStoreForTest(t)
	c, err := repo.Create(store.AgentCron{Name: "历史", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// 追加 25 条（上限 20 + 5）：只留最近 20 条，最旧 5 条被截断
	const total = 25
	const keep = 20 // 任务书口径：最近 20 条
	base := time.Date(2026, 10, 1, 2, 0, 0, 0, time.Local)
	longSummary := strings.Repeat("错", 130) // 多字节超长：验证 rune 截断不产生坏 UTF-8
	for i := 0; i < total; i++ {
		result, summary := "done", ""
		if i%3 == 0 { // 每 3 条掺一条失败：间歇失败在历史中现形
			result, summary = "error: boom", longSummary
		}
		if err := repo.RecordRun(c.ID, base.Add(time.Duration(i)*time.Minute), result, summary); err != nil {
			t.Fatalf("record run #%d: %v", i, err)
		}
	}

	got, err := repo.Get(c.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.History) != keep {
		t.Fatalf("history len = %d, want %d", len(got.History), keep)
	}
	// 首条 = 第 6 次运行（前 5 条被截断），末条 = 第 25 次；最新在尾
	if !got.History[0].At.Equal(base.Add(time.Duration(total-keep) * time.Minute)) {
		t.Fatalf("oldest kept entry = %v, want slot #%d", got.History[0].At, total-keep)
	}
	if !got.History[keep-1].At.Equal(base.Add(time.Duration(total-1) * time.Minute)) {
		t.Fatalf("newest entry = %v, want slot #%d", got.History[keep-1].At, total-1)
	}
	// 失败摘要 rune 截断 ≤120 且不产生坏 UTF-8（逐条口径一致）
	for i, run := range got.History {
		if n := utf8.RuneCountInString(run.ErrSummary); n > 120 {
			t.Fatalf("entry #%d errSummary runes = %d, want ≤120", i, n)
		}
		if run.Result == "error: boom" && run.ErrSummary != strings.Repeat("错", 120) {
			t.Fatalf("entry #%d errSummary = %q(runes %d), want 120-rune head", i, run.ErrSummary, utf8.RuneCountInString(run.ErrSummary))
		}
	}
	if got.LastResult != "error: boom" {
		t.Fatalf("lastResult = %q, want error prefix kept", got.LastResult)
	}
}

// 接力事实（P-20261005-207）：RecordRelay 单点写 LastRelayAt/LastRelayNote
// 且与运行账独立（不动 LastRunAt/LastResult/History）；note rune 截断；用户
// 编辑不触碰接力事实、RelayFrom 走全量替换语义
func TestAgentCron_RecordRelay(t *testing.T) {
	repo := newAgentCronStoreForTest(t)
	c, err := repo.Create(store.AgentCron{Name: "接力", Hour: 2, Minute: 0, Prompt: "p", Enabled: true, RelayFrom: store.CronRelayLatest})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	runAt := time.Date(2026, 10, 8, 2, 0, 0, 0, time.Local)
	if err := repo.RecordRun(c.ID, runAt, "launched", ""); err != nil {
		t.Fatalf("record run: %v", err)
	}
	relayAt := runAt.Add(time.Second)
	if err := repo.RecordRelay(c.ID, relayAt, "relayed"); err != nil {
		t.Fatalf("record relay: %v", err)
	}
	got, err := repo.Get(c.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.LastResult != "launched" || got.LastRelayNote != "relayed" {
		t.Fatalf("run/relay accounts diverged: lastResult=%q lastRelayNote=%q", got.LastResult, got.LastRelayNote)
	}
	if !got.LastRelayAt.Equal(relayAt) {
		t.Fatalf("lastRelayAt = %v, want %v", got.LastRelayAt, relayAt)
	}
	if len(got.History) != 1 {
		t.Fatalf("relay record must not touch history, got %d entries", len(got.History))
	}

	// note rune 截断（skip 原因含不可控输入的兜底口径与 errSummary 一致）
	longNote := strings.Repeat("因", 130)
	if err := repo.RecordRelay(c.ID, relayAt.Add(time.Minute), longNote); err != nil {
		t.Fatalf("record relay #2: %v", err)
	}
	if got, _ = repo.Get(c.ID); got.LastRelayNote != strings.Repeat("因", 120) {
		t.Fatalf("relay note should truncate to 120 runes, got %d", utf8.RuneCountInString(got.LastRelayNote))
	}

	// 用户编辑（全量替换）不触碰运行/接力事实；RelayFrom 清空 = 关接力
	if _, err := repo.Update(c.ID, store.AgentCron{Name: "接力", Hour: 3, Minute: 0, Prompt: "p", Enabled: true}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if got, _ = repo.Get(c.ID); got.LastResult != "launched" || got.LastRelayAt.IsZero() || got.RelayFrom != "" {
		t.Fatalf("edit must keep runtime facts and replace relayFrom, got %+v relayFrom=%q", got.LastRelayAt, got.RelayFrom)
	}
}

// 错过槽历史（P-20261006-22）：RecordMissed 单点写入且与运行账独立、环形截断
// 20 条、失败摘要 rune 截断、同槽同处置幂等（跨重启同日重判不堆积重复条目）、
// 用户编辑不触碰
func TestAgentCron_RecordMissed(t *testing.T) {
	repo := newAgentCronStoreForTest(t)
	c, err := repo.Create(store.AgentCron{Name: "错过账", Hour: 2, Minute: 0, Prompt: "p", Enabled: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	slot := time.Date(2026, 10, 12, 2, 0, 0, 0, time.Local)
	// 三态各记一条（互不重叠的槽点）+ 同槽同处置重复一笔（幂等：仍只 3 条）
	for _, m := range []struct {
		off     time.Duration
		action  string
		summary string
	}{
		{0, "skipped", ""},
		{time.Minute, "caught-up", ""},
		{2 * time.Minute, "failed", strings.Repeat("误", 130)}, // 多字节超长：验证 rune 截断
		{0, "skipped", ""},                                    // 同槽同处置：幂等跳过
	} {
		if err := repo.RecordMissed(c.ID, slot.Add(m.off), m.action, m.summary); err != nil {
			t.Fatalf("record missed %s: %v", m.action, err)
		}
	}
	got, err := repo.Get(c.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.MissedHistory) != 3 {
		t.Fatalf("missedHistory len = %d, want 3 (same slot+action dedup)", len(got.MissedHistory))
	}
	if got.MissedHistory[2].Action != "failed" || got.MissedHistory[2].ErrSummary != strings.Repeat("误", 120) {
		t.Fatalf("failed entry summary should truncate to 120 runes, got %d", utf8.RuneCountInString(got.MissedHistory[2].ErrSummary))
	}
	// 运行账不动：LastRunAt/LastResult/History 零触
	if !got.LastRunAt.IsZero() || got.LastResult != "" || len(got.History) != 0 {
		t.Fatalf("missed record must not touch run account: %+v", got)
	}

	// 环形截断：追加超出上限丢最旧
	base := time.Date(2026, 10, 1, 2, 0, 0, 0, time.Local)
	const total, keep = 25, 20
	for i := 0; i < total; i++ {
		if err := repo.RecordMissed(c.ID, base.Add(time.Duration(i)*time.Hour), "skipped", ""); err != nil {
			t.Fatalf("record missed #%d: %v", i, err)
		}
	}
	if got, _ = repo.Get(c.ID); len(got.MissedHistory) != keep {
		t.Fatalf("missedHistory len = %d, want ring %d", len(got.MissedHistory), keep)
	}
	if !got.MissedHistory[0].Slot.Equal(base.Add(time.Duration(total-keep) * time.Hour)) {
		t.Fatalf("oldest kept slot = %v, want %v", got.MissedHistory[0].Slot, base.Add(time.Duration(total-keep)*time.Hour))
	}

	// 用户编辑（全量替换）不触碰错过账
	if _, err := repo.Update(c.ID, store.AgentCron{Name: "错过账", Hour: 4, Minute: 0, Prompt: "p", Enabled: true}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if got, _ = repo.Get(c.ID); len(got.MissedHistory) != keep {
		t.Fatalf("missedHistory must survive user edit, got %d entries", len(got.MissedHistory))
	}

	// 不存在的任务
	if err := repo.RecordMissed("sc_cron_missing", time.Now(), "skipped", ""); !errors.Is(err, store.ErrAgentCronNotFound) {
		t.Fatalf("record missed missing = %v, want ErrAgentCronNotFound", err)
	}
}
