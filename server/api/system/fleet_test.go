package system

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/claims"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// ── 实例族总览（P-20261003-56）──
// 覆盖：claim 只读聚合（多实例多项目归并/最新心跳端口胜出/残留标记）、
// 聚合端点三态探活（本机 self + 活实例 httptest 真身 + 死实例端口）、
// 残留清理端点（自清拒绝/未知 404/活实例拒清/死实例真删）

// fleetRepo 造带 .git 锚点的项目目录并注册进 store，返回项目路径
func fleetRepo(t *testing.T, id, name string) string {
	t.Helper()
	p := t.TempDir()
	if err := os.MkdirAll(filepath.Join(p, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.Get().Project.Create(config.ProjectConfig{ID: id, Name: name, Path: p}); err != nil {
		t.Fatal(err)
	}
	return p
}

// fleetPlant 写一条 claim（age>0 回拨 updatedAt 造残留）
func fleetPlant(t *testing.T, repo, instanceID string, port int, age time.Duration) {
	t.Helper()
	now := time.Now().Add(-age)
	if err := claims.WriteClaim(claims.ResolveGitDir(repo), claims.Claim{
		InstanceID: instanceID, Port: port, StartedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
}

// fleetRouter 装配 store + SC_DATA_DIR（claims.InstanceID 经它定位实例身份）
// + 注册两条 fleet 路由的最小引擎
func fleetRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir())
	store.SetDefault(store.New(filestore.New(filepath.Join(t.TempDir(), "data"))))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.GET("/api/instances/fleet", InstanceFleet)
	r.DELETE("/api/instances/fleet/:instanceId", CleanFleetResidual)
	return r
}

// fleetDo 发请求并解出 data 载荷
func fleetDo(t *testing.T, r *gin.Engine, method, path string) (int, json.RawMessage) {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	var resp struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not fleet envelope: %v body=%s", err, w.Body.String())
	}
	return w.Code, resp.Data
}

// fleetRows 解出族表行
func fleetRows(t *testing.T, raw json.RawMessage) []fleetInstance {
	t.Helper()
	var rows []fleetInstance
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("fleet rows not decodable: %v raw=%s", err, raw)
	}
	return rows
}

// closedPort 找一个当前无人监听的回环端口（死实例探活目标）
func closedPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

