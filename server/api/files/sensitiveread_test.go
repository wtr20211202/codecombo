package files

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// TestIsSensitiveReadPath_Hits 清单命中：六族模式逐一验证（含同族衍生名）
func TestIsSensitiveReadPath_Hits(t *testing.T) {
	hits := []string{
		".env",             // .env*：裸 .env
		".env.local",       // .env*：带环境后缀
		"id_rsa",           // id_rsa*：私钥本体
		"id_rsa.pub",       // id_rsa*：公钥同族
		"server.pem",       // *.pem
		"cert.key",         // *.key
		"credentials.json", // credentials*：云厂商凭据清单
		"secrets.yaml",     // secrets*：密钥集合
	}
	for _, p := range hits {
		if !IsSensitiveReadPath(p) {
			t.Errorf("IsSensitiveReadPath(%q) = false, want true", p)
		}
	}
}

// TestIsSensitiveReadPath_Misses 不命中：正常开发文件零误伤（清单窄域取舍）
func TestIsSensitiveReadPath_Misses(t *testing.T) {
	misses := []string{
		"readme.md",
		"main.go",
		"environment.ts", // 含 env 字样但不以 .env 开头
		"env.example",    // 无前导点
		"my.env",         // .env* 是前缀锚定，中缀命中即误伤
		"keyring.go",
		"public_key.txt", // 非 *.key 后缀
		"src/config/app.json",
		"",  // 空路径
		".", // 项目根本身
	}
	for _, p := range misses {
		if IsSensitiveReadPath(p) {
			t.Errorf("IsSensitiveReadPath(%q) = true, want false", p)
		}
	}
}

// TestIsSensitiveReadPath_CaseInsensitive 大小写不敏感：大小写变体同判命中
// （安全观测宁多勿漏，不区分宿主文件系统的大小写语义）
func TestIsSensitiveReadPath_CaseInsensitive(t *testing.T) {
	hits := []string{
		".ENV",
		".Env.Local",
		"ID_RSA",
		"Server.PEM",
		"Credentials.JSON",
		"SECRETS.yaml",
	}
	for _, p := range hits {
		if !IsSensitiveReadPath(p) {
			t.Errorf("IsSensitiveReadPath(%q) = false, want true (case-insensitive)", p)
		}
	}
}

// TestIsSensitiveReadPath_NestedPaths 嵌套路径：basename 命中即命中
func TestIsSensitiveReadPath_NestedPaths(t *testing.T) {
	hits := []string{
		"config/.env.production",
		".ssh/id_rsa",
		"deploy/secrets/prod.pem",
		"a/b/c/credentials.txt",
		"certs/server.key",
	}
	for _, p := range hits {
		if !IsSensitiveReadPath(p) {
			t.Errorf("IsSensitiveReadPath(%q) = false, want true (nested)", p)
		}
	}
	// 嵌套同样不误伤普通文件
	if IsSensitiveReadPath("docs/env-guide.md") {
		t.Error(`IsSensitiveReadPath("docs/env-guide.md") = true, want false`)
	}
}

// TestSensitiveReadDedup_Window 去重窗口：窗口内同键去重、跨键独立、
// 窗口过期后再记（时钟注入，不真实等待）
func TestSensitiveReadDedup_Window(t *testing.T) {
	d := &sensitiveReadDedup{}
	now := time.Now()
	key := "proj\x00session-a\x00.env"

	if d.seen(now, key) {
		t.Error("first record must not be deduped")
	}
	if !d.seen(now.Add(time.Minute), key) {
		t.Error("record within 5min window must be deduped")
	}
	// 窗口边界：恰好 5min 到期后再次记录放行（判重条件是严格小于窗口）
	if d.seen(now.Add(sensitiveReadDedupWindow), key) {
		t.Error("record at window boundary must not be deduped")
	}
	// 不同会话/不同路径互不吞记
	otherSession := "proj\x00session-b\x00.env"
	otherPath := "proj\x00session-a\x00secrets.yaml"
	if d.seen(now, otherSession) || d.seen(now, otherPath) {
		t.Error("different session/path keys must be independent")
	}
}

// TestSensitiveReadDedup_Cap 上限兜底：表满时过期键被清理、活跃键正常入表
// （重置分支只在线程全活跃键的极端形态触发，此处验证清理路径 sufficient）
func TestSensitiveReadDedup_Cap(t *testing.T) {
	d := &sensitiveReadDedup{}
	now := time.Now()
	expired := now.Add(-2 * sensitiveReadDedupWindow) // 已过期键：超限时被清走
	for i := 0; i < sensitiveReadDedupCap; i++ {
		d.seen(expired, "k"+strconv.Itoa(i))
	}
	if d.seen(now, "proj\x00s\x00active.env") {
		t.Error("fresh key after expired-key purge must not be deduped")
	}
}

