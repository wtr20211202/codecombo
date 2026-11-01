package deploy

import (
	_ "embed"
	"strings"
)

//go:embed scripts/setup_claude.sh
var setupClaudeScript string

// SetupClaudeScript 返回内嵌的 setup_claude.sh 内容。
// 双保险 CRLF 归一：.gitattributes 已强制 LF 检出，但历史 clone/补丁工具
// 仍可能引入 \r\n——脚本上传到远程 Linux 执行，一行 ^M 就是 bad interpreter
func SetupClaudeScript() string {
	return strings.ReplaceAll(setupClaudeScript, "\r\n", "\n")
}
