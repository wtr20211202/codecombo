// 会话回放时间线（P-20261001-3）：把单条 transcript（~/.claude/projects/
// <编码目录>/<uuid>.jsonl）解析成可分页回览的 TimelineEntry 序列——每条用户
// 指令、assistant 回复、工具调用（名称+关键输入）、工具结果一步一条。
//
// 防超大文件：transcript 是 claude 的外部产物、单文件可达数百 MB。本文件从
// 尾部窗口回读（timelineWindowLines / timelineWindowBytes 双上限，回读字节数
// 与文件大小无关）——窗口内完整可回放，窗口外更早内容以 truncated 标记不可达。
// 条目按时间正序返回（回放语义：从头看到尾，「加载更多」向后追加更新的一页）。
//
// 宽松容错：transcript 格式无兼容承诺（与包注释一致），未知 type 行、解析
// 失败行一律静默跳过，绝不因单行坏数据让整个时间线失败。
//
// 已解析窗口以进程内缓存驻留（timelineCache，P-20261002-116）：请求时 stat
// 指纹（mtime+size）比对，未变直接分页返回缓存，变了才重读重解析。
package claudesessions

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/store"
)

// 时间线约束常量（与包级防超大文件约束同族）：尾部窗口 = 最近 4000 行且
// 最多 32MB——正常会话全程可回放；数百 MB 巨型会话只保留最近一段
const (
	timelineWindowLines = 4000
	timelineWindowBytes = 32 << 20
	timelineTailChunk   = 64 << 10 // 尾部回读块大小

	// 单条文本摘要截断（条目正文长、工具输入紧凑）
	timelineTextMaxRunes  = 200
	timelineInputMaxRunes = 120
	// 解析层条目上限：行窗口已被 bytes 上限兜底，此值为内存防御性上限
	//（病态单行展开海量条目时先到顶先截断，truncated 如实上报）
	timelineMaxEntries = 20000
)

// ErrSessionNotFound 按会话 id 定位不到 transcript（目录穿越 id 亦归此）
var ErrSessionNotFound = errors.New("claude session not found")

// TimelineEntry 时间线单步。Kind: user（用户指令）/ assistant（回复文本）/
// tool（工具调用）/ result（工具结果）；Text = 文本摘要；Tool/Input 仅
// Kind=tool；Status 仅 Kind=result（ok/error）。At 为原始 RFC3339 串
// （个别行无 timestamp 时为空，前端不渲染时间）
type TimelineEntry struct {
	Kind   string `json:"kind"`
	At     string `json:"at"`
	Text   string `json:"text"`
	Tool   string `json:"tool,omitempty"`
	Input  string `json:"input,omitempty"`
	Status string `json:"status,omitempty"`
}

// TimelineResult 分页结果：Total = 窗口内总条数（供「加载更多」判断）；
// Truncated = 会话超出尾部窗口、更早内容不可达（前端提示「仅最近一段」）。
// Bookmarks 轮级书签（P-20261003-122，claudecur 策展域）与 Tags 轮级语义标签
// （P-20261003-256，同域，store.ClaudeTurnTag）都不由本包解析链填充——
// transcript 解析是车道 3 只读面，策展属车道 1，由 API 层取策展条目后注入
// （回放弹层打开即得，不依赖会话列表行的陈旧快照）；旧前端忽略这些字段
type TimelineResult struct {
	Entries   []TimelineEntry       `json:"entries"`
	Total     int                   `json:"total"`
	Truncated bool                  `json:"truncated"`
	Bookmarks []string              `json:"bookmarks,omitempty"`
	Tags      []store.ClaudeTurnTag `json:"tags,omitempty"`
}

// timelineCacheEntry 时间线整窗缓存条目：stat 指纹（mtime+size，与 index.go
// 的 stat 级对账同族口径）+ 尾部窗口全量解析结果
type timelineCacheEntry struct {
	modTime time.Time
	size    int64
	entries []TimelineEntry // 时间正序；分页返回的是其子切片（只读约定）
	trunc   bool
}

