package store_test

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 车道 1 新 repo 主路径单测（P-20261003-67 策展层）：键派生（root 隔离）+
// Put/GetBatch/Delete/Count 往返 + note rune 钳制（Put 唯一出口）。
// 结构与 claudeindex_test.go 同款（同族 repo，语义对齐便于 review）
func TestClaudeCurStoreRoundtrip(t *testing.T) {
	s := store.New(filestore.New(t.TempDir()))

	k1 := store.ClaudeCurKey(`C:\root1`, "uuid-1")
	k2 := store.ClaudeCurKey(`C:\root1`, "uuid-2")
	k3 := store.ClaudeCurKey(`C:\root2`, "uuid-1") // 同 UUID、不同根：隔离
	if k1 == k3 {
		t.Fatalf("different roots must isolate: %s", k1)
	}

	now := time.Now()
	for _, e := range []store.ClaudeSessionCur{
		{Key: k1, ID: "uuid-1", Starred: true, Note: "调 WebSocket 重连的那次", UpdatedAt: now},
		{Key: k2, ID: "uuid-2", Note: "只有备注没星标", UpdatedAt: now},
		{Key: k3, ID: "uuid-1", Starred: true, UpdatedAt: now},
	} {
		if err := s.ClaudeCur.Put(e); err != nil {
			t.Fatal(err)
		}
	}

	got, err := s.ClaudeCur.GetBatch(store.ClaudeCurPrefix(`C:\root1`))
	if err != nil || len(got) != 2 {
		t.Fatalf("root1 batch: %v %v", got, err)
	}
	if c := got[k1]; !c.Starred || c.Note != "调 WebSocket 重连的那次" || c.ID != "uuid-1" || c.Key != k1 {
		t.Fatalf("entry roundtrip: %+v", c)
	}
	if got2, _ := s.ClaudeCur.GetBatch(store.ClaudeCurPrefix(`C:\root2`)); len(got2) != 1 || !got2[k3].Starred {
		t.Fatalf("root2 isolation: %v", got2)
	}
	if n, _ := s.ClaudeCur.Count(); n != 3 {
		t.Fatalf("count = %d, want 3", n)
	}

	// upsert 覆盖：重写同键取新值
	if err := s.ClaudeCur.Put(store.ClaudeSessionCur{Key: k1, ID: "uuid-1", Note: "改口了"}); err != nil {
		t.Fatal(err)
	}
	got, _ = s.ClaudeCur.GetBatch(store.ClaudeCurPrefix(`C:\root1`))
	if c := got[k1]; c.Starred || c.Note != "改口了" {
		t.Fatalf("upsert overwrite: %+v", c)
	}

	if err := s.ClaudeCur.Delete(k2); err != nil {
		t.Fatal(err)
	}
	if got, _ = s.ClaudeCur.GetBatch(store.ClaudeCurPrefix(`C:\root1`)); len(got) != 1 {
		t.Fatalf("after delete: %v", got)
	}
}

