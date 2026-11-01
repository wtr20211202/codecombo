package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	mw "codecombo/server/middleware"
	"codecombo/server/store"
)

// 项目硬锁（P-20261004-3）守卫覆盖面对账：从真实路由表枚举全部项目级写路由，
// 对 locked 项目逐一断言 403 + 稳定标记（防漏），对未锁项目断言零误伤
//（不 403）。写路由在守卫处中止、handler 不执行，枚举请求对存储面无副作用。

// lockAllowlist 硬锁放行的项目级写路由（方法+路径模板）：管理面/元数据层，
// 不触达归档内容
var lockAllowlist = map[string]bool{
	"PUT:/api/projects/:id/locked":                   true, // 唯一解锁路径
	"PUT:/api/projects/:id/frozen":                   true, // 呈现层开关，与硬锁独立
	"PUT:/api/projects/:id":                          true, // 重定位（目录搬家后恢复可读的注册面）
	"DELETE:/api/projects/:id":                       true, // 移除注册（磁盘内容不动）
	"PUT:/api/projects/:id/notes":                    true, // 项目笔记是车道 1 元数据，不在归档内
	"POST:/api/projects/:id/terminal-history":        true, // 终端命令历史元数据
	"DELETE:/api/projects/:id/terminal-history":      true, // 同上
	"DELETE:/api/projects/:id/terminal-history/:idx": true, // 同上
	// POST 形态的只读面（内容生成/校验，不落盘不触网写）：
	"POST:/api/projects/:id/patch/export":    true, // 生成 patch 文本返回，不写仓库
	"POST:/api/projects/:id/patch/check":     true, // 校验 patch 可应用性，不写仓库
	"POST:/api/projects/:id/reveal":          true, // 打开宿主文件管理器定位（P-20261003-323），只读面
	"POST:/api/projects/:id/replace/preview": true, // 批量替换命中预览（P-20261004-114），纯读不写盘——执行面 /replace 照常入硬锁
}

// extraParamRe 项目 id 之后的其余路径参数（:commit/:name/:index/:idx）——
// 守卫在绑定/校验前中止，哑值即可
var extraParamRe = regexp.MustCompile(`:[a-zA-Z]+`)

func setupHardLockRouter(t *testing.T) (*gin.Engine, string, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	// reveal 在零误伤枚举里会被真执行（未锁项目方向 handler 不被守卫中止）：
	// 桩住 exec 层，枚举不真开宿主文件管理器窗口（P-20261003-323 测试钩子）
	t.Setenv("CC_REVEAL_STUB_DIR", t.TempDir())

	// 锁功能关闭态（LockMiddleware 直通），只验项目硬锁自身
	if err := store.Get().Lock.SaveConfig(store.LockConfig{
		Enabled:      false,
		PasswordHash: store.DEFAULT_PASSWORD_HASH,
	}); err != nil {
		t.Fatalf("save lock config: %v", err)
	}

	dirLock := t.TempDir()
	dirOpen := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "proj-lock", Name: "archived", Path: dirLock, Locked: true}); err != nil {
		t.Fatalf("create locked project: %v", err)
	}
	if err := store.Get().Project.Create(config.ProjectConfig{ID: "proj-open", Name: "open", Path: dirOpen}); err != nil {
		t.Fatalf("create open project: %v", err)
	}

	r := gin.New()
	RegisterRoutes(r)
	return r, dirLock, dirOpen
}

// projectWriteRoutes 枚举真实路由表中全部项目级非 GET 路由
func projectWriteRoutes(r *gin.Engine) []gin.RouteInfo {
	var out []gin.RouteInfo
	for _, ri := range r.Routes() {
		if ri.Method == http.MethodGet {
			continue
		}
		if strings.HasPrefix(ri.Path, "/api/projects/:id") {
			out = append(out, ri)
		}
	}
	return out
}

