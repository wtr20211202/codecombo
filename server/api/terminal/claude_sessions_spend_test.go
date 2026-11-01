package terminal

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 会话花费阈值告警（P-20261003-157）集成用例：P-139 用量数据面命中阈值 →
// 通知一次（防重标记）；二次上报（再次列表）不重复。装载方式与
// claude_sessions_pressure_test.go 同款：SC_CLAUDE_DIR 指向临时会话根 +
// 内存文件库 store。

// setupSpendTest 起 gin 路由 + 临时会话根，返回请求列表的 helper
func setupSpendTest(t *testing.T) (list func() *httptest.ResponseRecorder, root string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root = t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	r := gin.New()
	r.GET("/api/claude/sessions", ListClaudeSessions)
	list = func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("list status = %d: %s", w.Code, w.Body.String())
		}
		return w
	}
	return list, root
}

// writeSpendFixture 播种一条带 usage 的会话（total = in+cr+out），mtime 控制
// 活跃判定
func writeSpendFixture(t *testing.T, root, encodedDir, id string, in, cr, out int64, mod time.Time) {
	t.Helper()
	dir := filepath.Join(root, encodedDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := strings.Join([]string{
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"花费会话"},"timestamp":"2026-01-01T00:00:00Z","cwd":"D:\\p"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"usage":{"input_tokens":` + strconv.FormatInt(in, 10) + `,"cache_read_input_tokens":` + strconv.FormatInt(cr, 10) + `,"output_tokens":` + strconv.FormatInt(out, 10) + `}},"timestamp":"2026-01-01T00:01:00Z"}`,
	}, "\n") + "\n"
	path := filepath.Join(dir, id+".jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

// spendNotifications 取通知中心内 titleKey 命中花费告警模板的条目
func spendNotifications(t *testing.T) []notification.Notification {
	t.Helper()
	list := store.Get().Notification.List(0)
	out := make([]notification.Notification, 0, 2)
	for _, n := range list {
		if n.TitleKey == spendAlertTitleKey {
			out = append(out, n)
		}
	}
	return out
}

// setSpendThreshold 写偏好阈值（用例内隔离，cleanup 还原默认关）
func setSpendThreshold(t *testing.T, tokens int) {
	t.Helper()
	p := store.Get().Notification.GetPrefs()
	p.ClaudeSpendAlertTokens = tokens
	if err := store.Get().Notification.SavePrefs(p); err != nil {
		t.Fatal(err)
	}
}

// TestSpendAlertDisabledByDefault 默认（阈值 0=关）：超阈会话存在也不告警、
// 不落标记（存量零变化）
func TestSpendAlertDisabledByDefault(t *testing.T) {
	list, root := setupSpendTest(t)
	writeSpendFixture(t, root, "D--spend-fixtures", "spend-off-1", 2_000_000, 0, 0, time.Now().Add(-time.Hour))
	list()
	if n := len(spendNotifications(t)); n != 0 {
		t.Fatalf("threshold off: want 0 notifications, got %d", n)
	}
	if c, err := store.Get().ClaudeSpend.Count(); err != nil || c != 0 {
		t.Fatalf("threshold off: want 0 marks, got %d err=%v", c, err)
	}
}

// TestSpendAlertOnce 命中阈值 → 通知一次 + 落标记；二次列表（同会话仍超阈，
// 走索引命中路径）不重复——防重复标记位的核心契约。同批未达阈值行沉默
func TestSpendAlertOnce(t *testing.T) {
	list, root := setupSpendTest(t)
	// total = 1_500_000（in 1_000_000 + cr 400_000 + out 100_000）
	writeSpendFixture(t, root, "D--spend-fixtures", "spend-hit-1", 1_000_000, 400_000, 100_000, time.Now().Add(-time.Hour))
	// total = 999_999：阈值下不告警（同批隔离变量，只一条命中）
	writeSpendFixture(t, root, "D--spend-fixtures", "spend-miss-1", 899_999, 90_000, 10_000, time.Now().Add(-2*time.Hour))

	setSpendThreshold(t, 1_000_000)

	list()
	if n := len(spendNotifications(t)); n != 1 {
		t.Fatalf("first list: want 1 notification, got %d", n)
	}
	got := spendNotifications(t)[0]
	if got.Type != "warning" || got.Category != notification.CategoryTask {
		t.Fatalf("notification shape: type=%q category=%q", got.Type, got.Category)
	}
	if got.BodyKey != spendAlertBodyKey {
		t.Fatalf("notification template: bodyKey=%q", got.BodyKey)
	}
	// MsgParams 经落盘 JSON 往返数值为 float64（store List 读回形态），按
	// float64 断言
	if got.MsgParams["threshold"] != float64(1_000_000) || got.MsgParams["tokens"] != float64(1_500_000) {
		t.Fatalf("notification params: %v", got.MsgParams)
	}
	if c, err := store.Get().ClaudeSpend.Count(); err != nil || c != 1 {
		t.Fatalf("marks after first list: want 1, got %d err=%v", c, err)
	}

	// 二次上报：同会话仍超阈（索引命中路径）→ 不重复
	list()
	list()
	if n := len(spendNotifications(t)); n != 1 {
		t.Fatalf("repeat lists: want still 1 notification, got %d", n)
	}
}

// TestSpendAlertMarkSurvivesStoreReload 防重标记跨「进程重启」仍在（车道 1
// 持久化语义）：同一数据目录重建 store 聚合体后再列表不重发
func TestSpendAlertMarkSurvivesStoreReload(t *testing.T) {
	dataDir := t.TempDir()
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	writeSpendFixture(t, root, "D--spend-fixtures", "spend-reload-1", 2_000_000, 0, 0, time.Now().Add(-time.Hour))

	r := gin.New()
	r.GET("/api/claude/sessions", ListClaudeSessions)
	list := func() {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/claude/sessions", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("list status = %d: %s", w.Code, w.Body.String())
		}
	}

	store.SetDefault(store.New(filestore.New(dataDir)))
	t.Cleanup(func() { store.SetDefault(nil) })
	setSpendThreshold(t, 1_000_000)
	list()
	if n := len(spendNotifications(t)); n != 1 {
		t.Fatalf("first round: want 1, got %d", n)
	}
	// 重建 store（模拟进程重启后的存储重挂；doc 数据面同一目录）
	store.SetDefault(store.New(filestore.New(dataDir)))
	list()
	if n := len(spendNotifications(t)); n != 1 {
		t.Fatalf("after reload: want still 1, got %d", n)
	}
}
