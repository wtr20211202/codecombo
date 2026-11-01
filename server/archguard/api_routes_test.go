package archguard_test

// API 路由契约面 dump（P-20261004-77）：把 RegisterRoutes 组合根收口的真实
// 路由全集（gin Routes → 方法+路径对）固化为已提交快照
// server/archguard/testdata/api-routes.json，作为前端 API client 路径对账
//（web/scripts/check-api-routes.mjs，npm run check:api-routes）的路由侧事实源。
//
// 动机：~300 条 gin 路由与 web/src/api/domains 手写客户端之间零对账——前端
// 路径拼写/参数形态漂移在 TS 编译期不可见，运行期表现为 404。与手册路由覆盖
//（manual_routes_test.go）/ payload 字段快照（payloadfields_test.go）/
// meta 能力项对账（app/meta_conformance_test.go）同族，构成 API 契约防线的
// 「路由路径」轴：本测试守「快照 ↔ 真实路由表」不漂移，Node 侧脚本守
// 「前端 domains 调用面 ↔ 快照」不漂移，两层合成双端第三轴。
//
// 为什么走快照而非让 Node 脚本直接解析 Go 源码：路由注册分散在 router.go 与
// 各能力包的 Group 声明里（嵌套 Group 拼接、:param 通配），静态解析路由表
// 等于重写 gin 的路由树；gin Routes() 是注册语义的唯一权威。快照让前端门禁
// 无需 Go 工具链即可对账，而快照本身的新鲜度由本测试钉住——路由增删改名
// 当轮 go test 即红，重写走显式 env 开关，diff 进评审（payload 快照同纪律）。
//
// 口径：
//   - 全部 (method, path) 对，过滤到 axios 可达五方法 GET/POST/PUT/DELETE/
//     PATCH——HEAD/OPTIONS/CONNECT/TRACE 是 gin Any 的传输变体（手册路由
//     覆盖同款豁免口径），不构成前端契约面；GET 亦是 WS 路由的注册方法。
//   - 键为 "METHOD path"（gin 形态 :param/*wild），排序输出，跨平台确定。
//   - 数量下限防注册链断裂失明（RegisterRoutes 中途 panic-恢复/早退类事故
//     会产出残缺路由表，快照重写静默缩水在此先红）。
//
// 更新纪律：路由有意变更 → CC_UPDATE_API_ROUTES=1 go test ./server/archguard/
// -run TestAPIRouteDump 重写快照 → npm run check:api-routes 看前端对账结果
// （新增路由无人消费=WARN 处置、删除/改名牵连的前端调用=ERROR 必修），
// 快照 diff 随本提交评审。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"codecombo/server/api"

	"github.com/gin-gonic/gin"
)

// updateAPIRoutesEnv 有意变更时的快照重写开关（置 1 生效）。
const updateAPIRoutesEnv = "CC_UPDATE_API_ROUTES"

// dumpedMethods 快照收录的 HTTP 方法集：axios 客户端（web/src/api/http.ts）
// 可达的五个动词。HEAD/OPTIONS/CONNECT/TRACE（gin Any 传输变体）不入契约面。
var dumpedMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "DELETE": true, "PATCH": true,
}

// MIN_DUMPED_ROUTES 路由数量下限（防注册链断裂/提取失明产出残缺快照）。
// 取现存量留余量；大规模扩面前先跑一次 dump 看实数再上调。
const MIN_DUMPED_ROUTES = 250

// apiRoute 快照条目：gin 注册语义的 (method, path) 对。
type apiRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

func (r apiRoute) key() string { return r.Method + " " + r.Path }