// setupSensitiveReadTest 构造带临时项目的 ReadFile 审计测试环境
// （file_test.go setupFileOpsTest 同款装配，路由面换成 GET /file）
func setupSensitiveReadTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	projPath := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID:   "proj-sensread",
		Name: "sensread",
		Path: projPath,
	}); err != nil {
		t.Fatal(err)
	}
	// 每用例换新去重表：用例间互不吞记（全局表生产常驻，测试内可整体替换）
	sensitiveReadTable = sensitiveReadDedup{}

	r := gin.New()
	r.GET("/api/projects/:id/file", ReadFile)
	return r, projPath
}

// doSensitiveGet 发起带可选 X-Session-ID 的 GET（httptest 直连，不占端口）
func doSensitiveGet(t *testing.T, r *gin.Engine, target, sessionID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if sessionID != "" {
		req.Header.Set("X-Session-ID", sessionID)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// sensitiveReadEvents 取台账中的 file.sensitive_read 事件
func sensitiveReadEvents(t *testing.T) []store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(1000, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []store.AuditEvent
	for _, e := range events {
		if e.Action == store.AuditFileSensitiveRead {
			out = append(out, e)
		}
	}
	return out
}

// TestReadFile_SensitiveReadAudited 命中：读取 .env 入账一条，Detail 带项目名、
// 路径与 X-Session-ID 会话归属，绝不含文件内容
func TestReadFile_SensitiveReadAudited(t *testing.T) {
	r, projPath := setupSensitiveReadTest(t)
	if err := os.WriteFile(filepath.Join(projPath, ".env"), []byte("TOPSECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := doSensitiveGet(t, r, "/api/projects/proj-sensread/file?path=.env", "sc-term-1")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	events := sensitiveReadEvents(t)
	if len(events) != 1 {
		t.Fatalf("sensitive_read events = %d, want 1", len(events))
	}
	e := events[0]
	if e.Result != store.AuditResultSuccess {
		t.Errorf("result = %q, want success", e.Result)
	}
	wantDetail := "sensread: .env (session sc-term-1)"
	if e.Detail != wantDetail {
		t.Errorf("detail = %q, want %q", e.Detail, wantDetail)
	}
	if strings.Contains(e.Detail, "TOPSECRET") {
		t.Error("audit detail must never contain file content")
	}
}

// TestReadFile_PlainReadNotAudited 不命中：普通文件读取零记录
func TestReadFile_PlainReadNotAudited(t *testing.T) {
	r, projPath := setupSensitiveReadTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "readme.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	w := doSensitiveGet(t, r, "/api/projects/proj-sensread/file?path=readme.md", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if events := sensitiveReadEvents(t); len(events) != 0 {
		t.Fatalf("sensitive_read events = %d, want 0", len(events))
	}
}

// TestReadFile_SensitiveReadDeduped 去重：窗口内同会话同路径只记一条，
// 换会话（X-Session-ID）照常入账；嵌套路径独立成键
func TestReadFile_SensitiveReadDeduped(t *testing.T) {
	r, projPath := setupSensitiveReadTest(t)
	if err := os.MkdirAll(filepath.Join(projPath, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "config", ".env"), []byte("K=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	doSensitiveGet(t, r, "/api/projects/proj-sensread/file?path=config/.env", "sc-term-9")
	doSensitiveGet(t, r, "/api/projects/proj-sensread/file?path=config/.env", "sc-term-9") // 窗口内重读：去重
	if events := sensitiveReadEvents(t); len(events) != 1 {
		t.Fatalf("sensitive_read events after re-read = %d, want 1", len(events))
	}
	doSensitiveGet(t, r, "/api/projects/proj-sensread/file?path=config/.env", "sc-term-10") // 换会话：入账
	events := sensitiveReadEvents(t)
	if len(events) != 2 {
		t.Fatalf("sensitive_read events after other session = %d, want 2", len(events))
	}
	// 嵌套路径的 Detail 携带归一相对路径（正斜杠），非请求原文
	if !strings.Contains(events[0].Detail, "config/.env") {
		t.Errorf("detail = %q, want it to contain normalized path config/.env", events[0].Detail)
	}
}