// timelineCache 进程内回放缓存（P-20261002-116）：已结束会话的 transcript 不再
// 变化，重开回放 stat 比对命中即零读取零解析复用整窗条目；活跃会话每次追加都
// 改 stat，比对失效自然重读，无陈旧窗口。
// 并发模型：cacheMu 只罩 map 结构变更，解析在锁外（与 gitops status_cache 同款）。
// 键为解析后的文件路径而非裸 sessionID——SC_CLAUDE_DIR 可指向不同 root，同 id
// 不同文件不得串缓存。
// 条目数 timelineCacheMaxSessions 封顶（单条目与窗口解析结果同量级）：超限整体
// 清空重建，只损失一次重解析、与无缓存同价，不为此引入 LRU。
// 对 P-58 透明：ContextPressure 共享 LocateSession/collectTailLines 基建但自持
// 读取（50 行小窗、usage 解析），不经本缓存，行为不变。
var (
	timelineCacheMu sync.RWMutex
	timelineCache   = map[string]timelineCacheEntry{}
)

const timelineCacheMaxSessions = 32

// Timeline 会话时间线：尾部窗口内按时间正序取 [offset, offset+limit) 条。
// 定位/校验复用 FindResumeCwd 思路（id 含分隔符/扩展符直接拒绝，防目录穿越）。
// 直读 jsonl、不绕道 claudeindex 索引——索引不镜像内容（docs/PERSISTENCE_LANES.md）
func Timeline(root, sessionID string, limit, offset int) (TimelineResult, error) {
	path, ok := LocateSession(root, sessionID)
	if !ok {
		return TimelineResult{}, ErrSessionNotFound
	}
	f, err := os.Open(path)
	if err != nil {
		return TimelineResult{}, err
	}
	defer f.Close() //nolint:errcheck // 只读句柄，关闭失败无可补救动作
	st, err := f.Stat()
	if err != nil {
		return TimelineResult{}, err
	}

	// stat 指纹命中：整窗条目直接复用（分页窗口内零读取零解析）
	if e, ok := timelineCacheLookup(path, st); ok {
		return pageTimeline(e.entries, e.trunc, limit, offset), nil
	}
	lines, trunc := collectTailLines(f, st.Size(), timelineWindowLines, timelineWindowBytes)
	entries := parseTimelineLines(lines, timelineMaxEntries)
	timelineCachePut(path, st, entries, trunc)
	return pageTimeline(entries, trunc, limit, offset), nil
}

// timelineCacheLookup stat 指纹（mtime+size）均未变 → 返回缓存整窗条目；
// 任一变了（或无条目）→ miss，调用方重读
func timelineCacheLookup(path string, st os.FileInfo) (timelineCacheEntry, bool) {
	timelineCacheMu.RLock()
	e, ok := timelineCache[path]
	timelineCacheMu.RUnlock()
	if !ok || !e.modTime.Equal(st.ModTime()) || e.size != st.Size() {
		return timelineCacheEntry{}, false
	}
	return e, true
}

// timelineCachePut 变更文件重解析后的整窗结果入缓存（超限整体清空，见上）
func timelineCachePut(path string, st os.FileInfo, entries []TimelineEntry, trunc bool) {
	timelineCacheMu.Lock()
	defer timelineCacheMu.Unlock()
	if len(timelineCache) >= timelineCacheMaxSessions {
		timelineCache = map[string]timelineCacheEntry{}
	}
	timelineCache[path] = timelineCacheEntry{
		modTime: st.ModTime(),
		size:    st.Size(),
		entries: entries,
		trunc:   trunc,
	}
}

// pageTimeline 整窗条目 → [offset, offset+limit) 分页页（时间正序）。Entries
// 与缓存共享底层数组：只读约定，调用方不得改写条目
func pageTimeline(entries []TimelineEntry, trunc bool, limit, offset int) TimelineResult {
	total := len(entries)
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return TimelineResult{Entries: []TimelineEntry{}, Total: total, Truncated: trunc}
	}
	end := offset + limit
	if limit <= 0 || end > total {
		end = total
	}
	return TimelineResult{Entries: entries[offset:end], Total: total, Truncated: trunc}
}