func fire(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestHardLockGuardsEveryProjectWriteRoute 防漏对账：项目级写路由（除白名单）
// 对 locked 项目必须全部 403 且明文含稳定标记 project.locked
func TestHardLockGuardsEveryProjectWriteRoute(t *testing.T) {
	r, _, _ := setupHardLockRouter(t)

	routes := projectWriteRoutes(r)
	if len(routes) < 50 {
		t.Fatalf("project write routes unexpectedly few (%d)——路由表结构变了，对账清单需复核", len(routes))
	}
	checked := 0
	for _, ri := range routes {
		key := ri.Method + ":" + ri.Path
		if lockAllowlist[key] {
			continue
		}
		path := strings.Replace(ri.Path, ":id", "proj-lock", 1)
		path = extraParamRe.ReplaceAllString(path, "x")
		w := fire(r, ri.Method, path, `{}`)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %s → %d（want 403）守卫缺漏；body=%s", ri.Method, path, w.Code, w.Body.String())
			continue
		}
		if !strings.Contains(w.Body.String(), mw.ProjectLockedMarker) {
			t.Errorf("%s %s 403 但缺少稳定标记 %q", ri.Method, path, mw.ProjectLockedMarker)
		}
		checked++
	}
	t.Logf("hard-lock guard coverage: %d write routes denied", checked)
	if checked < 50 {
		t.Fatalf("only %d routes checked——低于写族预期规模，grep router.go 核对守卫接线", checked)
	}
}

// TestHardLockNoCollateralOnOpenProject 零误伤：同一路由表对未锁项目
// 不出现 403（handler 正常执行，结果码随夹具各异——非 git 临时目录多为
// 400/404/500，均属合法非 403）
func TestHardLockNoCollateralOnOpenProject(t *testing.T) {
	r, _, _ := setupHardLockRouter(t)

	for _, ri := range projectWriteRoutes(r) {
		key := ri.Method + ":" + ri.Path
		if lockAllowlist[key] {
			continue
		}
		if ri.Path == "/api/terminals" {
			// 建终端会 handler 真执行（PTY 起会话），单测枚举不开真会话；
			// 其锁定方向的 403 由 TestHardLockTerminalCreation 单测覆盖
			continue
		}
		if ri.Path == "/api/projects/:id/lfs/install" {
			// git lfs install 无 --local 时写全局 gitconfig——未锁方向枚举
			// 不执行它（锁定方向守卫中止，仍在对账覆盖内）
			continue
		}
		path := strings.Replace(ri.Path, ":id", "proj-open", 1)
		path = extraParamRe.ReplaceAllString(path, "x")
		w := fire(r, ri.Method, path, `{}`)
		if w.Code == http.StatusForbidden {
			t.Errorf("%s %s 对未锁项目误伤 403；body=%s", ri.Method, path, w.Body.String())
		}
	}
}

