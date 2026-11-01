package api

// HandleMeta GET /api/meta —— 能力探测端点（P-20261004-4）：版本 + 能力清单。
//
// 动机：多实例异版本是真实部署拓扑，旧对端无新端点必 404——此前每个新端点
// 上线都要各写一套「404 回退」补丁（aheadBehind 批量回退扇出、file-list 回退
// BFS 等）。本端点把探测协议化：调用方先 GET /api/meta 看对端 capabilities
// 声明，未声明即走兼容路径，回退逻辑保留兜底（清单与路由漂移时不至于失能）。
//
// 公开只读（ops-manual / api/help 免 token 先例）：版本号与能力项名为非敏感
// 系统元数据，旧实例探测发生在鉴权协商之前，免 token 才能覆盖「对端是旧版本」
// 的全部场景。能力项由各模块经 kernel.Manifest.Capabilities 声明——内核
// 注册表是唯一清单源（HandleListModules 同款），新端点随模块声明后本端点
// 自动跟随，无需改此文件。对账门禁见 server/app/meta_conformance_test.go。

import (
	"net/http"
	"sort"

	"codecombo/server/api/system"
	"codecombo/server/kernel"

	"github.com/gin-gonic/gin"
)

// MetaVersion 版本载荷（构建信息 + 内核模块契约版本——插件 manifest 据此做兼容门禁）
type MetaVersion struct {
	Version    string `json:"version"`
	Commit     string `json:"commit"`
	BuildTime  string `json:"buildTime"`
	APIVersion string `json:"apiVersion"`
}

// MetaResponse /api/meta 响应体
type MetaResponse struct {
	Version      MetaVersion `json:"version"`
	Capabilities []string    `json:"capabilities"`
}

// HandleMeta 版本 + 能力清单（公开只读）
func HandleMeta(c *gin.Context) {
	v, commit, buildTime := system.BuildInfo()
	c.JSON(http.StatusOK, MetaResponse{
		Version:      MetaVersion{Version: v, Commit: commit, BuildTime: buildTime, APIVersion: kernel.APIVersion},
		Capabilities: metaCapabilities(),
	})
}

// metaCapabilities 聚合全部模块 manifest 声明的能力项（去重 + 稳定排序；
// 未注入内核时返回空数组而非 null，前端 []string 直读不炸）
func metaCapabilities() []string {
	out := []string{}
	if k, ok := kernelDefault.(kernel.Kernel); ok {
		seen := map[string]bool{}
		for _, m := range k.Modules() {
			for _, cp := range m.Manifest.Capabilities {
				if !seen[cp] {
					seen[cp] = true
					out = append(out, cp)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}
