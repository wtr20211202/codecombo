package shellint

import (
	"embed"
	"path/filepath"
	"strings"
)

//go:embed bash.sh zsh.sh powershell.ps1
var scriptsFS embed.FS

// ScriptForShell 根据 shell 可执行路径返回对应的集成脚本内容
// 不支持的 shell 返回空字符串。
// CRLF 归一双保险：.gitattributes 已强制 LF 检出，历史 clone 仍可能带
// \r\n——bash/zsh 逐行执行脚本时 \r 会报 command not found
func ScriptForShell(shellPath string) string {
	base := strings.ToLower(filepath.Base(shellPath))

	read := func(name string) string {
		data, _ := scriptsFS.ReadFile(name)
		return strings.ReplaceAll(string(data), "\r\n", "\n")
	}
	switch {
	case strings.Contains(base, "bash"):
		return read("bash.sh")
	case strings.Contains(base, "zsh"):
		return read("zsh.sh")
	case strings.Contains(base, "pwsh") || strings.Contains(base, "powershell"):
		// PS 对 CRLF 不敏感，统一归一无害
		return read("powershell.ps1")
	default:
		// cmd / fish / sh / dash 等不支持
		return ""
	}
}

// SupportedShell 判断 shell 是否支持 shell integration
func SupportedShell(shellPath string) bool {
	return ScriptForShell(shellPath) != ""
}
