package update

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// IsNpmManaged 判断本二进制是否经 npm 分发安装（P-20261102-2）。
//
// 判据双通道：wrapper 注入的 CODECOMBO_INSTALLER=npm 优先；回退按可执行文件
// 路径是否落在 node_modules 目录段内（daemon 重启 / env 丢失时仍成立）。
//
// npm 管的文件归 npm 管：自更新若对 node_modules 内的二进制原位替换，npm 的
// 版本记账即漂移（npm 仍记旧版，下次 npm update 会把旧版盖回来）。npm 安装
// 形态的更新路径是 `npm i -g codecombo@latest`（尝鲜 @next），自更新必须让位。
func IsNpmManaged(binaryPath string) bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("CODECOMBO_INSTALLER")), "npm") {
		return true
	}
	if binaryPath == "" {
		return false
	}
	parts := strings.Split(filepath.ToSlash(strings.ToLower(binaryPath)), "/")
	return slices.Contains(parts, "node_modules")
}
