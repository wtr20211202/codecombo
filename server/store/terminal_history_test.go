package store_test

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

func newTerminalHistoryTestStore(t *testing.T) *store.Store {
	t.Helper()
	doc := filestore.New(filepath.Join(t.TempDir(), "data"))
	return store.New(doc)
}

func TestTerminalHistoryAppendSearchClear(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	entries := []store.HistoryEntry{
		{Command: "go build ./...", ExitCode: 0, DurationMs: 1200, At: time.Now()},
		{Command: "go test ./...", ExitCode: 1, DurationMs: 3400, At: time.Now()},
		{Command: "npm run dev", ExitCode: 0, DurationMs: 500, At: time.Now()},
	}
	for _, e := range entries {
		if err := s.TerminalHistory.Append("p1", e); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	// 全量：倒序最新在前
	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(got))
	}
	if got[0].Command != "npm run dev" || got[2].Command != "go build ./..." {
		t.Errorf("expected newest-first order, got [%s, %s, %s]", got[0].Command, got[1].Command, got[2].Command)
	}

	// q 包含匹配（大小写不敏感）
	got, err = s.TerminalHistory.Search("p1", "GO TEST", false, "")
	if err != nil || len(got) != 1 || got[0].Command != "go test ./..." {
		t.Errorf("q filter mismatch: %v, %v", got, err)
	}

	// failedOnly：仅 exitCode!=0
	got, err = s.TerminalHistory.Search("p1", "", true, "")
	if err != nil || len(got) != 1 || got[0].Command != "go test ./..." {
		t.Errorf("failedOnly filter mismatch: %v, %v", got, err)
	}

	// 项目隔离：另一项目独立
	got, err = s.TerminalHistory.Search("p2", "", false, "")
	if err != nil || len(got) != 0 {
		t.Errorf("expected empty for other project: %v, %v", got, err)
	}

	// Clear 后为空
	if err := s.TerminalHistory.Clear("p1"); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	got, err = s.TerminalHistory.Search("p1", "", false, "")
	if err != nil || len(got) != 0 {
		t.Errorf("expected empty after clear: %v, %v", got, err)
	}
}

func TestTerminalHistorySensitiveSkipped(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	sensitive := []string{
		"export FOO=token123",                          // token 前缀变体
		"curl -H 'Authorization: Bearer secret-x' url", // secret
		"mysql -h db -uroot -pMyPass123 dbname",        // -p 内联密码
		"export API_KEY=sk-12345",                      // api[_-]?key
		"echo AKIAIOSFODNN7EXAMPLE",                    // AWS Access Key
		"echo PRIVATE KEY here",                        // 私钥
		"docker login -phunter2 user",                  // docker 内联密码（-p<pass>）
	}
	for _, cmd := range sensitive {
		if !store.IsSensitiveCommand(cmd) {
			t.Errorf("expected %q to be sensitive", cmd)
		}
		if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: cmd}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	// 非敏感对照
	normal := "echo hello world && ls -la"
	if store.IsSensitiveCommand(normal) {
		t.Errorf("expected %q to be non-sensitive", normal)
	}
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: normal}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 1 || got[0].Command != normal {
		t.Errorf("expected only non-sensitive entry persisted, got %d entries", len(got))
	}
}

func TestTerminalHistoryLRULimit(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	total := store.TerminalHistoryMax + 7
	for i := 0; i < total; i++ {
		err := s.TerminalHistory.Append("p1", store.HistoryEntry{
			Command:  fmt.Sprintf("cmd-%04d", i),
			ExitCode: 0,
		})
		if err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}
	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != store.TerminalHistoryMax {
		t.Fatalf("expected %d entries, got %d", store.TerminalHistoryMax, len(got))
	}
	// 最新在前：头 = 最后追加的，尾 = 被保留的最旧一条（前 7 条被丢弃）
	if !strings.HasPrefix(got[0].Command, "cmd-0506") {
		t.Errorf("expected newest cmd-0506 first, got %s", got[0].Command)
	}
	if !strings.HasPrefix(got[len(got)-1].Command, "cmd-0007") {
		t.Errorf("expected oldest retained cmd-0007 last, got %s", got[len(got)-1].Command)
	}
}

