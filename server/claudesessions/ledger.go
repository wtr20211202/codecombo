// 会话结构化台账（P-20261005-208）：扫描链路（scanFile 全文逐行）顺带聚合
// assistant tool_use 事件——改过几个文件（写类工具按路径去重）、跑了多少条
// shell 命令、首尾工具活动跨时多久。回放时间线里逐条可见的动作信息在此聚成
// 会话级摘要：会话中心「这会话干了什么」一眼可读，agent 会话考古获得量化
// 筛选面（列表 API 透传，无需新端点），也是接力载荷的可选量化锚（P-114/P-207
// 前言附行）。
//
// 与 P-139 usage 聚合同款分工：共享 scanFile 扫描循环与 isAssistantLine 预滤，
// 坏行宽容跳过；聚合结果随 claudeindex 缓存透传（LedgerKnown 升级标记与
// UsageKnown 同款——旧条目判定未命中，升级后首次列表一次性重扫补齐，此后恢复
// stat 级零内容读）。事件口径与回放时间线一致：assistant 行的 tool_use 块，
// sidechain 子代理动作同样计入（回放时间线同样展示，两面对得上）。
package claudesessions

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	"codecombo/server/store"
)

// Ledger 会话结构化台账（对外 JSON 形态即 API 契约）。三项均可独立为零
// （只跑命令不写文件的会话 FilesWritten=0），消费方按段零值隐藏
type Ledger struct {
	FilesWritten int   `json:"filesWritten"` // 写类工具触达的去重文件数
	CommandsRun  int   `json:"commandsRun"`  // shell 命令次数
	DurationMs   int64 `json:"durationMs"`   // 首尾 tool_use 时刻差（工具活动跨时）
}

// 工具名 → 台账类别（键为小写工具名；claude 工具名大小写形态历史一致，防御性
// 折叠）。只登记「改文件 / 跑命令」两类——台账是干了什么的量化摘要不是完整
// 审计，Grep/Read/WebFetch 等只读工具本就不进这个口径，未登记工具不计
var (
	ledgerWriteTools = map[string]struct{}{"write": {}, "edit": {}, "multiedit": {}, "notebookedit": {}}
	ledgerShellTools = map[string]struct{}{"bash": {}}
)

// ledgerFilePathKeys 写类工具输入里文件路径的偏好键序（Write/Edit 用
// file_path、NotebookEdit 用 notebook_path，path 兜底未知变体）
var ledgerFilePathKeys = []string{"file_path", "notebook_path", "path"}

// ledgerKey tool_use 键子串预滤：非 assistant 行或无工具调用的行零解析成本
// 直接跳过（与 usageKey 预滤同款手法）
var ledgerKey = []byte(`"tool_use"`)

// ledgerMaxFiles 去重文件集防御上限：触顶后新路径不再入集（FilesWritten 取
// 下界如实偏小）——现实会话远达不到；防病态 transcript 把去重集撑成无界内存
// （扫描数据本体已在内存，上界让增量恒有常数封顶）
const ledgerMaxFiles = 10000

// ledgerAccum 单文件扫描期的台账累加器（scanFile 持有，行循环内逐行喂；
// 行间状态只有去重文件集与首尾时刻，故不能做成 accumulateUsage 式纯函数钩子）
type ledgerAccum struct {
	files       map[string]struct{}
	commands    int
	first, last time.Time // tool_use 时刻首尾（时间戳缺失/解析失败的行不计跨时）
	seen        bool      // 见过任一 tool_use（区分「无工具会话」与「聚合为零」）
}

func newLedgerAccum() *ledgerAccum { return &ledgerAccum{files: make(map[string]struct{}, 8)} }

// accumulate 单行聚合钩子：assistant 行的 tool_use 块按工具类别入账。宽容
// 语义与包内其他解析面一致：坏 JSON / 缺输入 / 未知工具一律跳过，绝不因单行
// 让扫描失败（transcript 格式无兼容承诺）
func (a *ledgerAccum) accumulate(line []byte) {
	if !bytes.Contains(line, ledgerKey) || !isAssistantLine(line) {
		return
	}
	var m struct {
		Message struct {
			Content []struct {
				Type  string          `json:"type"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"message"`
		Timestamp string `json:"timestamp"`
	}
	if !looseUnmarshal(line, &m) {
		return
	}
	ts, tsOK := parseLedgerTime(m.Timestamp)
	for _, item := range m.Message.Content {
		if item.Type != "tool_use" {
			continue
		}
		a.seen = true
		if tsOK {
			if a.first.IsZero() || ts.Before(a.first) {
				a.first = ts
			}
			if a.last.IsZero() || ts.After(a.last) {
				a.last = ts
			}
		}
		name := strings.ToLower(item.Name)
		if _, ok := ledgerShellTools[name]; ok {
			a.commands++
			continue
		}
		if _, ok := ledgerWriteTools[name]; ok {
			if p := ledgerToolFilePath(item.Input); p != "" {
				if _, dup := a.files[p]; !dup && len(a.files) < ledgerMaxFiles {
					a.files[p] = struct{}{}
				}
			}
		}
	}
}

// result 聚合结果：无任何 tool_use（纯聊天会话）或三项全零（纯只读工具会话）
// 返回 nil——「无数据」不上账不上 JSON，前端零值隐藏与 DiagSnapshot 同款纪律
func (a *ledgerAccum) result() *Ledger {
	if !a.seen {
		return nil
	}
	led := Ledger{FilesWritten: len(a.files), CommandsRun: a.commands}
	if !a.first.IsZero() && !a.last.IsZero() {
		led.DurationMs = a.last.Sub(a.first).Milliseconds()
	}
	if led.FilesWritten == 0 && led.CommandsRun == 0 && led.DurationMs == 0 {
		return nil
	}
	return &led
}

// parseLedgerTime 行时间戳解析（RFC3339，与 parseHead/parseAssistantUsage 同款
// 宽容形态：缺失/解析失败不阻断，仅该行不计入跨时）
func parseLedgerTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, false
	}
	return ts, true
}

// ledgerToolFilePath 写类工具输入里取文件路径（偏好键序首个非空字符串值；
// 解析失败/无路径返回空串——该次调用不计入去重集，宁漏计不误计）
func ledgerToolFilePath(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	for _, k := range ledgerFilePathKeys {
		if v, ok := obj[k].(string); ok {
			if v = strings.TrimSpace(v); v != "" {
				return v
			}
		}
	}
	return ""
}

// LookupLedger 按会话 id 从索引条目取台账（LookupTitle 同款索引只读查询——
// 零 transcript IO，接力前言附台账行的取数面；条目未做台账聚合（LedgerKnown
// false）或查不到返回 nil，消费方按「无数据」如实省略）
func (ix *Index) LookupLedger(sessionID string) *Ledger {
	if sessionID == "" {
		return nil
	}
	known, err := ix.repo.GetBatch(store.ClaudeIndexPrefix(ix.root, ""))
	if err != nil {
		return nil
	}
	for _, e := range known {
		if e.ID != sessionID || !e.LedgerKnown {
			continue
		}
		if e.LedgerFiles == 0 && e.LedgerCommands == 0 && e.LedgerDurationMs == 0 {
			return nil
		}
		return &Ledger{FilesWritten: e.LedgerFiles, CommandsRun: e.LedgerCommands, DurationMs: e.LedgerDurationMs}
	}
	return nil
}
