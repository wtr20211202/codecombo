// Package claudesessions 提供 Claude Code 本地会话存储的只读扫描：
// 目录布局 ~/.claude/projects/<编码工作目录>/<会话UUID>.jsonl（编码规则 =
// 路径分隔符与盘符冒号统一替换为 '-'，实测 C:\Users\x → C--Users-x）。
// 该存储是 claude 的内部实现、无兼容承诺：本模块只依赖四个稳定字段
// （文件名=会话ID、cwd、timestamp、用户消息文本），解析失败的行/文件一律
// 跳过，保证"列得出列表就能恢复，列表为空提示检查 ~/.claude"。
package claudesessions

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"codecombo/server/store"
)

// Session 单个 Claude 会话的对外元数据（只读，不含消息内容转写）
type Session struct {
	ID           string    `json:"id"`    // 会话 UUID（文件名去 .jsonl）
	Title        string    `json:"title"` // 首条有效用户消息截断（无则回退会话 id）
	Cwd          string    `json:"cwd"`   // 会话工作目录（恢复时作为终端 dir）
	MessageCount int       `json:"messageCount"`
	FirstAt      time.Time `json:"firstAt"`
	LastAt       time.Time `json:"lastAt"` // 文件 mtime（最后活动时间，排序键）
	SizeBytes    int64     `json:"sizeBytes"`
	// Active 文件 mtime 在 activeWindow 内 = 该对话正被一个活终端写入。
	// 此时"恢复"会 fork 出第二个 claude 进程写同一对话历史，必须禁止
	Active bool `json:"active"`
	// Pressure 上下文压力估算（P-20261002-58，pressure.go）：不随扫描计算，
	// 由端点 withPressure=true 时对活跃会话按需填充（nil = 未估算/无数据）
	Pressure *Pressure `json:"pressure,omitempty"`
	// Usage 累计 token 用量（P-20261002-139，usage.go）：扫描时全文逐行累计
	// assistant usage（input+output+cache_read），随 claudeindex 缓存透传
	//（nil = 无 usage 数据，「无数据」≠「零消耗」）
	Usage *Usage `json:"usage,omitempty"`
	// Ledger 结构化台账（P-20261005-208，ledger.go）：扫描时聚合 assistant
	// tool_use（写文件去重数 / shell 命令数 / 首尾跨时），随 claudeindex 缓存
	// 透传（nil = 无工具动作数据——纯聊天会话或纯只读工具会话，零值不上账）
	Ledger *Ledger `json:"ledger,omitempty"`
	// Starred / Note 人工策展层（P-20261003-67）：用户自域数据（车道 1 kind
	// "claudecur"），不随扫描产生——由 List 可变参 curation 注入后并入；索引
	// 条目（sessionToEntry）不落这两个字段，claudeindex 始终只是 transcript
	// 元数据的可重建镜像
	Starred bool   `json:"starred,omitempty"`
	Note    string `json:"note,omitempty"`
	// Hidden 策展隐藏（P-20261003-112）：仅管理视图（Index.ListHidden）行恒带
	// true；默认视图不含隐藏会话（WithCuration 已剔除），transcript 文件零触碰
	Hidden bool `json:"hidden,omitempty"`
	// TranscriptPath transcript 文件在本机的绝对路径（P-20261003-215）：数据面
	// 同源派生（root/dir/id 经 filepath.Join，不手拼分隔符），回放页「AI 总结」
	// 把它注入 ask-agent prompt 让 agent 自读全量转写。前端不自拼该路径——目录
	// 编码是 claude 内部实现且 Root() 受 SC_CLAUDE_DIR 覆盖；旧版本对端（远程
	// 实例代理到旧服务）无此字段，前端入口按缺失禁用降级
	TranscriptPath string `json:"transcriptPath,omitempty"`
}

// ListResult 列表结果：Total = 过滤后的可匹配总数（供前端「加载更多」判断）
type ListResult struct {
	Sessions []Session `json:"sessions"`
	Total    int       `json:"total"`
}