// note 钳制：超 200 rune 截到恰好 200（rune 域，中文不截半字），未超原样透传；
// 空键/空 id 拒绝（ErrInvalidArg，与 claudeindex repo 同防线）
func TestClaudeCurNoteClamp(t *testing.T) {
	s := store.New(filestore.New(t.TempDir()))

	long := strings.Repeat("记", 250)
	if got := utf8.RuneCountInString(store.ClampNote(long)); got != store.NoteMaxRunes {
		t.Fatalf("clamp = %d runes, want %d", got, store.NoteMaxRunes)
	}
	if store.ClampNote("短备注") != "短备注" {
		t.Fatalf("within limit must pass through")
	}

	k := store.ClaudeCurKey(`C:\root1`, "uuid-clamp")
	if err := s.ClaudeCur.Put(store.ClaudeSessionCur{Key: k, ID: "uuid-clamp", Note: long}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.ClaudeCur.GetBatch(store.ClaudeCurPrefix(`C:\root1`))
	if c := got[k]; utf8.RuneCountInString(c.Note) != store.NoteMaxRunes {
		t.Fatalf("stored note = %d runes, want %d", utf8.RuneCountInString(c.Note), store.NoteMaxRunes)
	}

	if err := s.ClaudeCur.Put(store.ClaudeSessionCur{ID: "uuid-x", Note: "缺 Key"}); err == nil {
		t.Fatalf("empty key must be rejected")
	}
	if err := s.ClaudeCur.Put(store.ClaudeSessionCur{Key: k, Note: "缺 id"}); err == nil {
		t.Fatalf("empty id must be rejected")
	}
}

// 书签集钳制（P-20261003-122）：去重 + 升序（RFC3339 字典序=时间序）+ 超上限
// 保最新 + 空串剔除；Put 唯一出口同生效（落盘读取回来的即钳制后形态）
func TestClaudeCurBookmarkClamp(t *testing.T) {
	in := []string{
		"2026-01-01T00:03:00Z",
		"2026-01-01T00:01:00Z",
		"2026-01-01T00:03:00Z", // 重复
		"",                     // 空串剔除
		"2026-01-01T00:02:00Z",
	}
	got := store.ClampBookmarks(in)
	if len(got) != 3 || got[0] != "2026-01-01T00:01:00Z" || got[2] != "2026-01-01T00:03:00Z" {
		t.Fatalf("dedupe+sort: %v", got)
	}
	if store.ClampBookmarks(nil) != nil {
		t.Fatalf("empty in must be nil out")
	}
	// 超上限保最新：时间线上靠后的轮次留任
	var many []string
	for i := 0; i < store.BookmarkMax+10; i++ {
		many = append(many, time.Unix(int64(1700000000+i), 0).UTC().Format(time.RFC3339))
	}
	capped := store.ClampBookmarks(many)
	if len(capped) != store.BookmarkMax || capped[0] != many[10] || capped[store.BookmarkMax-1] != many[len(many)-1] {
		t.Fatalf("cap keeps newest: len=%d first=%v", len(capped), capped[0])
	}

	// Put 出口：写入乱序重复集，读回即钳制后形态
	s := store.New(filestore.New(t.TempDir()))
	k := store.ClaudeCurKey(`C:\root1`, "uuid-bm")
	if err := s.ClaudeCur.Put(store.ClaudeSessionCur{Key: k, ID: "uuid-bm", Bookmarks: in}); err != nil {
		t.Fatal(err)
	}
	gotBatch, _ := s.ClaudeCur.GetBatch(store.ClaudeCurPrefix(`C:\root1`))
	bm := gotBatch[k].Bookmarks
	if len(bm) != 3 || bm[0] != "2026-01-01T00:01:00Z" {
		t.Fatalf("put-level clamp: %v", bm)
	}
}

// 标签集钳制（P-20261003-256）：NormalizeTag 消毒（trim+剥前导 #）+ (At,Tag)
// 精确去重 + (At,Tag) 排序 + 超 TagMax 保最新 + 空对剔除；Put 唯一出口同生效
// （落盘读取回来的即钳制后形态）
func TestClaudeCurTagClamp(t *testing.T) {
	if got := store.NormalizeTag("  #架构 "); got != "架构" {
		t.Fatalf("normalize: %q", got)
	}
	if got := store.NormalizeTag("##修复"); got != "修复" {
		t.Fatalf("normalize multi-hash: %q", got)
	}
	if got := store.NormalizeTag("   "); got != "" {
		t.Fatalf("normalize blank: %q", got)
	}

	in := []store.ClaudeTurnTag{
		{At: "2026-01-01T00:03:00Z", Tag: "修复"},
		{At: "2026-01-01T00:01:00Z", Tag: "架构"},
		{At: "2026-01-01T00:03:00Z", Tag: "修复"},  // 重复对
		{At: "2026-01-01T00:01:00Z", Tag: "架构 "}, // trim 后与第 2 条同名（未消毒原样进入才去不了重—— ClampTags 不再消毒，端点已归一；此处验证去重按原样形态）
		{At: "", Tag: "架构"},                      // 空时刻剔除
		{At: "2026-01-01T00:02:00Z", Tag: "架构"},
	}
	got := store.ClampTags(in)
	if len(got) != 4 || got[0].At != "2026-01-01T00:01:00Z" || got[0].Tag != "架构" || got[3].Tag != "修复" {
		t.Fatalf("dedupe+sort: %+v", got)
	}
	if store.ClampTags(nil) != nil {
		t.Fatalf("empty in must be nil out")
	}
	// 超上限保最新：At 靠后的对留任
	var many []store.ClaudeTurnTag
	for i := 0; i < store.TagMax+10; i++ {
		many = append(many, store.ClaudeTurnTag{
			At:  time.Unix(int64(1700000000+i), 0).UTC().Format(time.RFC3339),
			Tag: "标签",
		})
	}
	capped := store.ClampTags(many)
	if len(capped) != store.TagMax || capped[0].At != many[10].At || capped[store.TagMax-1].At != many[len(many)-1].At {
		t.Fatalf("cap keeps newest: len=%d first=%v", len(capped), capped[0])
	}

	// Put 出口：写入乱序重复集，读回即钳制后形态
	s := store.New(filestore.New(t.TempDir()))
	k := store.ClaudeCurKey(`C:\root1`, "uuid-tag")
	if err := s.ClaudeCur.Put(store.ClaudeSessionCur{Key: k, ID: "uuid-tag", Tags: in}); err != nil {
		t.Fatal(err)
	}
	gotBatch, _ := s.ClaudeCur.GetBatch(store.ClaudeCurPrefix(`C:\root1`))
	tags := gotBatch[k].Tags
	if len(tags) != 4 || tags[0].Tag != "架构" {
		t.Fatalf("put-level clamp: %+v", tags)
	}
}
