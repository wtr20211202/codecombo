package claudesessions

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 策展层单测（P-20261003-67）：星标置顶排序（分页前重排——后页星标进第一屏）、
// 备注并入列表、全文搜索的备注命中源（note-only 追加/已有命中补标识/幽灵防御/
// 项目范围/limit 截断）。fixture 复用列表测试的 write/fixtureJSONL 装配。

// 星标置顶：分页前重排——星标的老会话（无注入时排第 3 页都轮不到）进第一屏，
// 组内保持 LastAt 倒序；Starred/Note 字段并入；Total 不受重排影响
func TestListStarredPinnedAcrossPages(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "s-new", fixtureJSONL("新会话", now.Add(-time.Hour)), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projA`), "s-mid", fixtureJSONL("中间会话", now.Add(-2*time.Hour)), now.Add(-2*time.Hour))
	write(t, root, EncodePath(`D:\projA`), "s-old", fixtureJSONL("老会话", now.Add(-3*time.Hour)), now.Add(-3*time.Hour))

	curation := map[string]store.ClaudeSessionCur{
		"s-old": {ID: "s-old", Starred: true, Note: "那次调 WebSocket 重连"},
	}

	// 无注入：纯时间倒序（既有语义零变化）
	res, err := List(root, `D:\projA`, "", 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Sessions[0].ID != "s-new" || res.Sessions[0].Starred {
		t.Fatalf("baseline order must be untouched: %+v", res.Sessions)
	}

	// 注入后：星标置顶（分页前），第一页 = [s-old, s-new]
	res, err = List(root, `D:\projA`, "", 2, 0, curation)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 3 {
		t.Fatalf("total must count all: %d", res.Total)
	}
	if res.Sessions[0].ID != "s-old" || !res.Sessions[0].Starred || res.Sessions[0].Note != "那次调 WebSocket 重连" {
		t.Fatalf("starred must pin first with note: %+v", res.Sessions)
	}
	if res.Sessions[1].ID != "s-new" {
		t.Fatalf("unstarred keeps recency order: %+v", res.Sessions)
	}
	// 第二页继续普通组
	res2, _ := List(root, `D:\projA`, "", 2, 2, curation)
	if len(res2.Sessions) != 1 || res2.Sessions[0].ID != "s-mid" {
		t.Fatalf("page 2: %+v", res2.Sessions)
	}

	// 索引路径同语义
	ix2 := NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
	if _, err := ix2.List("", 10, 0); err != nil { // 先建索引
		t.Fatal(err)
	}
	res3, err := ix2.List(`D:\projA`, 2, 0, curation)
	if err != nil {
		t.Fatal(err)
	}
	if res3.Sessions[0].ID != "s-old" || !res3.Sessions[0].Starred {
		t.Fatalf("index path pinning: %+v", res3.Sessions)
	}
}

// 多条星标：置顶组内部保持 LastAt 倒序（稳定重排不搅乱组内序）
func TestStarredGroupKeepsRecency(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "a-1h", fixtureJSONL("一", now.Add(-time.Hour)), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projA`), "b-4h", fixtureJSONL("二", now.Add(-4*time.Hour)), now.Add(-4*time.Hour))
	write(t, root, EncodePath(`D:\projA`), "c-2h", fixtureJSONL("三", now.Add(-2*time.Hour)), now.Add(-2*time.Hour))

	curation := map[string]store.ClaudeSessionCur{
		"a-1h": {ID: "a-1h", Starred: true},
		"b-4h": {ID: "b-4h", Starred: true},
	}
	res, err := List(root, `D:\projA`, "", 10, 0, curation)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{res.Sessions[0].ID, res.Sessions[1].ID, res.Sessions[2].ID}
	want := []string{"a-1h", "b-4h", "c-2h"} // 星标组内 1h > 4h，普通组在后
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

// FetchCuration 回归：repo 层以文档键为键，FetchCuration 必须按会话 id 重键
// （否则列表/搜索按 id 的查找全部落空——e2e 首轮抓到的集成缺口）
func TestFetchCurationRekeysByID(t *testing.T) {
	root := t.TempDir()
	cur := store.New(filestore.New(t.TempDir())).ClaudeCur
	if err := cur.Put(store.ClaudeSessionCur{
		Key:     store.ClaudeCurKey(root, "id-a"),
		ID:      "id-a",
		Starred: true,
		Note:    "备注",
	}); err != nil {
		t.Fatal(err)
	}

	got := FetchCuration(cur, root)
	if len(got) != 1 {
		t.Fatalf("fetch = %v", got)
	}
	c, ok := got["id-a"] // 按会话 id 直查（文档键取不到）
	if !ok || !c.Starred || c.Note != "备注" {
		t.Fatalf("must rekey by session id: %+v", got)
	}

	// 防 御路径：repo nil / root 空 → nil，不 panic 不阻断
	if FetchCuration(nil, root) != nil || FetchCuration(cur, "") != nil {
		t.Fatalf("nil repo / empty root must yield nil")
	}
}