// 约束常量：防超大 transcript 拖慢扫描（claude 单文件可达数百 MB）
const (
	titleSearchBytes = 256 << 10 // 只在文件头部 256KB 内找标题/首条时间戳
	titleMaxRunes    = 80        // 标题截断
	searchCapBytes   = 8 << 20   // 搜索时单文件最多扫描 8MB（超出即止，结果可能不全）

	// activeWindow 活跃判定窗口：claude 运行中持续向对话 jsonl 追加消息，
	// mtime 未超窗即视为"正被活会话写入"（恢复入口隐藏）。取值需覆盖长
	// 思考间隙（纯 thinking 无工具输出时可数分钟无追加）。
	// P-20261031-1 起这是「宽档」基线：列表端点（api/terminal）在终端注册表
	// 精确关联下覆盖本判定（活终端=活跃、已关终端=立即失活），并对既无关联
	// 又无同目录活终端的原生会话收敛到 90s 窄档（僵尸「进行中」从最长 5min
	// 压到 90s）；本包保持纯扫描语义不感知终端注册表
	activeWindow = 5 * time.Minute
)

// Root Claude 存储根目录；CC_CLAUDE_DIR 环境变量覆盖（e2e/测试隔离用；
// SC_CLAUDE_DIR 旧名兼容双读一个版本期——P-20261025-1 标识切换）
func Root() string {
	if v := strings.TrimSpace(os.Getenv("CC_CLAUDE_DIR")); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("SC_CLAUDE_DIR")); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

// EncodePath 工作目录 → claude 存储目录名（正向编码无歧义；显示名不用反向
// 解码——编码不可逆，直接读条目里的 cwd 字段）
func EncodePath(p string) string {
	return strings.NewReplacer("\\", "-", "/", "-", ":", "-").Replace(p)
}

// List 扫描会话列表。projectPath 非空 = 项目级（只扫该工作目录对应子目录）；
// q 非空 = 行级大小写不敏感子串搜索（id/内容统一入口）。
// 分页：按 LastAt 倒序排序后取 [offset, offset+limit)。
// curation 可选注入策展数据（P-20261003-67）：传入即并入星标/备注并星标置顶
// （置顶在分页前，跨页有效）；缺省零变化（既有调用方/测试语义不变）
func List(root, projectPath, q string, limit, offset int, curation ...map[string]store.ClaudeSessionCur) (ListResult, error) {
	if root == "" {
		return ListResult{}, fmt.Errorf("claude projects dir unavailable")
	}
	var dirs []string
	if projectPath != "" {
		// 项目路径可能带尾部分隔符（store 里存有 "D:\proj\" 形态）：
		// 归一化后再编码，否则目录名多一个 '-' 对不上
		projectPath = strings.TrimRight(projectPath, `\/`)
		dirs = []string{filepath.Join(root, EncodePath(projectPath))}
	} else {
		entries, err := os.ReadDir(root)
		if err != nil {
			return ListResult{}, fmt.Errorf("read claude projects dir: %w", err)
		}
		for _, e := range entries {
			if e.IsDir() {
				dirs = append(dirs, filepath.Join(root, e.Name()))
			}
		}
	}

	all := make([]Session, 0, 32)
	for _, dir := range dirs {
		files, err := os.ReadDir(dir)
		if err != nil {
			continue // 子目录不存在/不可读：跳过（项目级目录不存在 = 无会话）
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			s, matched, err := scanFile(filepath.Join(dir, f.Name()), q)
			if err != nil || !matched {
				continue
			}
			all = append(all, s)
		}
	}

	sort.Slice(all, func(i, j int) bool { return all[i].LastAt.After(all[j].LastAt) })
	all = WithCuration(all, curation...) // 策展处置（P-67 星标置顶 / P-112 剔除隐藏）：必须在分页切片前
	total := len(all)
	if offset < 0 {
		offset = 0
	}
	if offset >= total {
		return ListResult{Sessions: []Session{}, Total: total}, nil
	}
	end := offset + limit
	if limit <= 0 || end > total {
		end = total
	}
	return ListResult{Sessions: all[offset:end], Total: total}, nil
}

// FindResumeCwd 按会话 id 在全部项目目录中定位 .jsonl，返回其 cwd（恢复时
// 作为终端工作目录）。id 含路径分隔符/扩展符直接拒绝（防目录穿越）。
func FindResumeCwd(root, sessionID string) string {
	if root == "" || sessionID == "" || strings.ContainsAny(sessionID, "\\/.") {
		return ""
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(root, e.Name(), sessionID+".jsonl")
		if _, err := os.Stat(path); err != nil {
			continue
		}
		s, _, err := scanFile(path, "")
		if err != nil {
			return ""
		}
		return s.Cwd
	}
	return ""
}

