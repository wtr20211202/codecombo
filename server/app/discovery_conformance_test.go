package app

import (
	"io"
	"log/slog"
	"sort"
	"strings"
	"testing"

	"codecombo/server/api"
	"codecombo/server/config"
	"codecombo/server/kernel"

	"github.com/gin-gonic/gin"
)

// 发现面一致性守护测试（P-20261002-133 建立对账，P-20261003-153 改推导语义）。
//
// 动机：前端与外部 Agent 的能力感知依赖 /api/modules（HandleListModules）。
// Manifest.Routes 已从手工声明改为推导填充——路由能力族在 api 注册面声明
//（api/routefamily.go 的 moduleRouteFamilies），组合根按真实路由表推导组装
//（modules.go manifestRoutes）。本测试守护推导链的完整性：
//   - 路由→Manifest（推导完整性 = 实际路由全集）：组合根真实路由表
//    （RegisterRoutes 收口快照）里每个可发现端点都必须被某个 Manifest 条目
//     覆盖，或属白名单（内部端点 / 暂无归属模块的族）；
//   - 声明族不悬空：api 声明表中推导未命中的族必须为空（防笔误静默缩水
//     发现面——推导会丢弃未命中族，只有这里能拦）；
//   - Manifest→路由：每个 Manifest 条目都必须至少命中一条真实路由（清单
//     不悬空），或属显式登记的例外（历史兼容面 / 外部子服务面）；
//   - 组装=推导：每个模块的 Manifest.Routes 必须恰等于注册面推导结果 +
//     白名单例外——防止绕过机制恢复手写 Routes。
//
// 匹配语义：Manifest 条目是粗粒度能力面前缀（如 /api/projects/:id/*、
// /ws/deploy/:taskId），折算为「首个参数/通配段之前的前缀」后做前缀匹配
//（FamilyPrefix，推导与对账共用同一实现）；对账按路径进行（清单不含
// 方法维度）。
//
// 白名单（对账清单豁免，删除端点时必须同步修剪——防腐化子测试强制）：
//   ①内部/非发现端点：健康探针、指标、停机通道、发现端点自身、预览反代、
//     公开文档；
//   ②暂无归属模块的能力族：每条注明理由（归属模块落地后迁入
//     moduleRouteFamilies 并从此修剪）；
//   ③访客面静态资产：分享页 vendored 资源（浏览器直载，非能力端点）。

// routeWhitelist 路由侧豁免：路径前缀 → 豁免理由
var routeWhitelist = map[string]string{
	// ①内部/非发现端点
	"/api/health":          "健康探针，不受任何中间件保护（router.go 尾注）",
	"/api/metrics":         "Prometheus 指标出口，系统元数据非能力面",
	"/api/shutdown":        "本机优雅停机通道（回环+自定义头双约束），非能力端点",
	"/api/restart":         "本机优雅重启通道（回环+自定义头双约束，P-20261106 页面重启链），非能力端点——同 shutdown 族",
	"/api/modules":         "发现端点自身，无需自登记",
	"/api/meta":            "能力探测端点自身（版本+能力聚合，P-20261004-4）——发现端点同级免自登记",
	"/api/whoami":          "令牌自校验引导端点自身（tokenKind+capabilities 摘要，P-20261004-15）——自描述元端点免自登记，同 /api/meta",
	"/preview/:port/*path": "端口预览回环反代，传输通道非能力端点",
	"/ops-manual":          "公开只读操作手册文档（描述能力而非能力本身）",
	"/api/help":            "公开只读帮助中心文档，同 ops-manual",
	"/api/whats-new":       "版本更新内容文档（docs/whatsnew.md 嵌入面，P-20261007-17）——内容型文档非能力面，同 /api/help",
	// ②暂无归属模块的能力族（dsh 模块化时迁入 moduleRouteFamilies 并修剪本条）
	"/api/tools": "dsh 工具集成管理面（router.go tools 组）——尚无 owning kernel 模块",
	// ③访客面静态资产（P-20261020-2）：分享页 vendored xterm 三件经主引擎
	// 同源直通 /assets/<name>（router.go serveShareSameOrigin，白名单单一事实源
	// share.AssetNames），浏览器 <script>/<link> 直载——访客渲染资源，非 agent
	// 能力端点；/s/* 由 share 模块 Manifest extras（/s/:token）覆盖
	"/assets/xterm.js":     "分享访客页 vendored 资产（xterm 运行时）——浏览器直载，非能力端点",
	"/assets/addon-fit.js": "分享访客页 vendored 资产（xterm addon）——同上",
	"/assets/xterm.css":    "分享访客页 vendored 资产（xterm 样式）——同上",
}

// manifestWhitelist 清单侧例外：推导覆盖不了的显式 extras 条目（均在码有注释背书）
var manifestWhitelist = map[string]string{
	"/api/agent-chat": "端点已随定位调整移除，条目保留供历史发现面兼容（modules.go ai extras）",
	"/s/:token":       "分享访客短链入口（P-20261020-2 起 /s/* 同时挂在主引擎匿名直通分享子服务，独立端口监听保留）——访客面非 agent 能力，extras 条目保留（modules.go share extras）",
}