// livePeer 起一个 /api/settings 返回本应用格式的 httptest 真身，返回其端口
func livePeer(t *testing.T, version string) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"data":{"version":%q}}`, version)
	}))
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

func TestInstanceFleet_AggregationAndProbe(t *testing.T) {
	r := fleetRouter(t)
	repoA := fleetRepo(t, "proj-a", "项目A")
	repoB := fleetRepo(t, "proj-b", "项目B")

	live := livePeer(t, "9.9.9-e2e")
	dead := closedPort(t)
	// 本实例自己的 claim（self 行项目清单来源）+ 活实例双项目占用；
	// 死实例单项目 + 一条旧心跳（freshest 端口仍归活探活定）
	selfID, err := claims.InstanceID(config.DataDir())
	if err != nil {
		t.Fatal(err)
	}
	fleetPlant(t, repoA, selfID, 9999, 0)
	fleetPlant(t, repoB, selfID, 9999, 0)
	fleetPlant(t, repoA, "peer-live", live, 0)
	fleetPlant(t, repoB, "peer-live", live, 10*time.Second)
	fleetPlant(t, repoA, "peer-dead", dead, 0)

	code, raw := fleetDo(t, r, "GET", "/api/instances/fleet")
	if code != 200 {
		t.Fatalf("expected 200, got %d", code)
	}
	rows := fleetRows(t, raw)
	if len(rows) != 3 {
		t.Fatalf("expected 3 fleet rows (self + 2 peers), got %d: %s", len(rows), raw)
	}

	// self 恒排最前且恒活，项目清单来自自己的 claim
	self := rows[0]
	if !self.Self || self.Status != "self" {
		t.Fatalf("first row should be self, got %+v", self)
	}
	if len(self.Projects) != 2 {
		t.Fatalf("self should have 2 claimed projects, got %+v", self.Projects)
	}

	var liveRow, deadRow *fleetInstance
	for i := range rows {
		switch rows[i].InstanceID {
		case "peer-live":
			liveRow = &rows[i]
		case "peer-dead":
			deadRow = &rows[i]
		}
	}
	if liveRow == nil || deadRow == nil {
		t.Fatalf("peer rows missing: %s", raw)
	}
	if liveRow.Status != "online" || liveRow.Version != "9.9.9-e2e" {
		t.Fatalf("live peer should be online with version, got %+v", liveRow)
	}
	if len(liveRow.Projects) != 2 {
		t.Fatalf("live peer should aggregate 2 projects, got %+v", liveRow.Projects)
	}
	if liveRow.Stale {
		t.Fatalf("live peer with fresh heartbeat must not be stale")
	}
	if deadRow.Status != "offline" {
		t.Fatalf("dead peer should be offline, got %+v", deadRow)
	}
	if deadRow.Stale {
		t.Fatalf("dead peer claim is fresh (age 0), must not be stale yet")
	}
}

func TestInstanceFleet_StaleResidualFlagged(t *testing.T) {
	r := fleetRouter(t)
	repo := fleetRepo(t, "proj-a", "项目A")
	// 超 StaleAfter 未续期 = 崩溃残留（探活也当离线处理：端口同样无真身）
	fleetPlant(t, repo, "peer-crashed", closedPort(t), claims.StaleAfter+time.Minute)

	code, raw := fleetDo(t, r, "GET", "/api/instances/fleet")
	if code != 200 {
		t.Fatalf("expected 200, got %d", code)
	}
	rows := fleetRows(t, raw)
	if len(rows) != 2 {
		t.Fatalf("expected self + 1 residual peer, got %s", raw)
	}
	if rows[1].InstanceID != "peer-crashed" || !rows[1].Stale || rows[1].Status != "offline" {
		t.Fatalf("residual peer should be stale+offline, got %+v", rows[1])
	}
}

func TestCleanFleetResidual(t *testing.T) {
	r := fleetRouter(t)
	repo := fleetRepo(t, "proj-a", "项目A")

	selfID, err := claims.InstanceID(config.DataDir())
	if err != nil {
		t.Fatal(err)
	}

	// 自清拒绝：本实例 claim 由心跳/退出清理管理，外部删除会打架
	if code, _ := fleetDo(t, r, "DELETE", "/api/instances/fleet/"+selfID); code != 400 {
		t.Fatalf("self cleanup should be 400, got %d", code)
	}
	// 未知实例：无残留可清
	if code, _ := fleetDo(t, r, "DELETE", "/api/instances/fleet/nobody"); code != 404 {
		t.Fatalf("unknown instance cleanup should be 404, got %d", code)
	}

	// 活实例拒清：同 instanceId 意味着同一数据目录实例重启了，心跳会重写
	live := livePeer(t, "9.9.9")
	fleetPlant(t, repo, "peer-restarted", live, 0)
	if code, _ := fleetDo(t, r, "DELETE", "/api/instances/fleet/peer-restarted"); code != 409 {
		t.Fatalf("alive instance cleanup should be 409, got %d", code)
	}

	// 死实例真删：claim 文件物理消失（staleness 惰性回收之外的「立即清」）
	dead := closedPort(t)
	fleetPlant(t, repo, "peer-dead", dead, 0)
	claimFile := filepath.Join(claims.ClaimDir(claims.ResolveGitDir(repo)), "peer-dead.json")
	if _, err := os.Stat(claimFile); err != nil {
		t.Fatalf("planted claim file missing: %v", err)
	}
	code, raw := fleetDo(t, r, "DELETE", "/api/instances/fleet/peer-dead")
	if code != 200 {
		t.Fatalf("dead instance cleanup should be 200, got %d body=%s", code, raw)
	}
	if !strings.Contains(string(raw), `"removed":1`) {
		t.Fatalf("cleanup should report removed=1, got %s", raw)
	}
	if _, err := os.Stat(claimFile); !os.IsNotExist(err) {
		t.Fatalf("claim file should be removed, stat err=%v", err)
	}
}

func TestFleetProbeURL(t *testing.T) {
	// 探活目标恒为回环 + 数字端口（claim 只有 port，同机前提）；localhost
	// 可能解析到 ::1 而服务只听 IPv4，故固定 127.0.0.1
	if got := fleetProbeURL(11018); got != "http://127.0.0.1:11018" {
		t.Fatalf("fleetProbeURL = %q", got)
	}
}