// scanFile 扫描单个 .jsonl：行计数 + 标题/首条时间戳（头部窗口）+ q 匹配。
// matched=false 表示不匹配 q（q 为空时只要有内容即匹配）。
func scanFile(path, q string) (Session, bool, error) {
	st, err := os.Stat(path)
	if err != nil {
		return Session{}, false, err
	}
	s := Session{
		ID:        strings.TrimSuffix(filepath.Base(path), ".jsonl"),
		LastAt:    st.ModTime(),
		SizeBytes: st.Size(),
		Active:    time.Since(st.ModTime()) <= activeWindow,
		// 全量扫描路径手里就是真实文件路径，直存（索引命中路径在 entryToSession 同源派生）
		TranscriptPath: path,
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return Session{}, false, err
	}

	searchLower := strings.ToLower(q)
	searchLowerBytes := []byte(searchLower)
	// 会话 id 只存在于文件名（内容里未必出现），纳入匹配范围
	idLower := strings.ToLower(s.ID)
	headWindow := titleSearchBytes
	if len(data) < headWindow {
		headWindow = len(data)
	}

	lines := 0
	matched := q == ""
	ledger := newLedgerAccum() // 台账聚合器（P-208）：与 usage 同一扫描循环顺带累计
	for offset := 0; offset < len(data); {
		var line []byte
		if nl := bytes.IndexByte(data[offset:], '\n'); nl >= 0 {
			line = data[offset : offset+nl]
			offset += nl + 1
		} else {
			line = data[offset:]
			offset = len(data)
		}
		lines++

		// 头部窗口内提取标题/首条时间戳/cwd（齐了不再解析头部字段）
		if offset <= headWindow && (s.Cwd == "" || s.Title == "" || s.FirstAt.IsZero()) {
			parseHead(line, &s)
		}
		// usage 聚合（P-139，usage.go）：全文逐行累计 assistant usage，键子串
		// 预滤后非 assistant 行零解析成本；坏行宽容跳过
		accumulateUsage(&s, line)
		// 台账聚合（P-208，ledger.go）：assistant tool_use 的会话级量化摘要
		ledger.accumulate(line)
		// 搜索：仅匹配人类可读文本（content/text/summary 字段值）+ 会话 id。
		// 不做整行裸匹配——行内 uuid/时间戳/尺寸等元数据会让短数字查询
		// （如 "47"）命中几乎所有会话，用户看到的是「搜索完全没过滤」
		if !matched && q != "" && offset <= searchCapBytes {
			lower := bytes.ToLower(line)
			if lineHumanTextMatch(lower, searchLowerBytes) || strings.Contains(idLower, searchLower) {
				matched = true
			}
		}
	}
	s.MessageCount = lines
	s.Ledger = ledger.result()

	if q != "" && !matched {
		return Session{}, false, nil
	}
	if s.Title == "" {
		s.Title = s.ID
	}
	return s, true, nil
}

// searchValueKeys 搜索仅匹配这些键的字符串值（人类可读对话文本）。
// 大小写不敏感：调用方传入的是已 ToLower 的整行，键本身为小写
var searchValueKeys = []string{`"content"`, `"text"`, `"summary"`}

// lineHumanTextMatch 在已小写的行内提取 searchValueKeys 各键的字符串值段，
// 对值段做子串匹配。只匹配值而非整行——jsonl 行内的时间戳/uuid/尺寸等
// 元数据泛数字，裸匹配会让短查询全命中。防御式实现：解析不出值段就跳过
func lineHumanTextMatch(lowerLine, searchLower []byte) bool {
	if len(searchLower) == 0 {
		return false
	}
	for _, key := range searchValueKeys {
		for pos := 0; ; {
			i := bytes.Index(lowerLine[pos:], []byte(key))
			if i < 0 {
				break
			}
			i += pos + len(key)
			// 跳过键后冒号与可选空格，期望字符串值开头
			j := i
			for j < len(lowerLine) && (lowerLine[j] == ' ' || lowerLine[j] == ':') {
				j++
			}
			if j >= len(lowerLine) || lowerLine[j] != '"' {
				pos = i
				continue
			}
			j++
			start := j
			for j < len(lowerLine) {
				if lowerLine[j] == '\\' {
					j += 2
					continue
				}
				if lowerLine[j] == '"' {
					break
				}
				j++
			}
			if j > start && bytes.Contains(lowerLine[start:j], searchLower) {
				return true
			}
			pos = j
		}
	}
	return false
}

