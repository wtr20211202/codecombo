package quickdrop

import (
	"embed"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// 访客投递页自持脚本（P-20261117-2-S2）：/drop/assets/app.js 随 Go 二进制
// embed 交付——零新依赖、零 CDN（enforcing CSP script-src 'self' 锁死外部
// 脚本面；share 访客页 vendored 资产同款形态，见 server/share/assets.go）。
// 只 serve 白名单精确名，目录本身不暴露列表。
//
//go:embed assets/app.js
var assetsFS embed.FS

// dropAssets 白名单：名称 → Content-Type（单一事实源：router.go 按精确名逐条
// 挂载 /drop/assets/<name>——不整段挂 /drop/assets/*，与 /drop/:token 参数
// 路由同树共存的形态也由此收敛到静态精确名，无参数段）
var dropAssets = []struct {
	name        string
	contentType string
}{
	{"app.js", "application/javascript; charset=utf-8"},
}

// AssetNames 返回访客页依赖的自持资产名（只读副本；主引擎按精确名逐条挂载，
// share AssetNames 同款约定）
func AssetNames() []string {
	out := make([]string, 0, len(dropAssets))
	for _, a := range dropAssets {
		out = append(out, a.name)
	}
	return out
}

// GetDropAsset GET /drop/assets/<name>——白名单精确命中（防路径穿越/任意读：
// 逐名比对，不在清单即 404 品牌页口径——不暴露文件树存在性）。名称取自挂载
// 路径尾段（路由层按白名单精确名注册，此处对账为防御性二道闸）
func GetDropAsset(c *gin.Context) {
	name := strings.TrimPrefix(c.Request.URL.Path, "/drop/assets/")
	for _, a := range dropAssets {
		if a.name != name {
			continue
		}
		data, err := assetsFS.ReadFile("assets/" + a.name)
		if err != nil {
			break
		}
		// 脚本无隐私载荷但版本随二进制走：no-cache 保证升级后访客侧即时
		// 拿到新脚本（无内容哈希可做 immutable）
		c.Header("Cache-Control", "no-cache")
		c.Data(http.StatusOK, a.contentType, data)
		return
	}
	renderDropNotFound(c)
}
