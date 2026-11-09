package share

import (
	"embed"
)

// 访客终端页（直播/定格/回放）的 vendored 静态资产（P-20261003-306）：xterm.js
// + addon-fit + xterm.css；P-20261107-4 渲染保真补 addon-unicode11（宽字符宽度
// 表与产品内终端同为 Unicode 11——缺它时 xterm 回落 v6 宽度表，CJK/emoji 宽度
// 与主机侧应用的计算不一致，TUI 整行错位）+ JetBrains Mono Regular/Bold（产品
// 内终端缺省字体的同一份 OFL 字体文件，web/public/fonts 同源，LICENSE 同目录）。
// 来源与升级约定见 assets/README.md。分享子服务零外部依赖（CSP 锁死 CDN），
// web/node_modules 不入 git——唯一落点是随 Go 二进制 embed 的提交态副本。
// 只 serve 白名单精确名，目录本身不暴露列表
//
//go:embed assets/xterm.js assets/addon-fit.js assets/xterm.css assets/addon-unicode11.js assets/JetBrainsMono-Regular.woff2 assets/JetBrainsMono-Bold.woff2
var assetsFS embed.FS

// vendoredAsset 白名单条目：名称 + 响应 Content-Type（单一事实源，同时供
// 子服务 assetByName 与主应用同源代理的精确路由挂载 AssetNames 使用）。
type vendoredAsset struct {
	name        string
	contentType string
}

var vendoredAssets = []vendoredAsset{
	{name: "xterm.js", contentType: "application/javascript; charset=utf-8"},
	{name: "addon-fit.js", contentType: "application/javascript; charset=utf-8"},
	{name: "xterm.css", contentType: "text/css; charset=utf-8"},
	{name: "addon-unicode11.js", contentType: "application/javascript; charset=utf-8"},
	{name: "JetBrainsMono-Regular.woff2", contentType: "font/woff2"},
	{name: "JetBrainsMono-Bold.woff2", contentType: "font/woff2"},
}

// AssetNames 返回访客页依赖的静态资产名（只读副本；主应用同源代理按这些
// 精确名逐条挂载，绝不整段代理 /assets/*——主应用 Vite 产物同住该前缀，其
// 文件名带内容哈希，与这里的原名不相撞）。
func AssetNames() []string {
	out := make([]string, 0, len(vendoredAssets))
	for _, a := range vendoredAssets {
		out = append(out, a.name)
	}
	return out
}

// assetByName 白名单精确命中（防路径穿越/任意读）：名称 → 内容 + Content-Type
func assetByName(name string) (data []byte, contentType string, ok bool) {
	for _, a := range vendoredAssets {
		if a.name != name {
			continue
		}
		d, err := assetsFS.ReadFile("assets/" + a.name)
		if err != nil {
			return nil, "", false
		}
		return d, a.contentType, true
	}
	return nil, "", false
}
