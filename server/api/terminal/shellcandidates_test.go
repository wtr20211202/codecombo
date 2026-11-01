package terminal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// shell 候选探测端点 + POST /terminals 的 shell 会话级覆盖校验面（P-20261004-57）
// 真实建会话不进本包单测（PTY 不进单测是本包既有边界，见 terminal_precheck_test），
// 落点断言在 server/terminal 真实 PTY 用例与 e2e

func shellCandidatesTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.GET("/api/terminals/shell-candidates", ListShellCandidates)
	r.POST("/api/terminals", CreateTerminal)
	return r
}

type shellCandidatesResp struct {
	Data struct {
		Platform     string                        `json:"platform"`
		SettingShell string                        `json:"settingShell"`
		DefaultShell string                        `json:"defaultShell"`
		Candidates   []terminal.ShellCandidateInfo `json:"candidates"`
	} `json:"data"`
}

func getShellCandidates(t *testing.T, r *gin.Engine) shellCandidatesResp {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/terminals/shell-candidates", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var got shellCandidatesResp
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

// 候选端点：platform 非空、候选非空且含当前生效默认、settingShell 随设置回读
func TestListShellCandidates(t *testing.T) {
	r := shellCandidatesTestRouter(t)

	got := getShellCandidates(t, r)
	if got.Data.Platform == "" {
		t.Fatalf("platform empty")
	}
	if len(got.Data.Candidates) == 0 {
		t.Fatalf("candidates empty")
	}
	if got.Data.DefaultShell == "" {
		t.Fatalf("defaultShell empty")
	}
	found := false
	for _, c := range got.Data.Candidates {
		if c.Available && (strings.EqualFold(c.Path, got.Data.DefaultShell) || strings.EqualFold(c.Name, got.Data.DefaultShell)) {
			found = true
		}
	}
	if !found {
		t.Fatalf("effective default %q not among available candidates %+v", got.Data.DefaultShell, got.Data.Candidates)
	}

	// 设置保存后：settingShell 回读 + defaultShell 跟随设置
	exe, err := os.Executable()
	if err != nil {
		t.Skipf("os.Executable unavailable: %v", err)
	}
	st := store.Get().Settings.Get()
	st.Server.TerminalDefaultShell = exe
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}
	got2 := getShellCandidates(t, r)
	if got2.Data.SettingShell != exe {
		t.Fatalf("settingShell = %q, want %q", got2.Data.SettingShell, exe)
	}
	if got2.Data.DefaultShell != exe {
		t.Fatalf("defaultShell should follow setting, = %q want %q", got2.Data.DefaultShell, exe)
	}
}

// POST /terminals 携不存在的 shell → 400 + 稳定标记原文（不建会话）
func TestCreateTerminalInvalidShell400(t *testing.T) {
	r := shellCandidatesTestRouter(t)
	bad := filepath.Join(t.TempDir(), "no-such-shell")
	before := len(terminal.DefaultManager.ListSessions())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/terminals",
		strings.NewReader(`{"kind":"agent","runtime":"shell","name":"x","shell":`+quoteJSON(bad)+`}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "shell not found") {
		t.Fatalf("body 应含稳定标记原文，got %s", w.Body.String())
	}
	if after := len(terminal.DefaultManager.ListSessions()); after != before {
		t.Fatalf("rejected create should not leave sessions: before=%d after=%d", before, after)
	}
}

func quoteJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