// discoveryFace 组合根两侧的真实装配：路由收口快照 + 逐模块 Manifest 发现清单。
// 只 Register 不 Init/Start——builtinModules 各构造器均为纯结构体装配，
// kernel.Register 仅登记元数据，零副作用（ops_module_test.go 同款零值 config）
func discoveryFace(t *testing.T) (routes api.RouteTable, byModule map[string][]string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	r := gin.New()
	routes = api.RegisterRoutes(r)

	k := kernel.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	registerAll(k, builtinModules(&config.Config{}, runtimeInfo{}, routes))
	byModule = map[string][]string{}
	for _, m := range k.Modules() {
		byModule[m.Manifest.Name] = m.Manifest.Routes
	}
	return routes, byModule
}

func TestDiscoveryConformance(t *testing.T) {
	routes, byModule := discoveryFace(t)

	// 全部 Manifest 条目摊平（覆盖检查用）
	var entries []string
	for _, es := range byModule {
		entries = append(entries, es...)
	}

	t.Run("路由→Manifest：可发现端点全覆盖（推导完整性=实际路由全集）", func(t *testing.T) {
		var missing []string
		for _, p := range routes {
			covered := false
			for key := range routeWhitelist {
				if strings.HasPrefix(p, key) {
					covered = true
					break
				}
			}
			if !covered {
				for _, e := range entries {
					if strings.HasPrefix(p, api.FamilyPrefix(e)) {
						covered = true
						break
					}
				}
			}
			if !covered {
				missing = append(missing, p)
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			t.Errorf("发现面遗漏：%d 个端点未被任何 Manifest.Routes 覆盖（族内新端点应自动推导覆盖——检查其路径前缀是否落进 api/routefamily.go 既有族；全新族在该表补一行；确认属内部端点后登记白名单并注明理由）：\n%s",
				len(missing), strings.Join(missing, "\n"))
		}
	})

	t.Run("声明族不悬空：推导未命中必须为空", func(t *testing.T) {
		for _, mod := range api.RouteFamilyModules() {
			_, unmatched := api.DeriveRouteFamilies(routes, mod)
			if len(unmatched) > 0 {
				sort.Strings(unmatched)
				t.Errorf("模块 %s 的声明族无一命中真实路由（笔误或端点已删除，修剪 api/routefamily.go）：%v", mod, unmatched)
			}
		}
	})

	t.Run("Manifest→路由：清单条目不悬空", func(t *testing.T) {
		var stale []string
		for _, e := range entries {
			if _, exempt := manifestWhitelist[e]; exempt {
				continue
			}
			prefix := api.FamilyPrefix(e)
			hit := false
			for _, p := range routes {
				if strings.HasPrefix(p, prefix) {
					hit = true
					break
				}
			}
			if !hit {
				stale = append(stale, e)
			}
		}
		if len(stale) > 0 {
			sort.Strings(stale)
			t.Errorf("Manifest 悬空条目：%v——发现面指向无真实路由的能力（修剪声明族/extras，或按注释理由登记 manifestWhitelist）", stale)
		}
	})

	t.Run("组装=推导：清单恰为注册面推导结果+登记例外", func(t *testing.T) {
		for mod, es := range byModule {
			derived, _ := api.DeriveRouteFamilies(routes, mod)
			want := map[string]bool{}
			for _, f := range derived {
				want[f] = true
			}
			var handWritten, extraDerived []string
			for _, e := range es {
				if _, extra := manifestWhitelist[e]; extra {
					continue
				}
				if want[e] {
					delete(want, e)
				} else {
					handWritten = append(handWritten, e)
				}
			}
			for f := range want {
				extraDerived = append(extraDerived, f)
			}
			sort.Strings(handWritten)
			sort.Strings(extraDerived)
			if len(handWritten) > 0 {
				t.Errorf("模块 %s 的清单条目 %v 不是注册面推导结果——Routes 被手写了？应经 modules.go manifestRoutes() 推导填充（P-20261003-153）", mod, handWritten)
			}
			if len(extraDerived) > 0 {
				t.Errorf("模块 %s 的推导族 %v 未进清单——组装被过滤/遗漏？modules.go 该模块应走 manifestRoutes() 全量填充", mod, extraDerived)
			}
		}
	})

	t.Run("白名单防腐化：豁免条目必须仍指向现实", func(t *testing.T) {
		var dead []string
		for key := range routeWhitelist {
			hit := false
			for _, p := range routes {
				if strings.HasPrefix(p, key) {
					hit = true
					break
				}
			}
			if !hit {
				dead = append(dead, key)
			}
		}
		for key := range manifestWhitelist {
			live := false
			for _, es := range byModule {
				for _, e := range es {
					if e == key {
						live = true
					}
				}
			}
			if !live {
				dead = append(dead, key)
			}
		}
		if len(dead) > 0 {
			sort.Strings(dead)
			t.Errorf("白名单失配（指向的端点/清单条目已消失，须同步修剪豁免）：%v", dead)
		}
	})
}
