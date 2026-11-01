package system

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// ── 审计定期自动归档（P-20261003-277） ──
// 覆盖：过期事件先转 CSV 再清理（归档生成/内容完整/窗口清理协同）、无过期
// 零写盘、窗口随 settings 收敛、同日追加单表头、归档文件窗口清账、手动触发
// 端点。数据面经 SC_DATA_DIR + 独立 filestore 隔离（trash 同款）

// setupAuditArchiveEnv 独立临时数据面 + store（归档目录与审计数据同盘隔离）
func setupAuditArchiveEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CC_DATA_DIR", t.TempDir())
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// seedAuditEvent 播种一条指定时刻的审计事件，返回其 ID
func seedAuditEvent(t *testing.T, at time.Time, action, detail string) string {
	t.Helper()
	e := store.AuditEvent{Time: at, Action: action, Result: store.AuditResultSuccess, IP: "9.9.9.9", Detail: detail}
	store.Get().Audit.Append(e)
	events := auditEventsForTesting(t)
	for _, got := range events {
		if got.Action == action && got.Detail == detail {
			return got.ID
		}
	}
	t.Fatalf("seed event not found: %s", action)
	return ""
}

// readAuditArchiveCSV 读归档 CSV（剥 BOM 后按 RFC 4180 解析）
func readAuditArchiveCSV(t *testing.T, path string) [][]string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read archive csv: %v", err)
	}
	if !bytes.HasPrefix(raw, []byte("\xEF\xBB\xBF")) {
		t.Fatalf("archive csv missing UTF-8 BOM")
	}
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(raw, []byte("\xEF\xBB\xBF"))))
	records, err := r.ReadAll()
	if err != nil {
		t.Fatalf("parse archive csv: %v", err)
	}
	return records
}

func TestAuditArchive_ArchivesBeforeWindowCleanup(t *testing.T) {
	setupAuditArchiveEnv(t)

	now := time.Now()
	// 40 天前事件已出默认 30 天窗（将过期），今晨事件在窗内（保留）
	seedAuditEvent(t, now.AddDate(0, 0, -40), store.AuditUnlock, "old plain")
	seedAuditEvent(t, now.AddDate(0, 0, -40), store.AuditHostCreate, `=HYPERLINK("http://evil","pwn")`)
	seedAuditEvent(t, now, store.AuditCredSave, "fresh")

	res := RunAuditRetentionPass(now, "", "")
	if res.Archived != 2 || res.Removed != 2 {
		t.Fatalf("archived=%d removed=%d, want 2/2 (%+v)", res.Archived, res.Removed, res)
	}
	if res.File != auditArchiveFilePrefix+now.Format("2006-01-02")+".csv" {
		t.Fatalf("unexpected archive file name %q", res.File)
	}

	// 归档文件生成且内容完整：BOM + 表头 + 两行（过期事件全量，无一遗漏），
	// 公式注入防护沿导出面同款（= 前缀单引号）
	records := readAuditArchiveCSV(t, filepath.Join(auditArchiveDir(), res.File))
	if len(records) != 3 {
		t.Fatalf("expected header+2 rows, got %d: %v", len(records), records)
	}
	if strings.Join(records[0], ",") != "time,action,result,ip,detail" {
		t.Fatalf("unexpected header: %v", records[0])
	}
	details := map[string]bool{}
	for _, rec := range records[1:] {
		details[rec[4]] = true
	}
	if !details["old plain"] || !details[`'=HYPERLINK("http://evil","pwn")`] {
		t.Fatalf("archive content incomplete: %v", details)
	}

	// 先归档后清理：过期事件已出活动窗口，窗内事件保留
	events := auditEventsForTesting(t)
	if len(events) != 2 { // fresh 事件 + 归档动作自身入账
		t.Fatalf("live events = %d, want 2 (fresh + audit.archive)", len(events))
	}
	for _, e := range events {
		if e.Detail == "old plain" {
			t.Fatal("expired event still in live window after archive pass")
		}
	}

	// 归档动作同路入账（audit.archive，系统巡更无 IP）
	foundArchive := false
	for _, e := range events {
		if e.Action == store.AuditLogArchive {
			foundArchive = true
			if e.IP != "" {
				t.Errorf("system archive entry should have no ip, got %q", e.IP)
			}
			if !strings.Contains(e.Detail, "rows=2") {
				t.Errorf("archive entry detail = %q, want rows=2", e.Detail)
			}
		}
	}
	if !foundArchive {
		t.Fatal("audit.archive entry not recorded")
	}

	// 归档通知入账（category system，i18n 模板键）
	notifs := store.Get().Notification.List(0)
	foundNotify := false
	for _, n := range notifs {
		if n.TitleKey == "audit.notify.archive.title" {
			foundNotify = true
			if n.Category != notification.CategorySystem || n.Type != "info" {
				t.Errorf("notify category/type = %s/%s, want system/info", n.Category, n.Type)
			}
		}
	}
	if !foundNotify {
		t.Fatal("archive notification not recorded")
	}
}