func TestTerminalHistoryConcurrentAppend(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	const n = 100
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.TerminalHistory.Append("p1", store.HistoryEntry{
				Command: fmt.Sprintf("concurrent-%03d", i),
			}); err != nil {
				t.Errorf("Append %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != n {
		t.Fatalf("concurrent append lost entries: expected %d, got %d", n, len(got))
	}
	// 每条都在（顺序因并发不定）
	seen := map[string]bool{}
	for _, e := range got {
		seen[e.Command] = true
	}
	for i := 0; i < n; i++ {
		cmd := fmt.Sprintf("concurrent-%03d", i)
		if !seen[cmd] {
			t.Errorf("entry %s missing", cmd)
		}
	}
}

// TestTerminalHistoryTruncatedMark 达 8KB 截断上限的命令追加 "..." 标记（防残缺命令被误重跑）
func TestTerminalHistoryTruncatedMark(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	// 8190 字节（触界视为已截断）：追加标记
	long := strings.Repeat("a", 8190)
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: long}); err != nil {
		t.Fatalf("Append truncated: %v", err)
	}
	// 常规短命令：不加标记
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: "echo hi"}); err != nil {
		t.Fatalf("Append normal: %v", err)
	}

	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	// 倒序：got[0]=最新（echo hi），got[1]=最旧（截断长命令）
	if !strings.HasSuffix(got[1].Command, "...") || len(got[1].Command) != 8193 {
		t.Errorf("expected 8190-byte command marked with '...', got len=%d", len(got[1].Command))
	}
	if got[0].Command != "echo hi" || strings.HasSuffix(got[0].Command, "...") {
		t.Errorf("normal command should not be marked: %q", got[0].Command)
	}
}

func TestTerminalHistoryDeleteEntry(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	for _, cmd := range []string{"one", "two", "three"} {
		if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: cmd}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	// 倒序下标 0 = 最新（three）
	if err := s.TerminalHistory.DeleteEntry("p1", 0); err != nil {
		t.Fatalf("DeleteEntry: %v", err)
	}
	got, _ := s.TerminalHistory.Search("p1", "", false, "")
	if len(got) != 2 || got[0].Command != "two" || got[1].Command != "one" {
		t.Errorf("unexpected entries after delete: %+v", got)
	}

	// 越界返回 ErrNotFound
	if err := s.TerminalHistory.DeleteEntry("p1", 5); err != store.ErrNotFound {
		t.Errorf("expected ErrNotFound for out-of-range idx, got %v", err)
	}

	// 清空后 DeleteEntry 幂等：空历史越界也 ErrNotFound
	_ = s.TerminalHistory.Clear("p1")
	if err := s.TerminalHistory.DeleteEntry("p1", 0); err != store.ErrNotFound {
		t.Errorf("expected ErrNotFound on empty history, got %v", err)
	}
}

