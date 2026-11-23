package system

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 诊断包端点（P-20261122-10）：探针形状 / zip 产物 / 单飞与冷却闸门。
// 采集器语义由 server/diagnostics 单测覆盖，这里只守 HTTP 契约面。

func diagTestRouter(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	today := time.Now().Format("2006-01-02")
	if err := os.WriteFile(filepath.Join(dir, "logs", "codecombo-"+today+".log"),
		[]byte("time="+time.Now().Format(time.RFC3339)+" level=ERROR msg=\"update: failed\" token=leak\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))
	t.Cleanup(func() { store.SetDefault(nil) })

	// 闸门是进程级全局：每个用例从干净态起（避免用例间顺序依赖）
	diagExportState.mu.Lock()
	diagExportState.running = false
	diagExportState.lastRun = time.Time{}
	diagExportState.mu.Unlock()
	t.Cleanup(func() {
		diagExportState.mu.Lock()
		diagExportState.running = false
		diagExportState.lastRun = time.Time{}
		diagExportState.mu.Unlock()
	})

	r := gin.New()
	r.GET("/api/system/diagnostics/export", DiagnosticsExport)
	return r, dir
}

func doDiag(t *testing.T, r *gin.Engine, query string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/system/diagnostics/export"+query, nil)
	r.ServeHTTP(w, req)
	return w
}

// 探针：200 + data.files/totals/limits，不产 zip
func TestDiagnosticsProbe(t *testing.T) {
	r, _ := diagTestRouter(t)
	w := doDiag(t, r, "?probe=1&days=3")
	if w.Code != http.StatusOK {
		t.Fatalf("probe status = %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("probe content-type = %q", ct)
	}
	var body struct {
		Data struct {
			Files  []map[string]any `json:"files"`
			Totals struct {
				PackedFiles   int   `json:"packedFiles"`
				IncludedBytes int64 `json:"includedBytes"`
			} `json:"totals"`
			Limits struct {
				RawBudgetBytes int64 `json:"rawBudgetBytes"`
				ZipCapBytes    int64 `json:"zipCapBytes"`
			} `json:"limits"`
			Derived []string `json:"derivedFiles"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("probe json: %v (%s)", err, w.Body.String())
	}
	if len(body.Data.Files) == 0 || body.Data.Totals.PackedFiles == 0 {
		t.Fatalf("probe empty: %+v", body.Data)
	}
	if body.Data.Limits.ZipCapBytes != 64<<20 || body.Data.Limits.RawBudgetBytes != 96<<20 {
		t.Fatalf("probe limits = %+v", body.Data.Limits)
	}
	if len(body.Data.Derived) == 0 {
		t.Fatal("probe must list derived files")
	}
}

// 导出：200 + application/zip + 附件头；包内含 manifest/errors 且敏感值已遮蔽
func TestDiagnosticsExportZip(t *testing.T) {
	r, _ := diagTestRouter(t)
	w := doDiag(t, r, "?days=3")
	if w.Code != http.StatusOK {
		t.Fatalf("export status = %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("content-type = %q, want application/zip", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "codecombo-diagnostics-") {
		t.Fatalf("content-disposition = %q", cd)
	}
	raw := w.Body.Bytes()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("response is not a valid zip: %v", err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		files[f.Name] = string(b)
	}
	if _, ok := files["manifest.json"]; !ok {
		t.Fatalf("manifest.json missing from zip (have %v)", keysOf(files))
	}
	errs := files["errors.txt"]
	if !strings.Contains(errs, "update: failed") {
		t.Fatalf("errors.txt missing ERROR line: %q", errs)
	}
	if strings.Contains(errs, "token=leak") {
		t.Fatal("sensitive token leaked through the export endpoint")
	}
	// state 面：selfcheck/update-status 都应有内容（服务形态注入）
	if !strings.Contains(files["state/selfcheck.json"], "version") {
		t.Fatalf("selfcheck.json unexpected: %q", files["state/selfcheck.json"])
	}
	if !strings.Contains(files["state/update-status.json"], "status") {
		t.Fatalf("update-status.json unexpected: %q", files["state/update-status.json"])
	}
	// S2b：存储统计与终端会话摘要（数量/状态，不含会话明细）
	if _, ok := files["state/storage.json"]; !ok {
		t.Fatalf("state/storage.json missing from zip (have %v)", keysOf(files))
	}
	runtimeJSON := files["state/runtime.json"]
	if !strings.Contains(runtimeJSON, "terminalSessions") || !strings.Contains(runtimeJSON, "\"total\"") {
		t.Fatalf("runtime.json terminalSessions block unexpected: %q", runtimeJSON)
	}
	if strings.Contains(runtimeJSON, "\"id\":") {
		t.Fatalf("terminal summary must not carry session ids: %q", runtimeJSON)
	}
}

// 闸门：30s 冷却（第二次立即 429 + Retry-After）；在途单飞 409
func TestDiagnosticsExportGates(t *testing.T) {
	r, _ := diagTestRouter(t)
	if w := doDiag(t, r, ""); w.Code != http.StatusOK {
		t.Fatalf("first export = %d", w.Code)
	}
	second := doDiag(t, r, "")
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second export = %d, want 429 (cooldown)", second.Code)
	}
	if second.Header().Get("Retry-After") == "" {
		t.Fatal("429 must carry Retry-After")
	}
	var body map[string]any
	if err := json.Unmarshal(second.Body.Bytes(), &body); err != nil {
		t.Fatalf("cooldown body: %v", err)
	}
	if body["err"] != "cooldown" {
		t.Fatalf("cooldown err = %v", body["err"])
	}

	// 单飞：绕过冷却窗直接置 running
	diagExportState.mu.Lock()
	diagExportState.running = true
	diagExportState.lastRun = time.Time{}
	diagExportState.mu.Unlock()
	busy := doDiag(t, r, "")
	if busy.Code != http.StatusConflict {
		t.Fatalf("in-flight export = %d, want 409", busy.Code)
	}
	if !strings.Contains(busy.Body.String(), "single-flight") {
		t.Fatalf("409 body must explain single-flight: %s", busy.Body.String())
	}
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// 终端会话摘要（S2b⑥）：只出计数/状态，绝不含会话 id/名称/路径/输出
func TestDiagTerminalSessionsShape(t *testing.T) {
	got := diagTerminalSessions()
	for _, k := range []string{
		"total", "max", "byKind", "byOrigin", "byBackend",
		"oscRunning", "oscIdle", "probeRunning", "probeIdle", "probeUnknown", "note",
	} {
		if _, ok := got[k]; !ok {
			t.Fatalf("terminal summary missing key %q: %v", k, got)
		}
	}
	for _, forbidden := range []string{"id", "name", "path", "output", "sessions"} {
		if _, ok := got[forbidden]; ok {
			t.Fatalf("terminal summary must not carry %q: %v", forbidden, got)
		}
	}
	if total, ok := got["total"].(int); !ok || total < 0 {
		t.Fatalf("terminal summary total = %v", got["total"])
	}
	if max, ok := got["max"].(int); !ok || max <= 0 {
		t.Fatalf("terminal summary max = %v (MaxSessions default must be positive)", got["max"])
	}
}
