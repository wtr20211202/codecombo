package project

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 项目冻结（P-20261003-9）：布尔字段持久化 + ahead/behind 批量探测跳过

// setupFreezeRouter 构造测试 router：独立 store + 预置两个项目 + 注册路由
func setupFreezeRouter(t *testing.T) (*gin.Engine, string, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	dirA := t.TempDir()
	dirB := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "proj-a", Name: "alpha", Path: dirA}); err != nil {
		t.Fatalf("create project a: %v", err)
	}
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "proj-b", Name: "beta", Path: dirB}); err != nil {
		t.Fatalf("create project b: %v", err)
	}

	r := gin.New()
	api := r.Group("/api")
	api.GET("/projects", ListProjects)
	api.GET("/ahead-behind", ListAllAheadBehind)
	api.PUT("/projects/:id/frozen", SetProjectFrozen)
	return r, "proj-a", "proj-b"
}

func doSetFrozen(t *testing.T, r *gin.Engine, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/api/projects/"+id+"/frozen", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestSetProjectFrozenPersists 冻结/解冻往返：响应与存储层均落布尔，
// 名称/路径等其余配置不受影响
func TestSetProjectFrozenPersists(t *testing.T) {
	r, idA, _ := setupFreezeRouter(t)

	w := doSetFrozen(t, r, idA, `{"frozen":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("freeze: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var res struct {
		Data struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Frozen bool   `json:"frozen"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if res.Data.ID != idA || res.Data.Name != "alpha" {
		t.Fatalf("identity must be preserved: got id=%q name=%q", res.Data.ID, res.Data.Name)
	}
	if !res.Data.Frozen {
		t.Fatal("response frozen must be true")
	}

	// 存储层持久化：重读确认（服务重启等价——独立 store 每次从文档反序列化）
	p, err := store.Get().Project.GetByID(idA)
	if err != nil || p == nil {
		t.Fatalf("get after freeze: %v", err)
	}
	if !p.Frozen {
		t.Fatal("stored frozen must be true")
	}
	if p.Path == "" {
		t.Fatal("freeze must not clear path (重定位信息不丢)")
	}

	// 列表透传：GET /projects 带出 frozen
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	r.ServeHTTP(w, req)
	var list struct {
		Data []struct {
			ID     string `json:"id"`
			Frozen bool   `json:"frozen"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	frozenByID := map[string]bool{}
	for _, p := range list.Data {
		frozenByID[p.ID] = p.Frozen
	}
	if !frozenByID[idA] {
		t.Fatal("list must carry frozen=true for frozen project")
	}

	// 解冻恢复
	w = doSetFrozen(t, r, idA, `{"frozen":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("unfreeze: expected 200, got %d", w.Code)
	}
	p, err = store.Get().Project.GetByID(idA)
	if err != nil || p == nil {
		t.Fatalf("get after unfreeze: %v", err)
	}
	if p.Frozen {
		t.Fatal("stored frozen must be false after unfreeze")
	}
}

// TestSetProjectFrozenNotFound 未知项目 ID → 404
func TestSetProjectFrozenNotFound(t *testing.T) {
	r, _, _ := setupFreezeRouter(t)
	w := doSetFrozen(t, r, "no-such-id", `{"frozen":true}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

// TestListAllAheadBehindSkipsFrozen 冻结项目不参与批量探测：响应无其键
// （前端按 0/0 缺省），解冻后恢复
func TestListAllAheadBehindSkipsFrozen(t *testing.T) {
	r, idA, idB := setupFreezeRouter(t)

	if w := doSetFrozen(t, r, idA, `{"frozen":true}`); w.Code != http.StatusOK {
		t.Fatalf("freeze: expected 200, got %d", w.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/ahead-behind", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ahead-behind: expected 200, got %d", w.Code)
	}
	var res struct {
		Data map[string]struct {
			Ahead  int `json:"ahead"`
			Behind int `json:"behind"`
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := res.Data[idA]; ok {
		t.Fatal("frozen project must be skipped in batch ahead/behind probe")
	}
	if _, ok := res.Data[idB]; !ok {
		t.Fatal("active project must still be probed")
	}

	// 解冻后恢复探测
	if w := doSetFrozen(t, r, idA, `{"frozen":false}`); w.Code != http.StatusOK {
		t.Fatalf("unfreeze: expected 200, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/ahead-behind", nil))
	res = struct {
		Data map[string]struct {
			Ahead  int `json:"ahead"`
			Behind int `json:"behind"`
		}
	}{}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal after unfreeze: %v", err)
	}
	if _, ok := res.Data[idA]; !ok {
		t.Fatal("unfrozen project must be probed again")
	}
}