// TestTerminalHistoryDeleteEntryAt 身份删除（P-20261003-63 面板条目删除）：
// 按 at 精确命中、其余保留；快照后并发追加不下标漂移（身份删除的核心动机）；
// 未知/零值 at 拒绝；全清后不残留可删条目
func TestTerminalHistoryDeleteEntryAt(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	base := time.Now()
	for i, cmd := range []string{"one", "two", "three"} {
		if err := s.TerminalHistory.Append("p1", store.HistoryEntry{
			Command: cmd, At: base.Add(time.Duration(i+1) * time.Millisecond), // at 互异（身份键唯一前提）
		}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	// 目标 at 从 Search 出口取（与面板 GET 快照同一来源，经 filestore JSON 往返）
	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	var target store.HistoryEntry
	for _, e := range got {
		if e.Command == "two" {
			target = e
		}
	}
	if target.Command != "two" {
		t.Fatalf("target entry not in list: %+v", got)
	}

	if err := s.TerminalHistory.DeleteEntryAt("p1", target.At); err != nil {
		t.Fatalf("DeleteEntryAt: %v", err)
	}
	got, _ = s.TerminalHistory.Search("p1", "", false, "")
	if len(got) != 2 || got[0].Command != "three" || got[1].Command != "one" {
		t.Errorf("expected two/three retained after identity delete, got %+v", got)
	}

	// 快照后并发追加（倒序头部插行、下标全位移）：身份删除仍精确命中，
	// 新条目不受影响——下标语义在这里会错删 three
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: "four", At: base.Add(time.Second)}); err != nil {
		t.Fatalf("Append four: %v", err)
	}
	if err := s.TerminalHistory.DeleteEntryAt("p1", got[0].At); err != nil { // got[0]=three
		t.Fatalf("DeleteEntryAt after append: %v", err)
	}
	got, _ = s.TerminalHistory.Search("p1", "", false, "")
	if len(got) != 2 || got[0].Command != "four" || got[1].Command != "one" {
		t.Errorf("expected four/one retained, got %+v", got)
	}

	// 未知 at → ErrNotFound；零值 at → ErrInvalidArg
	if err := s.TerminalHistory.DeleteEntryAt("p1", base.Add(9*time.Hour)); err != store.ErrNotFound {
		t.Errorf("expected ErrNotFound for unknown at, got %v", err)
	}
	if err := s.TerminalHistory.DeleteEntryAt("p1", time.Time{}); err != store.ErrInvalidArg {
		t.Errorf("expected ErrInvalidArg for zero at, got %v", err)
	}

	// 全清互不干扰：Clear 后按 at 删无残留可命中
	_ = s.TerminalHistory.Clear("p1")
	if err := s.TerminalHistory.DeleteEntryAt("p1", got[0].At); err != store.ErrNotFound {
		t.Errorf("expected ErrNotFound after clear, got %v", err)
	}
}

// 双挂接/多标签重复上报去重：同一 D 事件经多条 WS 各上报一次（指纹相同、
// 间隔毫秒级），store 层 2s 窗口内幂等跳过；窗口外的真实重复执行照常入史
func TestTerminalHistoryAppendDeduplicatesDuplicateDelivery(t *testing.T) {
	s := newTerminalHistoryTestStore(t)
	now := time.Now()

	first := store.HistoryEntry{Command: "ping -n 9 x | Out-Null", ExitCode: 0, DurationMs: 8187, At: now}
	second := store.HistoryEntry{Command: "ping -n 9 x | Out-Null", ExitCode: 0, DurationMs: 8187, At: now.Add(4 * time.Millisecond)}
	if err := s.TerminalHistory.Append("p", first); err != nil {
		t.Fatal(err)
	}
	if err := s.TerminalHistory.Append("p", second); err != nil {
		t.Fatal(err)
	}
	got, err := s.TerminalHistory.Search("p", "", false, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("duplicate delivery should collapse to 1 entry, got %d", len(got))
	}

	// 窗口外（>2s）同指纹：真实重复执行，照常入史
	later := store.HistoryEntry{Command: "ping -n 9 x | Out-Null", ExitCode: 0, DurationMs: 8187, At: now.Add(5 * time.Second)}
	if err := s.TerminalHistory.Append("p", later); err != nil {
		t.Fatal(err)
	}
	got2, _ := s.TerminalHistory.Search("p", "", false, "")
	if len(got2) != 2 {
		t.Fatalf("out-of-window repeat should append, got %d", len(got2))
	}

	// 同窗口内不同 durationMs：不同次执行，两条都留
	other := store.HistoryEntry{Command: "ping -n 9 x | Out-Null", ExitCode: 0, DurationMs: 7100, At: now.Add(10 * time.Millisecond)}
	if err := s.TerminalHistory.Append("p", other); err != nil {
		t.Fatal(err)
	}
	got3, _ := s.TerminalHistory.Search("p", "", false, "")
	if len(got3) != 3 {
		t.Fatalf("different duration should append, got %d", len(got3))
	}
}

