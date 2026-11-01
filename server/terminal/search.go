package terminal

import "strings"

// 跨会话输出检索核心（P-20261003-290）：「那个编译错误/端口号到底是哪个终端
// 打的」——遍历活会话按行子串匹配（不区分大小写），返回命中会话与命中行。
// 取文本与 GET /terminals/:id/scrollback 同一规整化路径（Session.CaptureScrollback：
// tmux capture-pane -e / native 环形缓冲），ANSI 剥离走 StripANSI 单实现。
// 检索核心放 terminal 包：单测可直接构造带缓冲的 Session（字段包内私有），
// API 层只做参数解析与响应整形。

const (
	// SearchScanLines 单会话扫描窗口（最近 N 行）：一次检索要过全部活会话
	//（上限 MaxSessions=50 × 每会话缓冲可达 MB 级），窗口限界防端点被当成
	// 全量转储打穿；排障场景关键词几乎总在最近输出里
	SearchScanLines = 2000
	// SearchPerSession 单会话命中上限：多会话常态下先看每会话头部命中，
	// 深扫留给单会话内搜索（MVP 边界）
	SearchPerSession = 10
	// SearchTotal 总量上限（响应硬顶，limit 参数只能更小）
	SearchTotal = 50
	// SearchLineMax 命中行展示截断（rune 计）：超长行（minified JS/长 JSON）
	// 按命中点截窗，防响应被单行撑爆；与输出哨兵 matchedLineOf 同护栏
	SearchLineMax = 200
	// searchWindowBefore/searchWindowAfter 超长行截窗时命中词前后保留的
	// rune 数：命中词保持可见，行其余部分让位
	searchWindowBefore = 60
	searchWindowAfter  = 140
)

// OutputHit 单条命中（API 层原样整形为 JSON 响应；json tag 即对外契约键，
// 前端 TerminalOutputSearchHit 与手册登记按此拼写——漏 tag 会序列化成大驼峰）
type OutputHit struct {
	SessionID   string `json:"sessionId"`   // 会话 id（前端激活跳转寻址键）
	SessionName string `json:"sessionName"` // 会话显示名
	ProjectID   string `json:"projectId"`   // 归属项目 id（agent 会话为空串）
	// LineText 命中行文本（已剥 ANSI；超长行按命中点截窗含省略号）
	LineText string `json:"lineText"`
	// HitIndex 命中行在扫描窗口内的 0 基行号（行序即输出时序，供前端展示
	// 命中序；将来会话内定位可复用）
	HitIndex int `json:"hitIndex"`
}

// SearchSessionsOutput 在给定会话的最近输出中检索 q（不区分大小写子串）。
// 会话按传入序（Manager.ListSessions = 创建序）消费，单会话命中
// SearchPerSession 条后前进、总量 SearchTotal 条即止。单会话取数失败跳过
// 不拖整体（会话可能正被关闭/capture 瞬时失败）。
// q 已由调用方保证 TrimSpace 后 rune 数 ≥ 2（与命令历史检索同门槛）
func SearchSessionsOutput(sessions []*Session, q string, perSession, total int) []OutputHit {
	needle := strings.ToLower(q)
	hits := make([]OutputHit, 0, 8)
	for _, s := range sessions {
		if len(hits) >= total {
			break
		}
		raw, err := s.CaptureScrollback(SearchScanLines)
		if err != nil || len(raw) == 0 {
			continue
		}
		per := 0
		for idx, line := range strings.Split(string(StripANSI(raw)), "\n") {
			if per >= perSession || len(hits) >= total {
				break
			}
			line = strings.TrimSuffix(line, "\r")
			lower := strings.ToLower(line)
			if !strings.Contains(lower, needle) {
				continue
			}
			hits = append(hits, OutputHit{
				SessionID:   s.ID,
				SessionName: s.Name,
				ProjectID:   s.ProjectID,
				LineText:    truncateLineAround(lower, needle, line),
				HitIndex:    idx,
			})
			per++
		}
	}
	return hits
}

// truncateLineAround 超长行展示截断：按命中点截窗（[命中前 searchWindowBefore，
// 命中后 searchWindowAfter] rune），切片按 rune 边界对齐防割裂多字节字符；
// 被切的侧加省略号。lower = strings.ToLower(line) 的返回值复用（检索循环已算
// 过，勿重复分配）。说明：极端 Unicode（如 İ）大小写转换会变字节长度，窗口
// 边界可能偏移数字节——仅影响展示窗位置，不影响命中判定与文本合法性
// （窗口边界仍按原行 rune 边界对齐）
func truncateLineAround(lower, needle, line string) string {
	runes := len([]rune(line))
	if runes <= SearchLineMax {
		return line
	}
	at := strings.Index(lower, needle)
	if at < 0 {
		at = 0 // 理论不可达（命中判定刚通过）；兜底从头截窗
	}
	// 命中点前取 searchWindowBefore 个 rune：逐 rune 回退到原行字节偏移
	lo := at
	for back := 0; lo > 0 && back < searchWindowBefore; {
		lo--
		back++
		for lo > 0 && !isRuneStart(line, lo) {
			lo--
		}
	}
	hi := at
	for fwd := 0; hi < len(line) && fwd < searchWindowAfter; {
		hi++
		fwd++
		for hi < len(line) && !isRuneStart(line, hi) {
			hi++
		}
	}
	out := line[lo:hi]
	if lo > 0 {
		out = "…" + out
	}
	if hi < len(line) {
		out += "…"
	}
	return out
}

// isRuneStart buf[at] 是否 UTF-8 字符起始字节（多字节序列内部字节不是）
func isRuneStart(buf string, at int) bool {
	return at >= len(buf) || buf[at]&0xC0 != 0x80
}