// parseHead 从单行提取首条时间戳与标题（首条非 sidechain 用户消息文本）；
// 提取到即跳过后续同类解析（由调用方以 offset<=headWindow 控制窗口）
func parseHead(line []byte, s *Session) {
	if s.Cwd == "" && bytes.Contains(line, []byte(`"cwd"`)) {
		var head struct {
			Cwd string `json:"cwd"`
		}
		if looseUnmarshal(line, &head) && head.Cwd != "" {
			s.Cwd = head.Cwd
		}
	}
	if s.FirstAt.IsZero() && bytes.Contains(line, []byte(`"timestamp"`)) {
		var head struct {
			Timestamp string `json:"timestamp"`
		}
		if looseUnmarshal(line, &head) && head.Timestamp != "" {
			if ts, err := time.Parse(time.RFC3339, head.Timestamp); err == nil {
				s.FirstAt = ts
			}
		}
	}
	if s.Title == "" && isUserLine(line) {
		if title := extractUserText(line); isTitleWorthy(title) {
			s.Title = truncateRunes(title, titleMaxRunes)
		}
	}
}

// titleMetaPrefixes Claude Code 自身注入的元信息块前缀（local command 记录 /
// resume caveat 等）：作为首条"用户消息"出现时不构成有效标题——跳过继续向
// 后找真实消息，全部命中则由 scanFile 回退会话 id
var titleMetaPrefixes = []string{
	"<local-command-caveat>", "<local-command-stdout>", "<local-command-stderr>",
	"<command-name>", "<command-message>", "<command-args>",
	"Caveat:", // 部分版本 caveat 正文不带外层标签
}

// isTitleWorthy 文本是否可作会话标题（非空、非元信息块、渲染后肉眼可辨）。
// 最后一档防「纯噪声文本」：终端二进制输出转发进 claude 后首条用户消息可能
// 是整串替换符/零宽符（实测 2026-10-31 用户数据：标题=8×U+FFFD）——这类
// 文本渲染为空白或成排豆腐块，等于行失语；不 worthy 让 parseHead 继续向后
// 找真实消息，全部命中由 scanFile 回退会话 id（恒可见）
func isTitleWorthy(text string) bool {
	if text == "" {
		return false
	}
	for _, p := range titleMetaPrefixes {
		if strings.HasPrefix(text, p) {
			return false
		}
	}
	return hasVisibleRunes(text)
}

// hasVisibleRunes 文本剥离「不构成可读字形」的字符后是否还剩可见内容：
// 控制符（Cc）、格式符（Cf：零宽空格/连接符、BOM、双向控制等）与替换符
// U+FFFD 均不产生可辨识字形。坏字节经 encoding/json 解析本就会归一为
// U+FFFD（json.Unmarshal 对非法 UTF-8 的替换语义），无需另设非法字节分支
func hasVisibleRunes(text string) bool {
	for _, r := range text {
		if r == '\uFFFD' || unicode.IsControl(r) || unicode.In(r, unicode.Cf) {
			continue
		}
		return true
	}
	return false
}

// looseUnmarshal 宽松解析：非 JSON 对象行/解析失败一律 false（防御式，绝不 panic）
func looseUnmarshal(line []byte, v any) bool {
	if len(line) == 0 || line[0] != '{' {
		return false
	}
	return json.Unmarshal(line, v) == nil
}

// isUserLine 用户消息行判定：紧凑/带空格两种字段形态的子串预滤
func isUserLine(line []byte) bool {
	return bytes.Contains(line, []byte(`"type":"user"`)) ||
		bytes.Contains(line, []byte(`"type": "user"`))
}

// extractUserText 用户消息文本：content 为字符串，或数组取首个 text 项；
// sidechain（子代理）消息不作标题
func extractUserText(line []byte) string {
	var m struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		IsSidechain bool `json:"isSidechain"`
	}
	if !looseUnmarshal(line, &m) || m.IsSidechain {
		return ""
	}
	var txt string
	if err := json.Unmarshal(m.Message.Content, &txt); err == nil {
		return strings.TrimSpace(txt)
	}
	var arr []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(m.Message.Content, &arr); err == nil {
		for _, item := range arr {
			if item.Type == "text" && strings.TrimSpace(item.Text) != "" {
				return strings.TrimSpace(item.Text)
			}
		}
	}
	return ""
}

// truncateRunes 按 rune 截断（中文标题不截半字）
func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max]) + "…"
}