// TestHardLockLockUnlockRestoreCycle 锁→写 403→读放行→解锁→写恢复 + 双向审计
func TestHardLockLockUnlockRestoreCycle(t *testing.T) {
	r, _, _ := setupHardLockRouter(t)

	// 锁定（经真实端点，白名单路由不受守卫限制）
	w := fire(r, http.MethodPut, "/api/projects/proj-open/locked", `{"locked":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("lock: expected 200, got %d body=%s", w.Code, w.Body.String())
	}

	// 锁内：文件写族 403 + 标记（真实路由，守卫中止于 handler 前）
	w = fire(r, http.MethodPost, "/api/projects/proj-open/file/create", `{"path":"a.txt"}`)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), mw.ProjectLockedMarker) {
		t.Fatalf("locked write: want 403+marker, got %d body=%s", w.Code, w.Body.String())
	}
	// 锁内：git 写族（stage）403
	w = fire(r, http.MethodPost, "/api/projects/proj-open/stage", `{"files":["a.txt"]}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("locked stage: want 403, got %d body=%s", w.Code, w.Body.String())
	}
	// 锁内：读面放行（项目详情 200）
	w = fire(r, http.MethodGet, "/api/projects/proj-open", "")
	if w.Code != http.StatusOK {
		t.Fatalf("locked read: want 200, got %d body=%s", w.Code, w.Body.String())
	}
	// 锁内：项目列表带出 locked=true
	w = fire(r, http.MethodGet, "/api/projects", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list: want 200, got %d", w.Code)
	}
	var list struct {
		Data []struct {
			ID     string `json:"id"`
			Locked bool   `json:"locked"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	lockedSeen := false
	for _, p := range list.Data {
		if p.ID == "proj-open" {
			lockedSeen = p.Locked
		}
	}
	if !lockedSeen {
		t.Fatal("list must carry locked=true for locked project")
	}

	// 解锁恢复：同一条文件写路由放行（files 包不依赖 git，临时目录即可建文件）
	w = fire(r, http.MethodPut, "/api/projects/proj-open/locked", `{"locked":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("unlock: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	w = fire(r, http.MethodPost, "/api/projects/proj-open/file/create", `{"path":"a.txt","content":"hi"}`)
	if w.Code == http.StatusForbidden {
		t.Fatalf("after unlock write must be allowed, got 403 body=%s", w.Body.String())
	}

	// 双向审计：project.lock 与 project.unlock 均入账
	events, _, err := store.Get().Audit.List(50, 0)
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	sawLock, sawUnlock := false, false
	for _, e := range events {
		if e.Action == store.AuditProjectLock {
			sawLock = true
		}
		if e.Action == store.AuditProjectUnlock {
			sawUnlock = true
		}
	}
	if !sawLock || !sawUnlock {
		t.Fatalf("bidirectional audit missing: lock=%v unlock=%v", sawLock, sawUnlock)
	}
}

// TestHardLockTerminalCreationDenied 终端创建三面之守卫：projectId 命中
// locked 项目 403（守卫中止于 CreateSession 前，无真实会话副作用）
func TestHardLockTerminalCreationDenied(t *testing.T) {
	r, dirLock, _ := setupHardLockRouter(t)

	// 项目终端：projectId 指向 locked 项目
	w := fire(r, http.MethodPost, "/api/terminals", `{"projectId":"proj-lock"}`)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), mw.ProjectLockedMarker) {
		t.Fatalf("project terminal: want 403+marker, got %d body=%s", w.Code, w.Body.String())
	}

	// agent 会话：dir 落在 locked 项目内（含子目录）同样 403
	for _, d := range []string{dirLock, dirLock + string([]byte{'/'}) + "sub"} {
		body, _ := json.Marshal(map[string]string{"kind": "agent", "dir": d})
		w = fire(r, http.MethodPost, "/api/terminals", string(body))
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), mw.ProjectLockedMarker) {
			t.Fatalf("agent terminal dir=%s: want 403+marker, got %d body=%s", d, w.Code, w.Body.String())
		}
	}
}

// TestFetchAllSkipsLockedProjects 批量拉取旁路（不经路由守卫）对 locked
// 项目逐项标跳过且不执行 fetch（错误串含稳定标记）
func TestFetchAllSkipsLockedProjects(t *testing.T) {
	r, _, _ := setupHardLockRouter(t)

	w := fire(r, http.MethodPost, "/api/fetch-all", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("fetch-all: want 200, got %d", w.Code)
	}
	var res struct {
		Data []struct {
			ProjectID string `json:"projectId"`
			Error     string `json:"error"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	found := false
	for _, it := range res.Data {
		if it.ProjectID == "proj-lock" {
			found = true
			if !strings.Contains(it.Error, mw.ProjectLockedMarker) {
				t.Fatalf("locked item error must carry marker, got %q", it.Error)
			}
		}
	}
	if !found {
		t.Fatal("locked project must appear in fetch-all report (explicit skip)")
	}
}
