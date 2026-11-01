package system

import (
	"regexp"
	"strings"
)

// 运行书步骤模板插值（P-20261004-108）：web/src/utils/textTemplate.ts 的 Go
// 侧同语义移植——运行书执行从纯前端（useRunbookRunner 逐条写终端）扩展出服务端
// 执行端点后，同一套 {参数} 占位符语义必须在两端不漂移：前端面板表单填参、
// agent 以 JSON params 供参，插值结果一致是「同一本运行书」契约的一部分。
// 分词/提取/插值三函数与 TS 版逐行为对照重写（tokenizeTemplate/
// extractTemplateParams/interpolateTemplate），用例覆盖两端口径样本。
//
// 语法（与 TS 版一致）：
//   - {name} 占位符：name 首字符 unicode 字母/数字/下划线，组成字符再允许 . -
//   - {{name}} 旧双大括号形式继续按占位符识别（兼容既有数据），优先于 {{ 转义
//   - {{ 转义输出单个 {（awk '{print $1}' 这类字面花括号靠它表达）；
//     {{…}} 内容非占位符名时整段还原为 {…}
//   - 紧邻 $ 的 { 是 shell 变量语法（${VAR}）非占位符
//   - 未提供（或空白）的参数保留占位符原样——执行链在插值前先做缺失清单校验
//     （400 带缺失清单），此分支只为单测对齐 TS 语义保留

// runbookParamNameRe 占位符名字符集（与 TS NAME_RE 同款：unicode 字母/数字/
// 下划线开头，组成字符再允许 . -）。RE2 原生支持 \p{L}\p{N} unicode 类
var runbookParamNameRe = regexp.MustCompile(`^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$`)

type runbookTemplateToken struct {
	ph   bool   // true = 占位符
	text string // 原文片段（占位符含花括号，供未匹配时原样还原）
	name string // 占位符名（仅 ph=true）
}

// tokenizeRunbookTemplate 把模板切分为文本/占位符 token 流。按字节扫描：
// 花括号是 ASCII，不可能出现在多字节序列内部，与 TS 的 UTF-16 索引语义在
// 定位上一致；名字合法性交给 unicode 正则
func tokenizeRunbookTemplate(template string) []runbookTemplateToken {
	tokens := make([]runbookTemplateToken, 0, 4)
	var lit strings.Builder
	pushLit := func() {
		if lit.Len() > 0 {
			tokens = append(tokens, runbookTemplateToken{text: lit.String()})
			lit.Reset()
		}
	}
	for i := 0; i < len(template); {
		if template[i] != '{' {
			lit.WriteByte(template[i])
			i++
			continue
		}
		if strings.HasPrefix(template[i:], "{{") {
			end := strings.Index(template[i+2:], "}}")
			if end != -1 {
				content := template[i+2 : i+2+end]
				name := strings.TrimSpace(content)
				if runbookParamNameRe.MatchString(name) {
					pushLit()
					tokens = append(tokens, runbookTemplateToken{ph: true, text: template[i : i+2+end+2], name: name})
					i += 2 + end + 2
					continue
				}
				// {{…}} 内容非占位符名：整段转义字面 → {…}（awk '{{print $1}}' → '{print $1}'）
				lit.WriteString("{" + content + "}")
				i += 2 + end + 2
				continue
			}
			// 未闭合的 {{xxx：转义 {，其余原样
			lit.WriteByte('{')
			i += 2
			continue
		}
		// 单大括号 {name}；紧邻 $ 的 { 是 shell 变量语法（${VAR}）非占位符，
		// 否则最常用的 ${…} 引用会被误当参数要求填写
		end := strings.IndexByte(template[i+1:], '}')
		raw := ""
		if end != -1 {
			raw = template[i+1 : i+1+end]
		}
		name := strings.TrimSpace(raw)
		afterDollar := i > 0 && template[i-1] == '$'
		if end != -1 && !afterDollar && !strings.Contains(raw, "{") && runbookParamNameRe.MatchString(name) {
			pushLit()
			tokens = append(tokens, runbookTemplateToken{ph: true, text: template[i : i+1+end+1], name: name})
			i += 1 + end + 1
			continue
		}
		lit.WriteByte('{')
		i++
	}
	pushLit()
	return tokens
}

// extractRunbookParams 提取模板中按出现顺序去重的占位符参数名；无占位符返回空
func extractRunbookParams(template string) []string {
	names := make([]string, 0, 2)
	for _, tok := range tokenizeRunbookTemplate(template) {
		if !tok.ph {
			continue
		}
		dup := false
		for _, n := range names {
			if n == tok.name {
				dup = true
				break
			}
		}
		if !dup {
			names = append(names, tok.name)
		}
	}
	return names
}

// interpolateRunbookTemplate 按名插值：值为空白/缺失的参数保留占位符原样
// （与 TS interpolateTemplate 同语义；执行链的缺失校验在插值前完成）
func interpolateRunbookTemplate(template string, values map[string]string) string {
	var out strings.Builder
	for _, tok := range tokenizeRunbookTemplate(template) {
		if !tok.ph {
			out.WriteString(tok.text)
			continue
		}
		if v, ok := values[tok.name]; ok && strings.TrimSpace(v) != "" {
			out.WriteString(v)
			continue
		}
		out.WriteString(tok.text)
	}
	return out.String()
}