// LocateSession 按会话 id 在全部项目目录中定位 transcript 文件（FindResumeCwd
// 同款遍历，返回路径而非 cwd；时间线直读用）
func LocateSession(root, sessionID string) (string, bool) {
	if root == "" || sessionID == "" || strings.ContainsAny(sessionID, "\\/.") {
		return "", false
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(root, e.Name(), sessionID+".jsonl")
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			return path, true
		}
	}
	return "", false
}

// collectTailLines 从文件尾部回读完整行：新→旧累计到 maxLines 行或 maxBytes
// 字节或文件头为止，返回按文件顺序（旧→新）排列的行（不含换行）。
// trunc=true = 因上限/读失败停在中途、更早内容被丢弃。块边界的不完整行与
// 更左一块拼接（首个块 = 文件头，天然对齐行首）
func collectTailLines(f *os.File, size int64, maxLines, maxBytes int) (lines [][]byte, trunc bool) {
	read := 0       // 已回读字节（含丢弃的行中段，预算口径从紧）
	var tail []byte // 跨块不完整行的右半段（含其终止换行；左半段在更早一块）
	pos := size     // 未读区间的右边界（独占）
stop:
	for pos > 0 && len(lines) < maxLines {
		chunk := int64(timelineTailChunk)
		if pos < chunk {
			chunk = pos
		}
		if rem := maxBytes - read; int64(rem) < chunk {
			chunk = int64(rem)
			trunc = true // 预算只够半块：更早内容不可达
		}
		if chunk <= 0 {
			break
		}
		buf := make([]byte, chunk)
		if _, err := f.ReadAt(buf, pos-chunk); err != nil {
			break // 读失败：已读部分照常返回（宽松容错）
		}
		pos -= chunk
		read += len(buf)
		if tail != nil {
			buf = append(buf, tail...)
			tail = nil
		}
		// 非文件头块的首段可能是行中段（其行首在更左一块）：切出留待拼接
		if pos > 0 {
			nl := bytes.IndexByte(buf, '\n')
			if nl < 0 {
				tail = buf
				continue
			}
			tail = buf[:nl+1]
			buf = buf[nl+1:]
		}
		// 块内自右向左切完整行（buf 以 '\n' 结尾或为空；只剩无换行首段 =
		// 文件第一行）
		for len(buf) > 0 {
			nl := bytes.LastIndexByte(buf, '\n')
			var line []byte
			if nl < 0 {
				line, buf = buf, nil
			} else {
				line, buf = buf[nl+1:], buf[:nl]
			}
			if len(line) > 0 {
				lines = append(lines, line)
				if len(lines) >= maxLines {
					trunc = pos > 0 || len(buf) > 0
					break stop
				}
			}
		}
	}
	if pos > 0 {
		trunc = true
	}
	// 新→旧 → 旧→新（时间正序）
	for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
		lines[i], lines[j] = lines[j], lines[i]
	}
	return lines, trunc
}

// parseTimelineLines 行序列（时间正序）→ 时间线条目（至多 max 条，超出如实
// 上报截断）。每行展开 0..N 条（assistant 行常含 文本+多个工具调用）；非
// user/assistant 行与解析失败行静默跳过
func parseTimelineLines(lines [][]byte, max int) []TimelineEntry {
	entries := make([]TimelineEntry, 0, 64)
	for _, line := range lines {
		switch {
		case isUserLine(line):
			parseUserLine(line, &entries)
		case isAssistantLine(line):
			parseAssistantLine(line, &entries)
		}
		if len(entries) >= max {
			return entries[:max]
		}
	}
	return entries
}

// isAssistantLine assistant 消息行判定（与 isUserLine 同款预滤）
func isAssistantLine(line []byte) bool {
	return bytes.Contains(line, []byte(`"type":"assistant"`)) ||
		bytes.Contains(line, []byte(`"type": "assistant"`))
}

