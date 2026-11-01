package terminal

import (
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
	"codecombo/server/store"
)

// setupPressureTest 起 gin 路由 + SC_CLAUDE_DIR 指向临时会话根（Root() 走环境
// 变量，无需污染真实 ~/.claude）；q 为空走索引车道需要 store（与 setupMetaTest
// 同款内存文件库）
func setupPressureTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	root := t.TempDir()
	t.Setenv("CC_CLAUDE_DIR", root)
	r := gin.New()
	r.GET("/api/claude/sessions", ListClaudeSessions)
	return r, root
}

// writeUsageFixture 播种一条带 usage 尾注的最小会话（195k tokens → 97.5%），
// mtime 决定活跃判定
func writeUsageFixture(t *testing.T, root, encodedDir, id string, mod time.Time) {
	t.Helper()
	dir := filepath.Join(root, encodedDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := strings.Join([]string{
		`{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"压测会话"},"timestamp":"2026-01-01T00:00:00Z","cwd":"D:\\p"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"usage":{"input_tokens":185000,"cache_creation_input_tokens":6000,"cache_read_input_tokens":2000,"output_tokens":2000}},"timestamp":"2026-01-01T00:01:00Z"}`,
	}, "\n") + "\n"
	path := filepath.Join(dir, id+".jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

// pressureFields 压力估算的响应形态（具名类型：匿名结构体带 tag 的类型恒等脆弱）
type pressureFields struct {
	EstimatedTokens int     `json:"estimatedTokens"`
	Percent         float64 `json:"percent"`
	WindowTokens    int     `json:"windowTokens"`
	Estimated       bool    `json:"estimated"`
}

type pressureBody struct {
	Data struct {
		Sessions []struct {
			ID       string          `json:"id"`
			Active   bool            `json:"active"`
			Pressure *pressureFields `json:"pressure"`
		} `json:"sessions"`
	} `json:"data"`
}

func listSessions(t *testing.T, r *gin.Engine, query string) pressureBody {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/claude/sessions"+query, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body pressureBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

// TestListClaudeSessions_WithPressureActive withPressure=true：活跃行携带压力
// 估算，非活跃行不带（活跃判定外的会话压测无意义且白费 IO）
func TestListClaudeSessions_WithPressureActive(t *testing.T) {
	r, root := setupPressureTest(t)
	now := time.Now()
	writeUsageFixture(t, root, "D--p", "sess-hot", now)
	writeUsageFixture(t, root, "D--p", "sess-cold", now.Add(-10*time.Minute))

	body := listSessions(t, r, "?withPressure=true")
	if len(body.Data.Sessions) != 2 {
		t.Fatalf("sessions = %d, want 2", len(body.Data.Sessions))
	}
	byID := map[string]*pressureFields{}
	for _, s := range body.Data.Sessions {
		byID[s.ID] = s.Pressure
		if s.ID == "sess-hot" && !s.Active {
			t.Error("sess-hot must be active (fresh mtime)")
		}
		if s.ID == "sess-cold" && s.Active {
			t.Error("sess-cold must not be active (stale mtime)")
		}
	}
	if p := byID["sess-hot"]; p == nil {
		t.Fatal("active session must carry pressure")
	} else if p.EstimatedTokens != 195000 || p.Percent != 97.5 || !p.Estimated || p.WindowTokens != 200000 {
		t.Errorf("pressure = %+v", p)
	}
	if p := byID["sess-cold"]; p != nil {
		t.Errorf("inactive session must not carry pressure, got %+v", p)
	}
}

// TestListClaudeSessions_PressureGate 默认（无参数/false）不扫描：活跃行也
// 不带 pressure（常态 IO 门控）
func TestListClaudeSessions_PressureGate(t *testing.T) {
	r, root := setupPressureTest(t)
	writeUsageFixture(t, root, "D--p", "sess-gate", time.Now())

	for _, query := range []string{"", "?withPressure=false"} {
		body := listSessions(t, r, query)
		if len(body.Data.Sessions) != 1 {
			t.Fatalf("query %q: sessions = %d", query, len(body.Data.Sessions))
		}
		if body.Data.Sessions[0].Pressure != nil {
			t.Errorf("query %q: pressure must be absent without withPressure=true", query)
		}
	}
}

// TestListClaudeSessions_PressureNoData 活跃但窗口内无 usage 数据：pressure
// 缺省（「无数据」≠「零压力」）
func TestListClaudeSessions_PressureNoData(t *testing.T) {
	r, root := setupPressureTest(t)
	dir := filepath.Join(root, "D--p")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"无 usage"},"timestamp":"2026-01-01T00:00:00Z","cwd":"D:\\p"}` + "\n"
	path := filepath.Join(dir, "sess-nodata.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	body := listSessions(t, r, "?withPressure=true")
	if len(body.Data.Sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(body.Data.Sessions))
	}
	if body.Data.Sessions[0].Pressure != nil {
		t.Errorf("pressure = %+v, want nil (no usage data)", body.Data.Sessions[0].Pressure)
	}
}
