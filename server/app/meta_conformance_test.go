package app

import (
	"io"
	"log/slog"
	"sort"
	"testing"

	"codecombo/server/api"
	"codecombo/server/config"
	"codecombo/server/kernel"

	"github.com/gin-gonic/gin"
)

// meta↔路由对账守护测试（P-20261004-4 加固注记，P-20261002-133 同思路）。
//
// 动机：/api/meta 的能力清单来自 builtinModules 里的 Manifest.Capabilities
// 手工声明——「端点上线漏登能力项」「能力项指向已删除端点」此前只能靠人工
// 记忆。本测试把它变成 CI 门禁：
//   - 能力项→映射：每个声明的能力项必须在 capabilityRoutes 有对账映射
//    （防止随手上能力项却不给对账凭据）；
//   - 能力项→路由：映射指向的路由必须在真实路由表中存在（清单不悬空）；
//   - 映射→声明：对账映射每条都必须仍被某个模块声明（端点删除时强制
//     同步修剪映射与声明，防腐化）。
//
// 语义：能力项是「跨版本探测的端点家族」——不是所有端点都值得登记，只有
// 前端/Agent 在异版本部署下需要先探测再调用的端点家族才进 capabilityRoutes。

// capabilityRoutes 能力项 → 真实路由路径（gin 注册路径，含参数段原样）
var capabilityRoutes = map[string]string{
	"ahead-behind-all": "/api/ahead-behind",                // 全项目批量 ahead/behind（独立路径先例）
	"fetch-all":        "/api/fetch-all",                   // 一键全部拉取（独立路径先例）
	"bulk-agent":       "/api/terminals/bulk-agent",        // 舰队批量发起 agent 会话（P-20261003-291）
	"notes-global":     "/api/notes/:noteId",               // 笔记库 REST 族（P-20261107-5；P-20261108-3 单库化后唯一笔记族——notes/notes-multi 随端点下线修剪）
	"flat-file-list":   "/api/projects/:id/file-list",      // 扁平文件清单单请求
	"file-history":     "/api/projects/:id/file/history",   // 本地文件历史
	"fs-attribution":   "/api/projects/:id/fs-attribution", // 文件改动来源归因（P-20261005-170）
	"merge-preview":    "/api/projects/:id/merge-preview",  // 合并预演（merge-tree 只读原语，P-20261005-174）
	"sync":             "/api/sync/manifest",               // 多实例项目同步（manifest/plan/pull/push 端点族，P-20261023-1）
	"watch-fallback":   "/api/watch/fallback",              // 文件监听降级轮询兜底开关（P-20261003-140）
	// 原子呈现能力注册表（P-20261022-3）：非端点家族能力项——映射指向注册表的
	// 唯一读出端点 /ops-manual（内置事件目录 + 人类深链表由注册表渲染），
	// agent 先探测本族项再依赖 navigate 多形态与深链表，旧实例按降级约定回退
	// path 首形态
	"ops.present-atoms": "/ops-manual",
}

func TestMetaCapabilityConformance(t *testing.T) {
	// 真实装配两侧：路由表（RegisterRoutes 收口快照，P-20261003-153 起即推导输入）
	// + 模块清单（discoveryFace 同款，只 Register 不 Init/Start，构造器纯结构体
	// 装配零副作用）
	gin.SetMode(gin.TestMode)
	r := gin.New()
	routes := api.RegisterRoutes(r)
	routePaths := map[string]bool{}
	for _, p := range routes {
		routePaths[p] = true
	}

	k := kernel.New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	registerAll(k, builtinModules(&config.Config{}, runtimeInfo{}, routes))
	declared := map[string]bool{}
	for _, m := range k.Modules() {
		for _, cp := range m.Manifest.Capabilities {
			declared[cp] = true
		}
	}

	t.Run("能力项→映射：声明必有对账凭据", func(t *testing.T) {
		var unmapped []string
		for cp := range declared {
			if _, ok := capabilityRoutes[cp]; !ok {
				unmapped = append(unmapped, cp)
			}
		}
		if len(unmapped) > 0 {
			sort.Strings(unmapped)
			t.Errorf("能力项缺对账映射（补 capabilityRoutes 或该端点不需跨版本探测）：%v", unmapped)
		}
	})

	t.Run("能力项→路由：映射指向真实端点", func(t *testing.T) {
		var dead []string
		for cp, path := range capabilityRoutes {
			if !routePaths[path] {
				dead = append(dead, cp+" → "+path)
			}
		}
		if len(dead) > 0 {
			sort.Strings(dead)
			t.Errorf("能力项悬空（指向的路由已不存在，修剪声明与映射）：%v", dead)
		}
	})

	t.Run("映射→声明：对账映射不悬空", func(t *testing.T) {
		var orphaned []string
		for cp := range capabilityRoutes {
			if !declared[cp] {
				orphaned = append(orphaned, cp)
			}
		}
		if len(orphaned) > 0 {
			sort.Strings(orphaned)
			t.Errorf("映射悬空（无任何模块声明该能力项，端点下线时同步修剪 capabilityRoutes）：%v", orphaned)
		}
	})
}