// TestAPIRouteDump 真实路由表 ↔ 快照对账（漂移即红，env 开关重写）。
func TestAPIRouteDump(t *testing.T) {
	// 真实路由表：RegisterRoutes 收口（只注册不启动，manual_routes_test 同款装配）
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api.RegisterRoutes(r)

	live := make([]apiRoute, 0, len(r.Routes()))
	for _, ri := range r.Routes() {
		if !dumpedMethods[ri.Method] {
			continue
		}
		live = append(live, apiRoute{Method: ri.Method, Path: ri.Path})
	}
	slices.SortFunc(live, func(a, b apiRoute) int {
		if c := strings.Compare(a.Path, b.Path); c != 0 {
			return c
		}
		return strings.Compare(a.Method, b.Method)
	})
	if len(live) < MIN_DUMPED_ROUTES {
		t.Fatalf("dump 路由数 %d < 下限 %d——路由注册链疑似断裂，先排查 RegisterRoutes 再谈重写快照", len(live), MIN_DUMPED_ROUTES)
	}

	path := apiRoutesPath(t)
	if os.Getenv(updateAPIRoutesEnv) == "1" {
		writeAPIRoutesSnapshot(t, path, live)
	}
	want := readAPIRoutesSnapshot(t, path)

	liveKeys := make(map[string]bool, len(live))
	for _, rt := range live {
		liveKeys[rt.key()] = true
	}
	wantKeys := make(map[string]bool, len(want))
	for _, rt := range want {
		wantKeys[rt.key()] = true
	}

	var added, removed []string
	for _, rt := range live {
		if !wantKeys[rt.key()] {
			added = append(added, rt.key())
		}
	}
	for _, rt := range want {
		if !liveKeys[rt.key()] {
			removed = append(removed, rt.key())
		}
	}
	if len(added) == 0 && len(removed) == 0 {
		return
	}
	t.Errorf("API 路由契约面漂移（快照 ↔ RegisterRoutes 实际注册）\n  新增 (+): %v\n  删除 (-): %v\n  有意变更：%s=1 go test ./server/archguard/ -run TestAPIRouteDump 重写快照，随后 npm run check:api-routes 看前端调用面对账结果（牵连的前端调用失配必修）",
		added, removed, updateAPIRoutesEnv)
}

// apiRoutesPath 定位快照文件（随本文件编译期路径走，不依赖测试进程 cwd，
// payloadfields 的 snapshotPath 同款）。
func apiRoutesPath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 api_routes_test.go 源文件路径")
	}
	return filepath.Join(filepath.Dir(thisFile), "testdata", "api-routes.json")
}

// readAPIRoutesSnapshot 读取已提交快照；条目序就地排序（手改乱序不产生幻影 diff）。
func readAPIRoutesSnapshot(t *testing.T, path string) []apiRoute {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取路由快照失败: %v\n首跑引导：%s=1 go test ./server/archguard/ -run TestAPIRouteDump 生成并提交 %s",
			err, updateAPIRoutesEnv, path)
	}
	var snap struct {
		Routes []apiRoute `json:"routes"`
	}
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("路由快照非法 JSON（%s）: %v", path, err)
	}
	for i := range snap.Routes {
		rt := snap.Routes[i]
		if !dumpedMethods[rt.Method] || !strings.HasPrefix(rt.Path, "/") {
			t.Fatalf("路由快照条目非法（%q）——gin 路由形态为五方法 + / 起步路径", rt.key())
		}
	}
	slices.SortFunc(snap.Routes, func(a, b apiRoute) int {
		if c := strings.Compare(a.Path, b.Path); c != 0 {
			return c
		}
		return strings.Compare(a.Method, b.Method)
	})
	return snap.Routes
}

// writeAPIRoutesSnapshot 重写快照：注释头 + 逐条一行缩进 JSON，git diff 即
// 逐路由评审材料（输出跨平台确定，无 CRLF/平台路径因素）。
func writeAPIRoutesSnapshot(t *testing.T, path string, live []apiRoute) {
	t.Helper()
	var b strings.Builder
	b.WriteString("{\n")
	b.WriteString(`  "comment": "API 路由契约面快照（P-20261004-77）：RegisterRoutes 组合根真实注册的路由全集（gin Routes），`)
	b.WriteString(`过滤到 axios 可达五方法 GET/POST/PUT/DELETE/PATCH。消费方：web/scripts/check-api-routes.mjs（npm run check:api-routes）做前端 domains 调用面对账。`)
	b.WriteString(`勿手改——路由变更后以 CC_UPDATE_API_ROUTES=1 go test ./server/archguard/ -run TestAPIRouteDump 重写。",`)
	b.WriteString(fmt.Sprintf("\n  \"routeCount\": %d,", len(live)))
	b.WriteString("\n  \"routes\": [")
	for i, rt := range live {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(fmt.Sprintf("\n    {\"method\": %q, \"path\": %q}", rt.Method, rt.Path))
	}
	b.WriteString("\n  ]\n}\n")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建快照目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatalf("写入路由快照失败（%s）: %v", path, err)
	}
	t.Logf("路由快照已重写: %s（%d 条；diff 随本提交评审）", path, len(live))
}