// parseUserLine 用户行 → 0..1 条 user 指令 或 0..N 条 result（tool_result 也
// 挂在 user 行的 content 数组里）。sidechain（子代理）与 Claude 注入的元信息
// 块（resume caveat / local command 记录）跳过
func parseUserLine(line []byte, entries *[]TimelineEntry) {
	var m struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		IsSidechain bool   `json:"isSidechain"`
		Timestamp   string `json:"timestamp"`
	}
	if !looseUnmarshal(line, &m) || m.IsSidechain {
		return
	}
	var txt string
	if err := json.Unmarshal(m.Message.Content, &txt); err == nil {
		appendUserText(entries, txt, m.Timestamp)
		return
	}
	var arr []struct {
		Type    string          `json:"type"`
		Text    string          `json:"text"`
		Content json.RawMessage `json:"content"`
		IsError bool            `json:"is_error"`
	}
	if err := json.Unmarshal(m.Message.Content, &arr); err != nil {
		return
	}
	for _, item := range arr {
		switch item.Type {
		case "text":
			appendUserText(entries, item.Text, m.Timestamp)
		case "tool_result":
			*entries = append(*entries, TimelineEntry{
				Kind:   "result",
				At:     m.Timestamp,
				Text:   summarizeRawText(item.Content),
				Status: resultStatus(item.IsError),
			})
		}
	}
}

// parseAssistantLine assistant 行 → 0..N 条（text / tool_use；thinking 内部
// 推理跳过——回放关心动作与答复，不关心思考草稿）
func parseAssistantLine(line []byte, entries *[]TimelineEntry) {
	var m struct {
		Message struct {
			Content []struct {
				Type  string          `json:"type"`
				Text  string          `json:"text"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"message"`
		Timestamp string `json:"timestamp"`
	}
	if !looseUnmarshal(line, &m) {
		return
	}
	for _, item := range m.Message.Content {
		switch item.Type {
		case "text":
			if text := strings.TrimSpace(item.Text); text != "" {
				*entries = append(*entries, TimelineEntry{
					Kind: "assistant",
					At:   m.Timestamp,
					Text: truncateRunes(text, timelineTextMaxRunes),
				})
			}
		case "tool_use":
			*entries = append(*entries, TimelineEntry{
				Kind:  "tool",
				At:    m.Timestamp,
				Tool:  item.Name,
				Input: summarizeToolInput(item.Input),
			})
		}
	}
}

// appendUserText 用户文本入列：空文本/元信息块跳过，其余截断入列
func appendUserText(entries *[]TimelineEntry, text, at string) {
	text = strings.TrimSpace(text)
	if text == "" || !isTitleWorthy(text) {
		return
	}
	*entries = append(*entries, TimelineEntry{
		Kind: "user",
		At:   at,
		Text: truncateRunes(text, timelineTextMaxRunes),
	})
}

// resultStatus 工具结果状态（is_error 缺省 false）
func resultStatus(isErr bool) string {
	if isErr {
		return "error"
	}
	return "ok"
}

// toolInputTextKeys 工具关键输入的偏好键序：命中即取值做输入摘要。通用键
// 覆盖绝大多数内置工具；新工具未命中时回退对象里首个字符串值，无需随
// claude 版本追新
var toolInputTextKeys = []string{
	"command", "file_path", "path", "pattern", "url", "query", "prompt",
	"description", "skill", "agent_type", "subject",
}

// summarizeToolInput 工具输入摘要：偏好键序取首个非空字符串值；全未命中
// 回退首个字符串值；解析失败返回空（不展示比展示错安全）
func summarizeToolInput(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	fallback := ""
	for _, k := range toolInputTextKeys {
		if v, ok := obj[k].(string); ok && strings.TrimSpace(v) != "" {
			return truncateRunes(strings.TrimSpace(v), timelineInputMaxRunes)
		}
	}
	for _, v := range obj {
		if s, ok := v.(string); ok {
			if s = strings.TrimSpace(s); s != "" && fallback == "" {
				fallback = s
			}
		}
	}
	return truncateRunes(fallback, timelineInputMaxRunes)
}

// summarizeRawText 工具结果摘要：content 为字符串直接取；为数组取首个
// text 项；截断到条目正文上限
func summarizeRawText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var txt string
	if json.Unmarshal(raw, &txt) == nil {
		return truncateRunes(strings.TrimSpace(txt), timelineTextMaxRunes)
	}
	var arr []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &arr) != nil {
		return ""
	}
	for _, item := range arr {
		if item.Type == "text" && strings.TrimSpace(item.Text) != "" {
			return truncateRunes(strings.TrimSpace(item.Text), timelineTextMaxRunes)
		}
	}
	return ""
}
