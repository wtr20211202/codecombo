// 会话回放 cast 文本处理（P-20261004-103）：分享的是录制车道产出的
// asciinema v2 cast 文件。两条纪律：
//
//  1. 分享前敏感模式扫描（P-97 同语义的「警示 + override 二次确认」契约）：
//     录制写盘前已过流式遮蔽（P-108），这里是对落盘文件的兜底复检——命中
//     不阻断动作本身，而是让分享者在出域前知情并显式确认；
//  2. 快照写盘前全量兜底遮蔽：命中模式（含自定义敏感模式）在快照本体中
//     一律落 ***——快照即净本，访客页零二次处理（与 terminal-frozen 的
//     「净化先于落盘」同一条纪律）。OSC 133 E 帧的 base64 载荷单独解码后
//     遮蔽再编码：整段 base64 对正则不可见，不处理会漏掉命令文本里的值。
//
// 本文件只做文本变换（零业务依赖，单测可直测）；落盘/清账原语在 snapshot.go。
package share

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"codecombo/server/mask"
)

// maxCastScanWarnings 扫描警示清单上限：行号级命中清单是给分享者过目的，
// 超过一屏的清单只会淹没重点；截断由 Truncated 标注（与文件扫描同语义）
const maxCastScanWarnings = 50

// osc133EFrameRe OSC 133 E 帧（命令文本，payload 为 base64 的行内形态）。
// 线上字节序：ESC ] 133 ; E ; <base64> BEL（shellint 约定，回放端
// web/src/utils/recording.ts 的 OSC133_RE 同源）
var osc133EFrameRe = regexp.MustCompile("\x1b\\]133;E;([^\x07\x1b]*)\x07")

// castEvent 解析后的输出事件（只关心 "o" 型；t 相对录制起点秒）
type castEvent struct {
	t    float64
	text string
}

// parseCastLine 单行 cast 解析：事件行返回 ok；header/损坏行不参与。
// 容忍浮点评分数值形态（asciinema v2 规范即 JSON number）
func parseCastLine(line string) (castEvent, bool) {
	line = strings.TrimSpace(line)
	if line == "" || !strings.HasPrefix(line, "[") {
		return castEvent{}, false
	}
	var row []any
	if json.Unmarshal([]byte(line), &row) != nil || len(row) < 3 {
		return castEvent{}, false
	}
	t, ok := row[0].(float64)
	if !ok {
		return castEvent{}, false
	}
	typ, _ := row[1].(string)
	text, ok := row[2].(string)
	if !ok || typ != "o" {
		return castEvent{}, false
	}
	return castEvent{t: t, text: text}, true
}

// maskCastEventText 单条事件文本的兜底遮蔽：E 帧载荷解码 → 遮蔽 → 重编码
// （帧结构原样保留，回放端仍可解析章节），其余文本走 mask.MaskText（内置
// 模式集 + 自定义模式）。返回遮蔽后文本与「是否发生了替换」（后者供扫描
// 警示判定，避免二次解析）
func maskCastEventText(text string) (string, bool) {
	var b strings.Builder
	last := 0
	hit := false
	for _, loc := range osc133EFrameRe.FindAllStringSubmatchIndex(text, -1) {
		// 帧前普通文本：全量模式遮蔽
		if loc[0] > last {
			seg := text[last:loc[0]]
			masked := mask.MaskText(seg)
			if masked != seg {
				hit = true
			}
			b.WriteString(masked)
		}
		frame := text[loc[0]:loc[1]]
		payload := text[loc[2]:loc[3]]
		if decoded, err := base64.StdEncoding.DecodeString(payload); err == nil {
			maskedPayload := mask.MaskText(string(decoded))
			if maskedPayload != string(decoded) {
				hit = true
				frame = text[loc[0]:loc[2]] + base64.StdEncoding.EncodeToString([]byte(maskedPayload)) + text[loc[3]:loc[1]]
			}
		}
		b.WriteString(frame)
		last = loc[1]
	}
	if last < len(text) {
		seg := text[last:]
		masked := mask.MaskText(seg)
		if masked != seg {
			hit = true
		}
		b.WriteString(masked)
	}
	if last == 0 && !hit {
		// 无 E 帧且无替换：省一次拼接分配（常见路径）
		return text, false
	}
	return b.String(), hit
}

// SanitizeCastText 全量 cast 兜底遮蔽：逐事件行解析 → 事件文本遮蔽 → 重新
// 序列化；header 与损坏行原样保留（损坏行无法安全重写，扫描警示已就原行
// 把守）。事件行重新 marshal 后仍是合法 asciinema v2（浮点时间保留 JSON
// number 语义）。空文本原样返回。导出给管理面创建路径（快照写盘前调用——
// 快照即净本，访客面零二次处理）
func SanitizeCastText(castText string) string {
	lines := strings.Split(castText, "\n")
	changed := false
	for i, line := range lines {
		ev, ok := parseCastLine(line)
		if !ok {
			continue
		}
		masked, hit := maskCastEventText(ev.text)
		if !hit {
			continue
		}
		b, err := json.Marshal([]any{ev.t, "o", masked})
		if err != nil {
			continue
		}
		lines[i] = string(b)
		changed = true
	}
	if !changed {
		return castText
	}
	return strings.Join(lines, "\n")
}

// ScanCastSensitive cast 文本敏感模式扫描（P-97 同语义：命中清单 + 前端
// 警示确认 + override 二次请求）。返回命中所在行号（语言中立标签，不含
// 命中原文——警示清单本身不得成为新的泄露面）。Truncated 表示命中数超过
// maxCastScanWarnings 上限（确有未列出命中）。
func ScanCastSensitive(castText string) ScanResult {
	res := ScanResult{Warnings: []string{}}
	for i, line := range strings.Split(castText, "\n") {
		ev, ok := parseCastLine(line)
		if !ok {
			continue
		}
		if _, hit := maskCastEventText(ev.text); !hit {
			continue
		}
		if len(res.Warnings) >= maxCastScanWarnings {
			res.Truncated = true
			break
		}
		res.Warnings = append(res.Warnings, fmt.Sprintf("line %d", i+1))
	}
	return res
}

// CastHasOutput 录制是否已有可回放的输出事件（header-only 的空录制分享无
// 意义：访客打开只会看到空回放页。API 创建面据此 400，与 term-frozen
// 「空输出拒绝」同族）
func CastHasOutput(castText string) bool {
	for _, line := range strings.Split(castText, "\n") {
		if _, ok := parseCastLine(line); ok {
			return true
		}
	}
	return false
}