// 全文搜索的备注命中源：已有命中补 Note；note-only 追加（元数据取索引条目）；
// 无索引条目不产幽灵命中；limit 截断如实上报
func TestMergeNoteHits(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	kw := "websocket-reconnect"
	// 命中会话：transcript 含关键词（备注也命中 → 补标识）
	write(t, root, EncodePath(`D:\projA`), "hit-1",
		fixtureJSONL("命中会话 "+kw, now.Add(-time.Hour)), now.Add(-time.Hour))
	// note-only 会话：transcript 无关键词
	write(t, root, EncodePath(`D:\projB`), "note-only",
		fixtureJSONLCwd("备注会话", now.Add(-2*time.Hour), `D:\projB`), now.Add(-2*time.Hour))
	// 幽灵会话：有备注、transcript 已消失（索引也不会有）
	ghostID := "ghost-gone"

	curation := map[string]store.ClaudeSessionCur{
		"hit-1":     {ID: "hit-1", Note: "顺便记一笔 " + kw},
		"note-only": {ID: "note-only", Note: "关于 " + kw + " 重连的完整方案记在这里"},
		ghostID:     {ID: ghostID, Note: "孤儿备注 " + kw},
	}

	ix := NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
	if _, err := ix.List("", 10, 0); err != nil { // 先建索引（note-only 的元数据源）
		t.Fatal(err)
	}
	// 多轮合并：map 遍历序随机，「note-only 先 append（触发扩容搬迁）→ 已有命中
	// 后 enrich」的顺序曾致经旧指针的写入静默丢失（wsl-verify Linux 首跑抓到）——
	// 富化按 Hits 下标后每轮都必须成立
	for round := 0; round < 50; round++ {
		res := ix.Search("", kw, 10)
		ix.MergeNoteHits(&res, curation, "", kw, 10)
		if len(res.Hits) != 2 {
			t.Fatalf("round %d hits = %d, want 2: %+v", round, len(res.Hits), res.Hits)
		}
		if res.Hits[0].SessionID != "hit-1" {
			t.Fatalf("round %d transcript hit first: %+v", round, res.Hits)
		}
		if res.Hits[0].Note == "" || res.Hits[0].Lines[0].Text == "" {
			t.Fatalf("round %d existing hit enriched with note: %+v", round, res.Hits[0])
		}
		no := res.Hits[1]
		if no.SessionID != "note-only" || len(no.Lines) != 0 || no.Note == "" {
			t.Fatalf("round %d note-only hit: %+v", round, no)
		}
		if no.Title != "备注会话" || no.Cwd != `D:\projB` {
			t.Fatalf("round %d note-only metadata from index: %+v", round, no)
		}
		if no.Active {
			t.Fatalf("aged fixture must not be active: %+v", no)
		}
		for _, h := range res.Hits {
			if h.SessionID == ghostID {
				t.Fatalf("round %d ghost curation must not surface: %+v", round, h)
			}
		}
	}

	// limit 截断如实上报
	resLim := ix.Search("", kw, 10)
	ix.MergeNoteHits(&resLim, curation, "", kw, 1)
	if len(resLim.Hits) != 1 || !resLim.Truncated {
		t.Fatalf("limit truncation: %+v", resLim)
	}
}