// TestTerminalHistorySearchAll 跨项目聚合检索（P-20261004-2）：双项目命中、
// 大小写不敏感、全局时间倒序、limit 截断与封顶
func TestTerminalHistorySearchAll(t *testing.T) {
	s := newTerminalHistoryTestStore(t)

	base := time.Now().Add(-time.Hour)
	entries := []struct {
		proj string
		e    store.HistoryEntry
	}{
		{"p1", store.HistoryEntry{Command: "docker compose up -d", ExitCode: 0, At: base}},
		{"p1", store.HistoryEntry{Command: "go test ./...", ExitCode: 1, At: base.Add(time.Minute)}},
		{"p2", store.HistoryEntry{Command: "DOCKER ps", ExitCode: 0, At: base.Add(2 * time.Minute)}},
		{"p2", store.HistoryEntry{Command: "npm run build", ExitCode: 0, At: base.Add(3 * time.Minute)}},
	}
	for _, it := range entries {
		if err := s.TerminalHistory.Append(it.proj, it.e); err != nil {
			t.Fatalf("Append %s: %v", it.proj, err)
		}
	}

	// 双项目命中：q 大小写不敏感，全局时间倒序（p2 的 DOCKER ps 最新在前）
	got, err := s.TerminalHistory.SearchAll("docker", 0, nil)
	if err != nil {
		t.Fatalf("SearchAll: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 hits across projects, got %d: %+v", len(got), got)
	}
	if got[0].ProjectID != "p2" || got[0].Command != "DOCKER ps" {
		t.Errorf("expected newest p2 hit first, got %+v", got[0])
	}
	if got[1].ProjectID != "p1" || got[1].Command != "docker compose up -d" {
		t.Errorf("expected older p1 hit second, got %+v", got[1])
	}

	// 命中带退出码与时间戳（失败溯源语义）
	if got[0].ExitCode != 0 {
		t.Errorf("exit code not carried: %+v", got[0])
	}
	if !got[0].At.Equal(base.Add(2 * time.Minute)) {
		t.Errorf("timestamp not carried: %+v", got[0])
	}

	// limit 截断：全局倒序取最新的 N 条
	got, err = s.TerminalHistory.SearchAll("", 3, nil)
	if err != nil {
		t.Fatalf("SearchAll limit: %v", err)
	}
	if len(got) != 3 || got[0].Command != "npm run build" {
		t.Errorf("expected 3 newest entries, got %+v", got)
	}

	// limit 超上限封顶：>200 收敛为 200
	got, err = s.TerminalHistory.SearchAll("", 9999, nil)
	if err != nil {
		t.Fatalf("SearchAll clamp: %v", err)
	}
	if len(got) != 4 { // 4 < 200：封顶不误伤小数据集
		t.Errorf("clamp should not affect small dataset, got %d", len(got))
	}

	// 无命中：空切片非 nil
	got, err = s.TerminalHistory.SearchAll("no-such-command", 0, nil)
	if err != nil || got == nil || len(got) != 0 {
		t.Errorf("expected empty non-nil result, got %v, %v", got, err)
	}
}