func TestAuditArchive_NoExpiringNoFileNoNotify(t *testing.T) {
	setupAuditArchiveEnv(t)

	now := time.Now()
	seedAuditEvent(t, now, store.AuditUnlock, "fresh only")

	res := RunAuditRetentionPass(now, "", "")
	if res.Archived != 0 || res.File != "" || res.Removed != 0 {
		t.Fatalf("empty window should be a no-op, got %+v", res)
	}
	if _, err := os.Stat(auditArchiveDir()); !os.IsNotExist(err) {
		t.Fatalf("archive dir should not be created on empty pass, err=%v", err)
	}
	if n := len(store.Get().Notification.List(0)); n != 0 {
		t.Fatalf("no notification expected on empty pass, got %d", n)
	}
}

func TestAuditArchive_WindowFollowsRetentionSetting(t *testing.T) {
	setupAuditArchiveEnv(t)

	// 保留期调短到 1 天：10 天前事件出窗即归档（P-20261003-123 同源语义）
	store.Get().Settings.Get().Server.AuditRetentionDays = 1
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatalf("save settings: %v", err)
	}

	now := time.Now()
	seedAuditEvent(t, now.AddDate(0, 0, -10), store.AuditUnlock, "aged out by shrink")
	seedAuditEvent(t, now.Add(-2*time.Hour), store.AuditCredSave, "still in 1d window")

	res := RunAuditRetentionPass(now, "", "")
	if res.Archived != 1 || res.Removed != 1 {
		t.Fatalf("archived=%d removed=%d, want 1/1 (%+v)", res.Archived, res.Removed, res)
	}
	records := readAuditArchiveCSV(t, filepath.Join(auditArchiveDir(), res.File))
	if len(records) != 2 || records[1][4] != "aged out by shrink" {
		t.Fatalf("archive should hold exactly the aged-out event: %v", records)
	}
}

func TestAuditArchive_SameDayAppendKeepsSingleHeader(t *testing.T) {
	setupAuditArchiveEnv(t)

	now := time.Now()
	seedAuditEvent(t, now.AddDate(0, 0, -40), store.AuditUnlock, "first round")
	if res := RunAuditRetentionPass(now, "", ""); res.Archived != 1 {
		t.Fatalf("first pass archived=%d, want 1", res.Archived)
	}

	// 同日第二轮（手动触发形态）：新过期事件追加进同一文件，表头不重复
	seedAuditEvent(t, now.AddDate(0, 0, -41), store.AuditHostCreate, "second round")
	res := RunAuditRetentionPass(now, "", "")
	if res.Archived != 1 {
		t.Fatalf("second pass archived=%d, want 1", res.Archived)
	}
	records := readAuditArchiveCSV(t, filepath.Join(auditArchiveDir(), res.File))
	if len(records) != 3 { // 单表头 + 两轮各一行
		t.Fatalf("expected single header + 2 rows, got %d: %v", len(records), records)
	}
	if strings.Join(records[0], ",") != "time,action,result,ip,detail" {
		t.Fatalf("header should stay first line: %v", records[0])
	}
	if records[1][4] != "first round" || records[2][4] != "second round" {
		t.Fatalf("append order/content wrong: %v", records)
	}
}

func TestAuditArchive_FileWindowCleanup(t *testing.T) {
	setupAuditArchiveEnv(t)

	dir := auditArchiveDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	stale := filepath.Join(dir, auditArchiveFilePrefix+"2020-01-01.csv")
	fresh := filepath.Join(dir, auditArchiveFilePrefix+now.Format("2006-01-02")+".csv")
	foreign := filepath.Join(dir, "user-notes.txt")
	for _, p := range []string{stale, fresh, foreign} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := now.AddDate(0, 0, -31) // 默认 30 天窗之外
	for _, p := range []string{stale, foreign} {
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}

	res := RunAuditRetentionPass(now, "", "")
	// 无过期事件：归档零行，但归档文件窗口清账照常巡更
	if res.Archived != 0 {
		t.Fatalf("archived=%d, want 0", res.Archived)
	}
	if res.ArchiveFilesRemoved != 1 {
		t.Fatalf("archiveFilesRemoved=%d, want 1 (stale only)", res.ArchiveFilesRemoved)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale archive file should be removed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh archive file should be kept: %v", err)
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatalf("non-archive-prefix file must not be touched: %v", err)
	}
}

func TestTriggerAuditArchive_Endpoint(t *testing.T) {
	setupAuditArchiveEnv(t)
	gin.SetMode(gin.TestMode)

	now := time.Now()
	seedAuditEvent(t, now.AddDate(0, 0, -40), store.AuditUnlock, "endpoint round")

	r := gin.New()
	r.POST("/api/audit/archive", TriggerAuditArchive)
	req := httptest.NewRequest(http.MethodPost, "/api/audit/archive", nil)
	req.RemoteAddr = "9.9.9.9:1234"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	var got struct {
		Data AuditRetentionResult `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.Archived != 1 || got.Data.Removed != 1 || got.Data.File == "" {
		t.Fatalf("endpoint result = %+v, want archived/removed 1/1 + file", got.Data)
	}

	// 手动触发带 ClientIP：归档入账走请求方 IP（audit.export 同族）
	events := auditEventsForTesting(t)
	for _, e := range events {
		if e.Action == store.AuditLogArchive && e.IP != "9.9.9.9" {
			t.Fatalf("manual trigger should record client ip, got %q", e.IP)
		}
	}
}