// 项目级范围：目录归属不符的备注命中不并入；归属相符的正常并入
func TestMergeNoteHitsProjectScope(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	kw := "sidebar-pinning"
	write(t, root, EncodePath(`D:\projA`), "in-proj",
		fixtureJSONLCwd("A 项目会话", now.Add(-time.Hour), `D:\projA`), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projB`), "out-proj",
		fixtureJSONLCwd("B 项目会话", now.Add(-2*time.Hour), `D:\projB`), now.Add(-2*time.Hour))

	curation := map[string]store.ClaudeSessionCur{
		"in-proj":  {ID: "in-proj", Note: "侧栏置顶 " + kw},
		"out-proj": {ID: "out-proj", Note: "别的项目 " + kw},
	}

	ix := NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
	if _, err := ix.List("", 10, 0); err != nil {
		t.Fatal(err)
	}
	res := ix.Search(`D:\projA`, kw, 10)
	ix.MergeNoteHits(&res, curation, `D:\projA`, kw, 10)
	if len(res.Hits) != 1 || res.Hits[0].SessionID != "in-proj" {
		t.Fatalf("project scope must filter note hits: %+v", res.Hits)
	}
}

// ---- 隐藏/恢复（P-20261003-112）：索引层清理，transcript 文件零触碰 ----

// 列表默认排除 hidden：双路径（全量扫描 / 可重建索引）同语义；Total 不含隐藏
// 行（分页名额不被隐藏行占用）；隐藏与星标并存时隐藏胜出（先剔除后置顶）
func TestListDropsHidden(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "h-new", fixtureJSONL("要隐藏的新会话", now.Add(-time.Hour)), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projA`), "keep", fixtureJSONL("保留会话", now.Add(-2*time.Hour)), now.Add(-2*time.Hour))
	write(t, root, EncodePath(`D:\projA`), "h-star", fixtureJSONL("隐藏且星标", now.Add(-3*time.Hour)), now.Add(-3*time.Hour))

	curation := map[string]store.ClaudeSessionCur{
		"h-new":  {ID: "h-new", Hidden: true},
		"h-star": {ID: "h-star", Hidden: true, Starred: true}, // 隐藏 + 星标并存：隐藏胜出
	}

	// 全量扫描路径
	res, err := List(root, `D:\projA`, "", 10, 0, curation)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Sessions) != 1 || res.Sessions[0].ID != "keep" || res.Total != 1 {
		t.Fatalf("hidden rows must drop from scan list: %+v", res)
	}
	// 索引路径
	ix := NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
	if _, err := ix.List(`D:\projA`, 10, 0); err != nil {
		t.Fatal(err)
	}
	res2, err := ix.List(`D:\projA`, 10, 0, curation)
	if err != nil {
		t.Fatal(err)
	}
	if len(res2.Sessions) != 1 || res2.Sessions[0].ID != "keep" || res2.Total != 1 {
		t.Fatalf("hidden rows must drop from index list: %+v", res2)
	}
}

// 索引重扫尊重 hidden 不复活：隐藏后文件再变更（mtime 变化触发重读重建条目），
// 默认列表仍排除——hidden 存策展层（用户自域），索引重扫重建的是镜像不碰它
func TestRescanRespectsHidden(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "rescan-h", fixtureJSONL("隐藏后仍被改写", now.Add(-time.Hour)), now.Add(-time.Hour))
	curation := map[string]store.ClaudeSessionCur{"rescan-h": {ID: "rescan-h", Hidden: true}}

	ix := NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
	if _, err := ix.List(`D:\projA`, 10, 0); err != nil {
		t.Fatal(err)
	}
	if res, _ := ix.List(`D:\projA`, 10, 0, curation); len(res.Sessions) != 0 {
		t.Fatalf("hidden must drop before rescan: %+v", res.Sessions)
	}

	// transcript 被 claude --resume 续写（mtime/size 变化 → 条目重建）
	write(t, root, EncodePath(`D:\projA`), "rescan-h",
		fixtureJSONL("隐藏后仍被改写", now.Add(-time.Minute)), now.Add(-time.Minute))
	if res, _ := ix.List(`D:\projA`, 10, 0, curation); len(res.Sessions) != 0 {
		t.Fatalf("rescanned hidden row must not resurrect: %+v", res.Sessions)
	}
	// 管理视图仍可见（恢复入口活着，文件零触碰可逆）
	if rows := ix.ListHidden(`D:\projA`, curation); len(rows) != 1 || !rows[0].Hidden {
		t.Fatalf("management view must keep rescanned hidden row: %+v", rows)
	}
}