// 会话归属（P-20261004-35）：Append 带 terminalId 落盘、Search 按 terminalID
// 过滤、未归属旧条目只在空值查询出现（「未归属」组语义）
func TestTerminalHistorySessionAttribution(t *testing.T) {
	s := newTerminalHistoryTestStore(t)
	base := time.Now().Add(-time.Hour)

	entries := []store.HistoryEntry{
		{Command: "go build ./...", ExitCode: 0, DurationMs: 1200, At: base, TerminalID: "term-A"},
		{Command: "go test ./...", ExitCode: 1, DurationMs: 3400, At: base.Add(time.Minute), TerminalID: "term-A"},
		{Command: "npm run lint", ExitCode: 0, DurationMs: 800, At: base.Add(2 * time.Minute), TerminalID: "term-B"},
		{Command: "make old", ExitCode: 0, DurationMs: 90, At: base.Add(3 * time.Minute)}, // 无归属（旧条目形态）
	}
	for _, e := range entries {
		if err := s.TerminalHistory.Append("p1", e); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	// 按会话过滤：term-A 只出 2 条，倒序最新在前
	got, err := s.TerminalHistory.Search("p1", "", false, "term-A")
	if err != nil {
		t.Fatalf("Search term-A: %v", err)
	}
	if len(got) != 2 || got[0].Command != "go test ./..." || got[1].Command != "go build ./..." {
		t.Fatalf("expected term-A newest-first 2 entries, got %+v", got)
	}

	// 过滤与 failedOnly / q 叠加：term-A 内仅失败
	got, err = s.TerminalHistory.Search("p1", "", true, "term-A")
	if err != nil || len(got) != 1 || got[0].Command != "go test ./..." {
		t.Fatalf("failedOnly+terminalID mismatch: %v, %+v", err, got)
	}

	// 空值 = 全部（含未归属 4 条）；未归属条目不被任何会话过滤命中
	got, err = s.TerminalHistory.Search("p1", "", false, "")
	if err != nil || len(got) != 4 {
		t.Fatalf("empty terminalID should return all incl. unattributed, got %d, %v", len(got), err)
	}

	// 未归属条目 TerminalID 保持空串（前端「未归属」组据此归组）
	for _, e := range got {
		if e.Command == "make old" && e.TerminalID != "" {
			t.Errorf("legacy entry should stay unattributed, got %+v", e)
		}
	}
}

// 旧数据零迁移兼容（P-20261004-35 升级兼容纪律）：升级前落盘的 JSON 条目
// 无 terminalId 字段，新二进制读取后空串即「未归属」组，读写往返不丢不炸
func TestTerminalHistoryLegacyEntriesWithoutTerminalID(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	doc := filestore.New(dir)
	s := store.New(doc)

	// 直接以升级前的 JSON 形态（无 terminalId 键）写文档，模拟旧数据面
	legacy := `[{"command":"go vet ./...","exitCode":0,"durationMs":1500,"at":"2026-01-02T03:04:05.123456789Z"}]`
	if err := doc.Create("terminal_history", "p1", []byte(legacy)); err != nil {
		t.Fatalf("seed legacy doc: %v", err)
	}

	// 读：旧条目照常出列，TerminalID 归空（未归属组）
	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil || len(got) != 1 || got[0].Command != "go vet ./..." {
		t.Fatalf("legacy entry readable: %v, %+v", err, got)
	}
	if got[0].TerminalID != "" {
		t.Errorf("legacy entry must be unattributed, got %q", got[0].TerminalID)
	}
	// 会话过滤对旧条目天然不命中
	if got, _ := s.TerminalHistory.Search("p1", "", false, "term-x"); len(got) != 0 {
		t.Errorf("session filter must exclude legacy entries, got %+v", got)
	}

	// 写：旧条目 + 新归属条目共存一文档，Append 后旧条目形态不被改写
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{
		Command: "echo new", ExitCode: 0, DurationMs: 10,
		At: time.Now(), TerminalID: "term-new",
	}); err != nil {
		t.Fatalf("Append onto legacy doc: %v", err)
	}
	got, err = s.TerminalHistory.Search("p1", "", false, "")
	if err != nil || len(got) != 2 {
		t.Fatalf("mixed doc readable: %v, %d", err, len(got))
	}
	data, err := doc.Get("terminal_history", "p1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"command":"go vet ./..."`) {
		t.Errorf("legacy entry lost after rewrite: %s", data)
	}
}

