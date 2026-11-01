package store_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newAuditTestStore 构造基于临时目录的独立审计仓储（不污染全局 Store）
func newAuditTestStore(t *testing.T) store.AuditLogStore {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return store.NewAuditLogRepo(filestore.New(dir))
}

// failDocStore 仅 Create 恒败的 DocumentStore 假件（读路径走真实 filestore）：
// 模拟数据目录不可写/磁盘满——审计 Append 尽力而为语义下的真实失败形态。
// 内嵌接口字段须持真实后端（零值接口的转发调用会 nil panic）
type failDocStore struct {
	store.DocumentStore
}

func newFailDocStore(t *testing.T) failDocStore {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return failDocStore{DocumentStore: filestore.New(dir)}
}

func (f failDocStore) Create(kind, key string, data []byte) error {
	return errors.New("disk full (injected)")
}

// TestAuditLog_AppendAndListOrder 追加即落盘；List 按时间倒序（最新在前）
func TestAuditLog_AppendAndListOrder(t *testing.T) {
	r := newAuditTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 3; i++ {
		r.Append(store.AuditEvent{
			Time:   base.Add(time.Duration(i) * time.Minute),
			Action: store.AuditUnlock,
			Result: store.AuditResultFailure,
			IP:     "10.0.0.1",
			Detail: "invalid credentials",
		})
	}

	events, total, err := r.List(0, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 3 {
		t.Fatalf("expected total=3, got %d", total)
	}
	// 倒序：最早写的排最后
	if events[0].Time.Before(events[2].Time) {
		t.Errorf("expected descending order, got %v before %v", events[0].Time, events[2].Time)
	}
	if events[0].Action != store.AuditUnlock || events[0].Result != store.AuditResultFailure {
		t.Errorf("unexpected event: %+v", events[0])
	}
	if events[0].IP != "10.0.0.1" || events[0].Detail != "invalid credentials" {
		t.Errorf("metadata lost: %+v", events[0])
	}
}

// TestAuditLog_AppendFillsIDAndTime 未填 ID/Time 时自动补全（append-only 语义）
func TestAuditLog_AppendFillsIDAndTime(t *testing.T) {
	r := newAuditTestStore(t)

	r.Append(store.AuditEvent{Action: store.AuditTokenCreate, Result: store.AuditResultSuccess})
	events, total, _ := r.List(0, 0)
	if total != 1 {
		t.Fatalf("expected total=1, got %d", total)
	}
	if events[0].ID == "" {
		t.Error("expected auto-generated ID")
	}
	if events[0].Time.IsZero() {
		t.Error("expected auto-filled time")
	}
}

// TestAuditLog_ListPagination 倒序分页：offset/limit 切片正确，total 恒为全量
func TestAuditLog_ListPagination(t *testing.T) {
	r := newAuditTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		r.Append(store.AuditEvent{Time: base.Add(time.Duration(i) * time.Minute), Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	}

	page1, total, err := r.List(2, 0)
	if err != nil || total != 5 {
		t.Fatalf("page1: err=%v total=%d", err, total)
	}
	page2, total2, _ := r.List(2, 2)
	if total2 != 5 {
		t.Fatalf("expected total=5, got %d", total2)
	}
	// 跨页拼接还原倒序全序
	all := append(append([]store.AuditEvent{}, page1...), page2...)
	for i := 1; i < len(all); i++ {
		if all[i-1].Time.Before(all[i].Time) {
			t.Fatalf("descending order broken at %d", i)
		}
	}
	// offset 越界返回空页
	empty, _, err := r.List(2, 99)
	if err != nil || len(empty) != 0 {
		t.Fatalf("offset overflow: err=%v len=%d", err, len(empty))
	}
}

// TestAuditLog_ListCursorWalk 键集游标全量行走（P-20261003-223）：跨页拼接
// 还原与 List 完全一致的倒序全序——不重（id 全唯一）、不漏（条数=total）、
// 同刻事件按 ID 破平且次序确定；走完后再取（锚在末条）返回空页
func TestAuditLog_ListCursorWalk(t *testing.T) {
	r := newAuditTestStore(t)

	base := time.Now().Add(-time.Hour)
	// 5 个互异时刻 + 2 条同刻（自定义 ID 控制破平次序，覆盖复合键边界）
	seed := []struct {
		at time.Time
		id string
	}{
		{at: base.Add(4 * time.Minute), id: ""},
		{at: base.Add(3 * time.Minute), id: ""},
		{at: base.Add(2 * time.Minute), id: "tie-b"}, // 同刻：ID 大者排前
		{at: base.Add(2 * time.Minute), id: "tie-a"},
		{at: base.Add(1 * time.Minute), id: ""},
		{at: base, id: ""},
		{at: base.Add(-1 * time.Minute), id: ""},
	}
	for _, s := range seed {
		r.Append(store.AuditEvent{Time: s.at, ID: s.id, Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	}

	want, total, err := r.List(0, 0)
	if err != nil || total != 7 {
		t.Fatalf("seed list: err=%v total=%d", err, total)
	}

	var walked []store.AuditEvent
	afterTime, afterID := time.Time{}, ""
	for {
		page, totalPage, err := r.ListCursor(2, afterTime, afterID)
		if err != nil {
			t.Fatalf("ListCursor: %v", err)
		}
		if totalPage != 7 {
			t.Fatalf("cursor page total=%d, want 7", totalPage)
		}
		walked = append(walked, page...)
		if len(page) == 0 {
			break
		}
		last := page[len(page)-1]
		afterTime, afterID = last.Time, last.ID
	}

	if len(walked) != 7 {
		t.Fatalf("walked %d events, want 7", len(walked))
	}
	seen := map[string]bool{}
	for i, e := range walked {
		if seen[e.ID] {
			t.Errorf("duplicate id %q at walk position %d", e.ID, i)
		}
		seen[e.ID] = true
		if e.ID != want[i].ID {
			t.Errorf("walk position %d: got id %q, want %q (must match List order)", i, e.ID, want[i].ID)
		}
	}
	// 同刻破平次序确定：tie-b（ID 大）在 tie-a 前
	if walked[2].ID != "tie-b" || walked[3].ID != "tie-a" {
		t.Errorf("same-time tiebreak broken: %q before %q", walked[2].ID, walked[3].ID)
	}

	// 锚在末条：空页（末页语义，前端据此停翻）
	empty, total, err := r.ListCursor(2, walked[6].Time, walked[6].ID)
	if err != nil || len(empty) != 0 || total != 7 {
		t.Fatalf("cursor at last: len=%d total=%d err=%v, want 0/7/nil", len(empty), total, err)
	}
}

// TestAuditLog_ListCursorStableAgainstAppend 稳定性核心动机：首页取完后新增
// 更新事件，锚定续页不受头部插入影响——窗口不后移（offset 分页同场景第 2 页
// 会整体后移造成第 1/2 页重复）
func TestAuditLog_ListCursorStableAgainstAppend(t *testing.T) {
	r := newAuditTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 4; i++ {
		r.Append(store.AuditEvent{Time: base.Add(time.Duration(i) * time.Minute), Action: store.AuditTokenCreate, Result: store.AuditResultSuccess})
	}

	page1, total, err := r.ListCursor(2, time.Time{}, "")
	if err != nil || total != 4 || len(page1) != 2 {
		t.Fatalf("page1: err=%v total=%d len=%d", err, total, len(page1))
	}

	// 翻页间隙：两条更新事件插到头部（真实形态：其他用户的操作持续入账）
	now := time.Now()
	r.Append(store.AuditEvent{Time: now, Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	r.Append(store.AuditEvent{Time: now.Add(time.Second), Action: store.AuditUnlock, Result: store.AuditResultSuccess})

	last := page1[len(page1)-1]
	page2, total2, err := r.ListCursor(10, last.Time, last.ID)
	if err != nil || total2 != 6 {
		t.Fatalf("page2: err=%v total=%d", err, total2)
	}
	if len(page2) != 2 {
		t.Fatalf("continuation must hold exactly the 2 events older than the anchor, got %d", len(page2))
	}
	for _, e := range page2 {
		if e.Time.After(last.Time) || (e.Time.Equal(last.Time) && e.ID >= last.ID) {
			t.Errorf("continuation contains event newer than anchor: %+v", e)
		}
	}

	// 旧 offset 口径对照：头部插入 2 条后 offset=2 的窗口整体后移，第 2 页头部
	// 恰是第 1 页头部（跨页重复的病灶本体）——钉住分叉点，游标续页无此形态
	offsetPage2, _, _ := r.List(2, 2)
	if len(offsetPage2) == 0 || offsetPage2[0].ID != page1[0].ID {
		t.Fatalf("offset page2 expected to shift onto page1 head %q (the flaw keyset fixes), got %+v", page1[0].ID, offsetPage2)
	}
}

// TestAuditLog_ListCursorParams limit<=0 回落默认页大小；零游标 = 从头取
func TestAuditLog_ListCursorParams(t *testing.T) {
	r := newAuditTestStore(t)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < 3; i++ {
		r.Append(store.AuditEvent{Time: base.Add(time.Duration(i) * time.Minute), Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	}

	page, total, err := r.ListCursor(0, time.Time{}, "")
	if err != nil {
		t.Fatalf("ListCursor(0): %v", err)
	}
	if len(page) != 3 || total != 3 {
		t.Fatalf("limit<=0 must fall back to default page size, got len=%d total=%d", len(page), total)
	}
}

// TestAuditLog_ListSameTimeOrderStable 同刻条目在两次 List 间的相对次序恒定
// （比较器全序化后 offset 分页的顺带收益）
func TestAuditLog_ListSameTimeOrderStable(t *testing.T) {
	r := newAuditTestStore(t)
	same := time.Now().Add(-time.Hour)
	for i := 0; i < 20; i++ {
		r.Append(store.AuditEvent{Time: same, Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	}
	first, _, err := r.List(0, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	second, _, _ := r.List(0, 0)
	for i := range first {
		if first[i].ID != second[i].ID {
			t.Fatalf("same-time order drifted between calls at %d: %q vs %q", i, first[i].ID, second[i].ID)
		}
	}
	// 且与 ListCursor 的复合序一致（两模式同源比较器）
	cursor, _, _ := r.ListCursor(0, time.Time{}, "")
	for i := range first {
		if first[i].ID != cursor[i].ID {
			t.Fatalf("List and ListCursor disagree at %d: %q vs %q", i, first[i].ID, cursor[i].ID)
		}
	}
}

// TestAuditLog_CleanupBefore 保留裁剪：只删窗口前的，窗口内原样保留
func TestAuditLog_CleanupBefore(t *testing.T) {
	r := newAuditTestStore(t)

	old := time.Now().Add(-31 * 24 * time.Hour)
	fresh := time.Now().Add(-time.Hour)
	r.Append(store.AuditEvent{Time: old, Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	r.Append(store.AuditEvent{Time: fresh, Action: store.AuditUnlock, Result: store.AuditResultSuccess})

	removed, err := r.CleanupBefore(time.Now().Add(-store.AuditRetention))
	if err != nil {
		t.Fatalf("CleanupBefore: %v", err)
	}
	if removed != 1 {
		t.Fatalf("expected 1 removed, got %d", removed)
	}
	_, total, _ := r.List(0, 0)
	if total != 1 {
		t.Fatalf("expected 1 remaining, got %d", total)
	}
}

// TestAuditLog_EnforceMaxEntriesTrimsOldest 条数上限第二道闸（P-20261004-80）
// 全链路：超量注入 5 条（max=3）→ 删最旧 2 条留最新 3 条 → 摘要条目在账
// （audit.prune，Detail 记 pruned/max 元数据）——时间窗内的条目同样按超量
// 走（保留语义 = 时间窗 AND 条数上限，注入条目全部在窗口内即验证此点）
func TestAuditLog_EnforceMaxEntriesTrimsOldest(t *testing.T) {
	r := newAuditTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		r.Append(store.AuditEvent{
			Time:   base.Add(time.Duration(i) * time.Minute),
			Action: store.AuditUnlock,
			Result: store.AuditResultSuccess,
		})
	}

	const max = 3
	removed, err := r.EnforceMaxEntries(max)
	if err != nil {
		t.Fatalf("EnforceMaxEntries: %v", err)
	}
	if removed != 2 {
		t.Fatalf("expected 2 removed, got %d", removed)
	}

	events, total, err := r.List(0, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	// 摘要条目在账：删旧留新之后追加，总条数 = max + 1，且排在最前（最新）
	if total != max+1 {
		t.Fatalf("expected total=%d (max + prune summary), got %d", max+1, total)
	}
	summary := events[0]
	if summary.Action != store.AuditLogPrune || summary.Result != store.AuditResultSuccess {
		t.Fatalf("expected audit.prune summary at head, got %+v", summary)
	}
	if summary.Detail != "pruned=2 max=3" {
		t.Fatalf("unexpected summary detail %q", summary.Detail)
	}
	// 删旧留新：保留的恰是最新 3 条（倒序 t4/t3/t2），最旧 2 条（t0/t1）出清
	if len(events) != 4 {
		t.Fatalf("unexpected list length %d", len(events))
	}
	for i, want := range []time.Time{
		base.Add(4 * time.Minute),
		base.Add(3 * time.Minute),
		base.Add(2 * time.Minute),
	} {
		if !events[i+1].Time.Equal(want) {
			t.Fatalf("kept[%d] = %v, want %v (oldest must go first)", i, events[i+1].Time, want)
		}
	}
}

// TestAuditLog_EnforceMaxEntriesNoopUnderLimit 未超限不动作：零删除、无摘要、
// 原条数不变（每日巡更的常态路径）；max<=0 = 闸门关闭，同样零副作用
func TestAuditLog_EnforceMaxEntriesNoopUnderLimit(t *testing.T) {
	r := newAuditTestStore(t)

	base := time.Now().Add(-time.Hour)
	for i := 0; i < 2; i++ {
		r.Append(store.AuditEvent{Time: base.Add(time.Duration(i) * time.Minute), Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	}

	for _, max := range []int{5, 2, 0, -1} {
		removed, err := r.EnforceMaxEntries(max)
		if err != nil {
			t.Fatalf("EnforceMaxEntries(%d): %v", max, err)
		}
		if removed != 0 {
			t.Fatalf("max=%d: expected 0 removed, got %d", max, removed)
		}
		_, total, _ := r.List(0, 0)
		if total != 2 {
			t.Fatalf("max=%d: expected 2 remaining, got %d", max, total)
		}
		events, _, _ := r.List(0, 0)
		for _, e := range events {
			if e.Action == store.AuditLogPrune {
				t.Fatalf("max=%d: prune summary must not be recorded on no-op", max)
			}
		}
	}
}

// TestAuditLog_ContentNeverRecorded 内容不入账纪律的结构性验证：
// 事件结构只含声明的元数据字段（序列化即持久化形态），不携带任何秘密值字段
func TestAuditLog_ContentNeverRecorded(t *testing.T) {
	r := newAuditTestStore(t)

	r.Append(store.AuditEvent{
		Action: store.AuditTokenCreate,
		Result: store.AuditResultSuccess,
		IP:     "127.0.0.1",
		Detail: "ci (expiresInDays=30)",
	})

	events, total, _ := r.List(0, 0)
	if total != 1 {
		t.Fatalf("expected total=1, got %d", total)
	}
	b, err := json.Marshal(events[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	allowed := map[string]bool{"id": true, "time": true, "action": true, "result": true, "ip": true, "detail": true}
	for k := range m {
		if !allowed[k] {
			t.Errorf("unexpected field %q in audit entry", k)
		}
	}
	if strings.Contains(string(b), "secret") {
		t.Error("audit entry must not carry a secret field")
	}
}

// TestAuditLog_WriteFailuresCounted 写失败可见性计数（P-20261003-205）：
// 尽力而为语义不变——失败不向上传播（Append 无返回值、不 panic），但每次
// 失败累计 +1 并刷新最近失败时刻；成功路径计数恒 0；List 不受失败影响
func TestAuditLog_WriteFailuresCounted(t *testing.T) {
	r := store.NewAuditLogRepo(newFailDocStore(t))

	// 从未失败：计数 0、last 零值
	count, last := r.WriteFailures()
	if count != 0 || !last.IsZero() {
		t.Fatalf("fresh store must report 0 failures and zero time, got count=%d last=%v", count, last)
	}

	// 注入 2 次失败：计数累计 2、last 落在本次测试窗口内（非零值）
	before := time.Now().Add(-time.Second)
	r.Append(store.AuditEvent{Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	r.Append(store.AuditEvent{Action: store.AuditTokenCreate, Result: store.AuditResultSuccess})
	count, last = r.WriteFailures()
	if count != 2 {
		t.Fatalf("expected 2 counted failures, got %d", count)
	}
	if last.IsZero() || last.Before(before) || last.After(time.Now()) {
		t.Fatalf("last failure time %v outside test window [%v, now]", last, before)
	}

	// 事件确实没写入（尽力而为：失败被吞、绝不向上传播——Append 无错误出口）
	// 且失败后仓储仍可用（List 走读路径不受写失败污染）
	if _, total, err := r.List(0, 0); err != nil || total != 0 {
		t.Fatalf("List after failures: err=%v total=%d, want nil/0", err, total)
	}
}

// TestAuditLog_WriteFailuresNotCountedOnSuccess 成功路径不计数：正常落盘后
// 计数保持 0（警示面不出现假阳性）
func TestAuditLog_WriteFailuresNotCountedOnSuccess(t *testing.T) {
	r := newAuditTestStore(t)
	r.Append(store.AuditEvent{Action: store.AuditUnlock, Result: store.AuditResultSuccess})
	count, last := r.WriteFailures()
	if count != 0 || !last.IsZero() {
		t.Fatalf("successful append must not count, got count=%d last=%v", count, last)
	}
}

// ─── 入账脱敏守卫（P-20261005-203）─────────────────────────────────────────

// TestMaskAuditDetail_MasksCredentialForms 命中形态脱敏：键名+分隔符保留、
// 值整段 ***（审计留痕「发生但不带值」，区别于 terminal_history 的整条跳过）；
// 裸云密钥无论是否在赋值右侧都整段替换
func TestMaskAuditDetail_MasksCredentialForms(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"env 赋值形态", "deploy ran DB_PASSWORD=hunter2 up", "deploy ran DB_PASSWORD=*** up"},
		{"双引号值（含空格）", `token="abc 123" rotated`, "token=*** rotated"},
		{"单引号值", `secret='v$1' saved`, "secret=*** saved"},
		{"冒号分隔形态", "api_key: sk-abc123 accepted", "api_key: *** accepted"},
		{"词变体键名（token 后接字符同命中）", "TOKEN_1=xyz count=1", "TOKEN_1=*** count=1"},
		{"裸云密钥", "key AKIAIOSFODNN7EXAMPLE rotated", "key *** rotated"},
		{"赋值右侧裸云密钥（backup 键不在词表，值形态兜住）", "backup=AKIAIOSFODNN7EXAMPLE done", "backup=*** done"},
	}
	for _, tc := range cases {
		if got := store.MaskAuditDetail(tc.in); got != tc.want {
			t.Errorf("%s: MaskAuditDetail(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

// TestMaskAuditDetail_NormalFormsUntouched 正常形态零误伤：路径/host/计数/
// share 短链括号注记等现存 Detail 形态逐字节原样；贴附口令旗标与 PEM 短语
// 是 terminal「整条跳过」语义专属形态（照搬改写会误伤 /projects 类路径文本），
// 在此钉住审计侧不改写的边界
func TestMaskAuditDetail_NormalFormsUntouched(t *testing.T) {
	cases := []struct{ name, in string }{
		{"路径含 token 字样", "file=/etc/tokenizer.conf: 3 hits"},
		{"路径含 secret 段", "myproj: /data/secret-notes → /data/out"},
		{"user@host 形态", "root@build-1 (22)"},
		{"share.view 括号注记 token（base36 对账判据，非赋值形态）", "My Share (9f8e7d6c5b4a3b2c), ua: curl/8.0"},
		{"prune 摘要（系统自有 Detail）", "pruned=123 max=100000"},
		{"纯计数元数据", "3 file(s) replaced, 12 hit(s), backup rb-1"},
		{"非敏感键名（insecure 无敏感词词边界）", "insecure=1 tolerated"},
		{"贴附口令旗标（terminal 跳过语义专属）", "dump ran with -pw0rd1234 flag"},
		{"PEM 短语（terminal 跳过语义专属）", "imported PRIVATE KEY host key"},
		{"空 Detail", ""},
	}
	for _, tc := range cases {
		if got := store.MaskAuditDetail(tc.in); got != tc.in {
			t.Errorf("%s: MaskAuditDetail must not rewrite, got %q", tc.name, got)
		}
	}
}

// TestAuditLog_AppendMasksDetailOnWrite Append 层兜底集成：写入方（模拟下一个
// 带命令原文的写入方）携带凭据赋值形态时落盘读回即已脱敏——写入时脱敏，
// 读侧不动零迁移；正常 Detail 形态原样透传不受影响
func TestAuditLog_AppendMasksDetailOnWrite(t *testing.T) {
	r := newAuditTestStore(t)
	r.Append(store.AuditEvent{
		Action: store.AuditRunbookRun,
		Result: store.AuditResultSuccess,
		Detail: "ran DB_PASSWORD=hunter2 migrate",
	})
	r.Append(store.AuditEvent{
		Action: store.AuditHostCreate,
		Result: store.AuditResultSuccess,
		Detail: "root@build-1 (22)",
	})
	got, total, err := r.List(0, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if total != 2 {
		t.Fatalf("total = %d, want 2", total)
	}
	// List 倒序（最新在前）：后 Append 的 host 形态在前
	if got[0].Detail != "root@build-1 (22)" {
		t.Fatalf("normal detail must pass through unchanged, got %q", got[0].Detail)
	}
	if got[1].Detail != "ran DB_PASSWORD=*** migrate" {
		t.Fatalf("sensitive detail must be masked on append, got %q", got[1].Detail)
	}
}
