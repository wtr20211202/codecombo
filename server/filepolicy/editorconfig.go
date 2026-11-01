// .editorconfig 支持（P-20261003-95）：项目根 .editorconfig 的 INI 子集解析与
// 节匹配，把「指定文件的生效缩进约定」随 file-policy 端点下发给编辑器打开链
// （Monaco 不读 .editorconfig，服务端解析是前端拿得到约定的唯一来源）。
//
// 子集边界（对标 editorconfig.org 规范，glob 从简两档）：
//   - 节匹配两档：精确节（选择器即项目相对路径全等，[Makefile] 只中根下
//     Makefile）与通配后缀（[*.<ext>] / [**<suffix>] / [**/<name>] 按后缀、
//     [*] 单星全匹配）；含 ? [ { ! 等其余 glob 元字符的复杂模式整节忽略
//     （降级默认节，宁可少套不误套）。
//   - 键子集四键：indent_style / indent_size / tab_width / end_of_line；
//     charset、trim_trailing_whitespace、insert_final_newline 等其余键忽略。
//   - root 键解析接受但不参与查找：只读项目根单文件，不做上级目录遍历（MVP，
//     .editorconfig 常态在仓库根；子目录级配置属后续扩展点）。
//   - 叠加语义从规范：顶层键打底，命中节按文件顺序逐节覆盖（同键后者胜）；
//     indent_size=tab 按规范折算为 tab_width（无 tab_width 则该键缺省）。
package filepolicy

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// EditorConfig .editorconfig 生效键子集（file-policy 响应 editorconfig 字段，
// 与前端 utils/editorConfig.ts 的 EditorConfigEffective 手工镜像——字段增删
// 两侧同步）。零值 = 该键未约定，前端逐键回落全局设置
type EditorConfig struct {
	IndentStyle string `json:"indentStyle,omitempty"` // "tab" | "space"
	IndentSize  int    `json:"indentSize,omitempty"`  // 1..100；0 = 未约定
	TabWidth    int    `json:"tabWidth,omitempty"`    // 1..100；0 = 未约定
	EndOfLine   string `json:"endOfLine,omitempty"`   // "lf" | "crlf" | "cr"
}

// editorconfigMaxBytes 解析上限：常规 .editorconfig 远小于此，超限按无配置
// 处理——防项目根被塞入超大同名文件拖慢每次文件打开
const editorconfigMaxBytes int64 = 64 << 10

// globExtraMeta 通配后缀档之外的 glob 元字符：选择器中出现即整节忽略
const globExtraMeta = "?[{!\\"

type editorConfigSection struct {
	selector string
	props    map[string]string
}

type editorConfigFile struct {
	root     bool
	globals  map[string]string     // 顶层（任何节之前）键
	sections []editorConfigSection // 文件顺序（叠加语义依赖此序）
}

// ParseEditorConfig INI 子集解析（纯函数）：行注释 #/;（整行）、节头
// [selector]、键值分隔 = 或 :、键大小写不敏感（规范键全小写归一）、同节内
// 重复键后者胜。无法识别的行静默跳过（坏档降级为部分生效，不整体失败）
func ParseEditorConfig(content string) *editorConfigFile {
	f := &editorConfigFile{globals: map[string]string{}}
	var cur map[string]string
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") && len(line) >= 2 {
			sel := strings.TrimSpace(line[1 : len(line)-1])
			cur = map[string]string{}
			f.sections = append(f.sections, editorConfigSection{selector: sel, props: cur})
			continue
		}
		sep := strings.IndexAny(line, "=:")
		if sep < 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(line[:sep]))
		val := strings.TrimSpace(line[sep+1:])
		if key == "" {
			continue
		}
		if cur == nil {
			if key == "root" {
				f.root = strings.EqualFold(val, "true")
			} else {
				f.globals[key] = val
			}
			continue
		}
		cur[key] = val
	}
	return f
}