// 来源与主机键（P-20261005-188）：输入域条目 Append 带 source/host 落盘、
// SearchAll 透传；去重指纹纳入 Source/Host——多主机并行运维在 2s 窗口内
// 各提交同命令（0/0 指纹撞车），按主机隔离不算重复投递
func TestTerminalHistorySourceAndHost(t *testing.T) {
	s := newTerminalHistoryTestStore(t)
	base := time.Now()

	// 同文同主机 2s 窗口内双投递：去重照常收敛
	first := store.HistoryEntry{Command: "kubectl get pods", At: base, Source: store.HistorySourceInput, Host: "host-A"}
	if err := s.TerminalHistory.Append("p1", first); err != nil {
		t.Fatal(err)
	}
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: "kubectl get pods", At: base.Add(4 * time.Millisecond), Source: store.HistorySourceInput, Host: "host-A"}); err != nil {
		t.Fatal(err)
	}
	// 不同主机同命令同窗口：真实两次提交（多主机并行运维场景），都留
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: "kubectl get pods", At: base.Add(8 * time.Millisecond), Source: store.HistorySourceInput, Host: "host-B"}); err != nil {
		t.Fatal(err)
	}

	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 entries (dedup by host), got %d", len(got))
	}
	for _, e := range got {
		if e.Source != store.HistorySourceInput {
			t.Errorf("source not carried: %+v", e)
		}
		if e.Host != "host-A" && e.Host != "host-B" {
			t.Errorf("host not carried: %+v", e)
		}
	}

	// SearchAll 透传 source/host；本地 osc 条目（旧形态，无 source/host）零值缺省
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: "go build ./...", ExitCode: 0, At: base.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	hits, err := s.TerminalHistory.SearchAll("kubectl", 0, nil)
	if err != nil || len(hits) != 2 {
		t.Fatalf("SearchAll: %v, %d hits", err, len(hits))
	}
	if hits[0].Source != store.HistorySourceInput || (hits[0].Host != "host-A" && hits[0].Host != "host-B") {
		t.Errorf("SearchAll not passing source/host: %+v", hits[0])
	}
	localHits, err := s.TerminalHistory.SearchAll("go build", 0, nil)
	if err != nil || len(localHits) != 1 {
		t.Fatalf("SearchAll local: %v, %d hits", err, len(localHits))
	}
	if localHits[0].Source != "" || localHits[0].Host != "" {
		t.Errorf("local entry must default to osc/local zero values: %+v", localHits[0])
	}
}

// 输入域条目的升级兼容（P-20261005-188）：无 source/host 键的旧 JSON 条目读回
// 空串 = osc 缺省/本地，读写往返形态不变
func TestTerminalHistoryLegacyEntriesWithoutSourceHost(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	doc := filestore.New(dir)
	s := store.New(doc)

	legacy := `[{"command":"docker ps","exitCode":0,"durationMs":800,"at":"2026-01-02T03:04:05Z","terminalId":"term-old"}]`
	if err := doc.Create("terminal_history", "p1", []byte(legacy)); err != nil {
		t.Fatalf("seed legacy doc: %v", err)
	}
	got, err := s.TerminalHistory.Search("p1", "", false, "")
	if err != nil || len(got) != 1 {
		t.Fatalf("legacy readable: %v, %d", err, len(got))
	}
	if got[0].Source != "" || got[0].Host != "" {
		t.Errorf("legacy entry must default to osc/local, got %+v", got[0])
	}

	// 新输入域条目与旧条目共存一文档，重写后旧条目无 source/host 键形态不被改写
	if err := s.TerminalHistory.Append("p1", store.HistoryEntry{Command: "uptime", At: time.Now(), Source: store.HistorySourceInput, Host: "host-X"}); err != nil {
		t.Fatal(err)
	}
	data, err := doc.Get("terminal_history", "p1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"command":"docker ps","exitCode":0,"durationMs":800`) {
		t.Errorf("legacy entry shape rewritten: %s", data)
	}
	if !strings.Contains(string(data), `"source":"input"`) {
		t.Errorf("input entry source missing: %s", data)
	}
}