// 管理视图：只返回隐藏 ∩ 索引条目（孤儿隐藏策展不产幽灵行）；LastAt 倒序；
// 星标/备注并入；冷索引退化空表
func TestListHiddenManagementView(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	write(t, root, EncodePath(`D:\projA`), "hid-old", fixtureJSONLCwd("早的隐藏", now.Add(-3*time.Hour), `D:\projA`), now.Add(-3*time.Hour))
	write(t, root, EncodePath(`D:\projA`), "hid-new", fixtureJSONLCwd("晚的隐藏", now.Add(-time.Hour), `D:\projA`), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projA`), "visible", fixtureJSONLCwd("未隐藏", now.Add(-2*time.Hour), `D:\projA`), now.Add(-2*time.Hour))

	curation := map[string]store.ClaudeSessionCur{
		"hid-new":  {ID: "hid-new", Hidden: true, Note: "废弃实验"},
		"hid-old":  {ID: "hid-old", Hidden: true},
		"visible":  {ID: "visible", Hidden: false},
		"orphan-x": {ID: "orphan-x", Hidden: true}, // transcript 已消失
	}

	// 冷索引：空表不报错
	ix := NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
	if rows := ix.ListHidden(`D:\projA`, curation); len(rows) != 0 {
		t.Fatalf("cold index must yield empty view: %+v", rows)
	}
	// 建索引后：孤儿退场、未隐藏退场、隐藏按 LastAt 倒序、字段并入
	if _, err := ix.List(`D:\projA`, 10, 0); err != nil {
		t.Fatal(err)
	}
	rows := ix.ListHidden(`D:\projA`, curation)
	if len(rows) != 2 {
		t.Fatalf("hidden view = %d rows, want 2: %+v", len(rows), rows)
	}
	if rows[0].ID != "hid-new" || rows[1].ID != "hid-old" {
		t.Fatalf("hidden view order: %+v", rows)
	}
	if rows[0].Note != "废弃实验" || !rows[0].Hidden {
		t.Fatalf("hidden view fields: %+v", rows[0])
	}
	// 项目级范围：别的目录的隐藏行不越界
	write(t, root, EncodePath(`D:\projB`), "hid-b", fixtureJSONLCwd("B 的隐藏", now.Add(-time.Hour), `D:\projB`), now.Add(-time.Hour))
	if _, err := ix.List(`D:\projB`, 10, 0); err != nil {
		t.Fatal(err)
	}
	if rows := ix.ListHidden(`D:\projA`, curation); len(rows) != 2 {
		t.Fatalf("project scope must not leak other dirs: %+v", rows)
	}
}

// 检索默认排除 hidden：transcript 命中与备注命中同口径退场
func TestSearchDropsHidden(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	kw := "secret-experiment"
	write(t, root, EncodePath(`D:\projA`), "hit-hidden", fixtureJSONL("含 "+kw+" 的隐藏会话", now.Add(-time.Hour)), now.Add(-time.Hour))
	write(t, root, EncodePath(`D:\projA`), "hit-keep", fixtureJSONL("含 "+kw+" 的保留会话", now.Add(-2*time.Hour)), now.Add(-2*time.Hour))

	curation := map[string]store.ClaudeSessionCur{
		"hit-hidden": {ID: "hit-hidden", Hidden: true, Note: "备注也提 " + kw},
		"hit-keep":   {ID: "hit-keep"},
	}

	ix := NewIndex(store.New(filestore.New(t.TempDir())).ClaudeIndex, root)
	if _, err := ix.List(`D:\projA`, 10, 0); err != nil {
		t.Fatal(err)
	}
	res := ix.Search(`D:\projA`, kw, 10)
	DropHiddenHits(&res, curation)
	ix.MergeNoteHits(&res, curation, `D:\projA`, kw, 10)
	if len(res.Hits) != 1 || res.Hits[0].SessionID != "hit-keep" {
		t.Fatalf("hidden session must drop from search (transcript + note): %+v", res.Hits)
	}
}

// VisibleEntries 日报口径：索引条目剔除隐藏会话（活跃数与 token 同源消费）
func TestVisibleEntriesDropsHidden(t *testing.T) {
	batch := map[string]store.ClaudeIndexEntry{
		"k1": {Key: "k1", ID: "visible-e"},
		"k2": {Key: "k2", ID: "hidden-e"},
	}
	curation := map[string]store.ClaudeSessionCur{"hidden-e": {ID: "hidden-e", Hidden: true}}
	out := VisibleEntries(batch, curation)
	if len(out) != 1 || out[0].ID != "visible-e" {
		t.Fatalf("visible entries must drop hidden: %+v", out)
	}
	// 空策展：全量直返
	if out := VisibleEntries(batch, nil); len(out) != 2 {
		t.Fatalf("nil curation must keep all: %+v", out)
	}
}