// matchSection 选择器是否命中项目相对路径（正斜杠形态，两档从简）。
// 复杂模式（含未支持的 glob 元字符或路径分隔）返回 false = 降级默认节
func matchSection(selector, relPath string) bool {
	if selector == "" {
		return false
	}
	if selector == "*" || selector == "**" {
		return true
	}
	// [**/name] / [**/*.ext] / [**.go]：** 通配前缀归入通配后缀档
	if strings.HasPrefix(selector, "**") {
		sel := strings.TrimPrefix(strings.TrimPrefix(selector, "**/"), "**")
		if sel == "" || sel == "*" {
			return true
		}
		if strings.ContainsAny(sel, "*"+globExtraMeta) || strings.Contains(sel, "/") {
			return false
		}
		return strings.HasSuffix(relPath, sel)
	}
	if strings.HasPrefix(selector, "*") {
		suffix := selector[1:]
		if suffix == "" || strings.ContainsAny(suffix, "*"+globExtraMeta) || strings.Contains(suffix, "/") {
			return false
		}
		return strings.HasSuffix(relPath, suffix)
	}
	// 精确档：选择器即相对路径全等（含通配元字符或子目录形态不在两档内）
	if strings.ContainsAny(selector, "*"+globExtraMeta) || strings.Contains(selector, "/") {
		return false
	}
	return relPath == selector
}

// EffectiveEditorConfig 该文件相对路径的生效键子集：顶层键打底 + 命中节按
// 文件顺序逐节覆盖（同键后者胜，规范叠加语义），最后按子集键一次换算
func EffectiveEditorConfig(f *editorConfigFile, relPath string) EditorConfig {
	if f == nil {
		return EditorConfig{}
	}
	merged := make(map[string]string, len(f.globals))
	for k, v := range f.globals {
		merged[k] = v
	}
	for _, s := range f.sections {
		if !matchSection(s.selector, relPath) {
			continue
		}
		for k, v := range s.props {
			merged[k] = v
		}
	}
	return editorConfigFromProps(merged)
}

// editorConfigFromProps 合并后键集 → 生效键子集。非法值（未知枚举/越界数值）
// 按未约定处理（不落键），绝不猜
func editorConfigFromProps(props map[string]string) EditorConfig {
	var ec EditorConfig
	switch strings.ToLower(props["indent_style"]) {
	case "tab":
		ec.IndentStyle = "tab"
	case "space":
		ec.IndentStyle = "space"
	}
	if v := props["tab_width"]; v != "" {
		if n, ok := clampIndentWidth(v); ok {
			ec.TabWidth = n
		}
	}
	if v := props["indent_size"]; v != "" {
		if strings.EqualFold(v, "tab") {
			// indent_size=tab（规范关键字语义 = 沿用 tab_width）：不落
			// IndentSize，消费端 indentSize 缺省自然回落 tab_width
		} else if n, ok := clampIndentWidth(v); ok {
			ec.IndentSize = n
		}
	}
	switch strings.ToLower(props["end_of_line"]) {
	case "lf":
		ec.EndOfLine = "lf"
	case "crlf":
		ec.EndOfLine = "crlf"
	case "cr":
		ec.EndOfLine = "cr"
	}
	return ec
}

// clampIndentWidth 缩进宽度值：正整数钳 1..100（与 Monaco model tabSize 的
// clampedInt 同界），越界/非法忽略
func clampIndentWidth(v string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 1 || n > 100 {
		return 0, false
	}
	return n, true
}

// EditorConfigFor 项目根 .editorconfig 对指定项目相对路径的生效配置。
// found=false = 无配置（文件不存在/为目录/空文件/超限/读取失败——缺失与坏档
// 同为常态，统一「无配置」，前端回落全局设置零变化）。
// 不做缓存（打开链一次 stat + 小文件读代价可忽略）：无失效问题（用户改
// .editorconfig 下一次打开即生效），也无 mtime 粒度陷阱（FAT 2s/异步元数据盘）
func EditorConfigFor(root, relPath string) (EditorConfig, bool) {
	if root == "" {
		return EditorConfig{}, false
	}
	path := filepath.Join(root, ".editorconfig")
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() == 0 || info.Size() > editorconfigMaxBytes {
		return EditorConfig{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return EditorConfig{}, false
	}
	f := ParseEditorConfig(string(data))
	return EffectiveEditorConfig(f, filepath.ToSlash(filepath.Clean(relPath))), true
}
