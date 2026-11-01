// 会话历史全文搜索（P-20261003-19）：跨 transcripts 的内容检索层——数月积累的
// 会话 jsonl 是知识资产（「上次 WebSocket 重连怎么解决的」），列表 q 只能按会话
// 过滤，本文件补上「命中带上下文」的检索：逐 transcript 按行提取 user/assistant
// 消息文本做大小写不敏感子串匹配，每会话返回最先命中的 ≤2 条上下文（带消息
// 时刻，供前端回放定位直达——P-96 模式）。
//
// 与列表搜索（claudesessions.go 的 q 模式）分工：列表 q 只回答「哪些会话提到」
// （行级布尔，零上下文），本层回答「提到时的原文是什么、怎么跳过去看」——解析
// 复用 timeline.go 的 user/assistant 行解析（sidechain/元信息块/思考草稿的既定
// 口径全部继承）。
//
// 护栏三闸（防超大语料拖垮请求，超限如实上报 truncated）：
//   - 单文件 5MB 上限跳过（claude 单文件可达数百 MB，截图 base64 常态超限）
//   - 扫描会话上限 200（只扫最近活跃的 200 个，mtime 倒序）
//   - 总时限 5s（到点立即收手，返回已得结果）
//
// 安全面（修正项）：transcripts 可能含粘贴的密钥/token，命中上下文先经
// mask.MaskText（P-108 敏感遮蔽，与 tap 写盘前同款模式集）再离开本包——
// 检索面不得放大敏感曝光。
//
// 枚举适配注记：提案原文口径为「遍历 claudeindex 条目」，实施为「目录 stat 级
// 枚举 + claudeindex 条目作元数据源（标题/目录免重复解析）」——枚举始终新鲜
// （含尚未对账的新文件），索引缺席（冷数据面/缓存被清）不阻碍搜索（首跑即可
// 用）；路径取自 Root() 下目录枚举而非用户输入（与提案的安全前提同成立）。
package claudesessions

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"codecombo/server/mask"
	"codecombo/server/store"
)

// 护栏与呈现常量
const (
	// 护栏一：单文件 5MB 上限，超过整体跳过（该会话未参与检索 → truncated）
	searchFileMaxBytes = 5 << 20
	// 护栏二：扫描会话上限（mtime 倒序取最近 200 个）
	searchSessionCap = 200
	// 护栏三：总时限，到点返回已得 + truncated
	searchTotalBudget = 5 * time.Second
	// 时限检查间隔（逐行 time.Now() 在 5MB×200 行级扫描下是可观测开销，按行
	// 计数抽样；单行最坏成本受 5MB 文件上限约束，抽样粒度足够）
	searchDeadlineCheckEvery = 256

	// 每会话命中上下文行数上限（提案口径 ≤2 行）
	searchHitLinesMax = 2
	// 单条上下文片段 rune 截断（命中点前后取窗，突出命中点之后的内容）
	searchSnippetRunes   = 120
	searchSnippetLeadRun = 40

	// 响应条数上限（前端一屏结果；超出部分截断并如实上报）
	SearchLimitDefault = 20
	SearchLimitMax     = 50
)

// SearchHitLine 单条命中上下文：消息文本片段（已敏感遮蔽）+ 该消息时刻
// （RFC3339；个别行无 timestamp 为空）——时刻供回放弹层 focusAt 定位直达
type SearchHitLine struct {
	At   string `json:"at,omitempty"`
	Text string `json:"text"`
}

// SearchHit 单会话命中条目（会话 id 供回放直达；Title = 首条有效用户消息摘要，
// 与列表标题同源）
type SearchHit struct {
	SessionID string          `json:"sessionId"`
	Title     string          `json:"title"`
	Cwd       string          `json:"cwd,omitempty"`
	LastAt    time.Time       `json:"lastAt"`
	Active    bool            `json:"active"`
	Lines     []SearchHitLine `json:"lines"`
	// Note 命中的备注原文（P-20261003-67 策展层，已敏感遮蔽）：非空 = 备注也
	// 命中查询词（或为 note-only 命中——Lines 空），前端打「备注」来源标识
	Note string `json:"note,omitempty"`
}

// SearchResult 全文搜索结果：Truncated = 任一护栏触发（大文件跳过/会话上限/
// 超时/条数截断），结果可能不全——前端提示「结果可能不全」而非静默缺斤短两
type SearchResult struct {
	Hits      []SearchHit `json:"hits"`
	Truncated bool        `json:"truncated"`
}

// Search 跨会话全文搜索（Index 复用：root 与 claudeindex 仓库同列表）。
// projectPath 非空 = 项目级（只扫该工作目录对应子目录）；q 大小写不敏感子串
// 匹配 user/assistant 消息文本。同步执行（护栏保证有界），无分页语义——一次
// 返回至多 SearchLimitMax 个会话的命中
func (ix *Index) Search(projectPath, q string, limit int) SearchResult {
	return ix.searchWithin(projectPath, q, limit, time.Now().Add(searchTotalBudget))
}

// searchWithin 带时限的搜索主体（deadline 注入供护栏单测注入过去/未来时刻）
func (ix *Index) searchWithin(projectPath, q string, limit int, deadline time.Time) SearchResult {
	res := SearchResult{Hits: []SearchHit{}}
	if ix.root == "" || strings.TrimSpace(q) == "" {
		return res
	}
	if limit <= 0 || limit > SearchLimitMax {
		limit = SearchLimitMax
	}

	targets, capped := ix.searchTargets(projectPath)
	truncated := capped // 护栏二：目标枚举被封顶截断（可能还有更旧的会话未扫）
	over := false       // 护栏三：总时限到，立即收手
	linesSeen := 0
	for i := range targets {
		if !time.Now().Before(deadline) {
			over = true
			break
		}
		t := &targets[i]
		if t.size > searchFileMaxBytes {
			truncated = true // 护栏一：超大文件未参与检索
			continue
		}
		hit, deadlineHit := scanSessionForMatch(t, strings.ToLower(q), deadline, &linesSeen)
		if hit != nil {
			res.Hits = append(res.Hits, *hit)
		}
		if deadlineHit {
			over = true
			break
		}
	}
	if over {
		truncated = true
	}
	// targets 已按 mtime 倒序，Hits 天然按最近活跃在前；条数超出响应上限时
	// 截断（被丢弃的命中会话真实存在 → 如实上报）
	if len(res.Hits) > limit {
		res.Hits = res.Hits[:limit]
		truncated = true
	}
	res.Truncated = truncated
	return res
}

// searchTarget 一个待扫描 transcript：路径/大小/mtime 取自目录枚举，元数据
// （标题/cwd）优先沿用 claudeindex 条目（列表已解析过，免重复读头部）
type searchTarget struct {
	id      string
	path    string
	size    int64
	modTime time.Time
	meta    *store.ClaudeIndexEntry // 索引未含（新文件/缓存被清）为 nil，由扫描自取
}

// searchTargets 枚举待扫描会话：目录 stat 级枚举（与列表同源、始终新鲜），
// mtime 倒序后封顶 searchSessionCap。capped = 枚举确实被上限截断（更旧的
// 会话未入扫描清单）。claudeindex 条目按 <root>__<dir>__<id> 键批量取一次
// 作元数据源；索引读失败退化为空表（可重建缓存，不阻碍搜索）
func (ix *Index) searchTargets(projectPath string) (targets []searchTarget, capped bool) {
	var dirs []string
	if projectPath != "" {
		projectPath = strings.TrimRight(projectPath, `\/`)
		dirs = []string{filepath.Join(ix.root, EncodePath(projectPath))}
	} else {
		entries, err := os.ReadDir(ix.root)
		if err != nil {
			return nil, false
		}
		for _, e := range entries {
			if e.IsDir() {
				dirs = append(dirs, filepath.Join(ix.root, e.Name()))
			}
		}
	}

	known, err := ix.repo.GetBatch(store.ClaudeIndexPrefix(ix.root, ""))
	if err != nil {
		known = map[string]store.ClaudeIndexEntry{}
	}

	targets = make([]searchTarget, 0, 32)
	for _, dir := range dirs {
		dirName := filepath.Base(dir)
		files, err := os.ReadDir(dir)
		if err != nil {
			continue // 子目录不存在/不可读：跳过（与列表同语义）
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			st, err := f.Info()
			if err != nil {
				continue
			}
			t := searchTarget{
				id:      strings.TrimSuffix(f.Name(), ".jsonl"),
				path:    filepath.Join(dir, f.Name()),
				size:    st.Size(),
				modTime: st.ModTime(),
			}
			if e, ok := known[store.ClaudeIndexKey(ix.root, dirName, t.id)]; ok {
				meta := e
				t.meta = &meta
			}
			targets = append(targets, t)
		}
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].modTime.After(targets[j].modTime) })
	if len(targets) > searchSessionCap {
		targets = targets[:searchSessionCap]
		capped = true
	}
	return targets, capped
}

// scanSessionForMatch 单 transcript 内容扫描：逐行预滤（小写包含）后解析出
// user/assistant 消息文本再精确匹配——行内 uuid/时间戳等元数据不参与（与列表
// 搜索「人类可读文本」口径一致，短数字查询不泛命中）。取齐 searchHitLinesMax
// 条上下文即止读（单文件成本有界）。命中行片段经 P-108 敏感遮蔽后才返回。
// 返回 nil hit = 无命中；deadlineHit = 总时限到（调用方立即收手并上报 truncated）
func scanSessionForMatch(t *searchTarget, qLower string, deadline time.Time, linesSeen *int) (hit *SearchHit, deadlineHit bool) {
	data, err := os.ReadFile(t.path)
	if err != nil {
		return nil, false // 文件恰被删除/不可读：跳过（宽松容错，与列表同语义）
	}

	h := &SearchHit{
		SessionID: t.id,
		LastAt:    t.modTime,
		Active:    time.Since(t.modTime) <= activeWindow,
	}
	if t.meta != nil {
		h.Title = t.meta.Title
		h.Cwd = t.meta.Cwd
	}
	// 索引缺席时由扫描自取头部元数据（cwd/首条标题，与 scanFile 同款头部窗口
	// 与解析口径）；齐了即停
	var head Session
	needHead := t.meta == nil

	for offset := 0; offset < len(data); {
		var line []byte
		if nl := bytes.IndexByte(data[offset:], '\n'); nl >= 0 {
			line = data[offset : offset+nl]
			offset += nl + 1
		} else {
			line = data[offset:]
			offset = len(data)
		}
		*linesSeen++
		if *linesSeen%searchDeadlineCheckEvery == 0 && !time.Now().Before(deadline) {
			break // 已得上下文照常返回，deadlineHit 让调用方上报截断
		}
		if len(h.Lines) >= searchHitLinesMax {
			break // 该会话上下文已齐：止读（剩余内容不再消耗预算）
		}

		if needHead && offset <= titleSearchBytes && (head.Cwd == "" || head.Title == "") {
			parseHead(line, &head)
		}
		lower := bytes.ToLower(line)
		if !bytes.Contains(lower, []byte(qLower)) {
			continue
		}

		// 命中行：解析出 user/assistant 消息文本逐条比对（预滤命中的可能是
		// 工具输入等非对话文本，此步过滤）
		var entries []TimelineEntry
		switch {
		case isUserLine(line):
			parseUserLine(line, &entries)
		case isAssistantLine(line):
			parseAssistantLine(line, &entries)
		}
		for _, e := range entries {
			if e.Kind != "user" && e.Kind != "assistant" {
				continue // 提案口径：只检索 user/assistant 消息文本
			}
			ri := indexFoldRunes(e.Text, qLower)
			if ri < 0 {
				continue
			}
			h.Lines = append(h.Lines, SearchHitLine{
				At:   e.At,
				Text: mask.MaskText(searchSnippet(e.Text, ri)),
			})
			if len(h.Lines) >= searchHitLinesMax {
				break
			}
		}
	}

	if len(h.Lines) == 0 {
		return nil, false
	}
	if h.Title == "" {
		h.Title = head.Title
	}
	if h.Title == "" {
		h.Title = t.id // 无标题可取：回退会话 id（与列表同款兜底）
	}
	// 标题 = 首条用户消息摘要，与命中上下文同为敏感曝光面：粘贴的密钥常落在
	// 首条消息里，同样套 P-108 遮蔽（对 uuid/普通标题为无感 no-op）
	h.Title = mask.MaskText(h.Title)
	if h.Cwd == "" {
		h.Cwd = head.Cwd
	}
	return h, deadlineHitCheck(deadline)
}

// deadlineHitCheck 扫描收尾时的时限复核（正文极短未触发抽样检查的文件也兜住）
func deadlineHitCheck(deadline time.Time) bool {
	return !time.Now().Before(deadline)
}

// searchSnippet 命中点前后取窗：空白折叠为单空格（jsonl 文本里的 \n 缩进在
// 结果列表里按单行摘要呈现），以命中 rune 位置为中心截 ≤searchSnippetRunes
// 片段（前留 searchSnippetLeadRun，突出命中点之后内容），首尾截断处补省略号
func searchSnippet(text string, matchRuneIdx int) string {
	flat := strings.Join(strings.Fields(text), " ")
	runes := []rune(flat)
	start := matchRuneIdx - searchSnippetLeadRun
	if start < 0 {
		start = 0
	}
	end := start + searchSnippetRunes
	if end > len(runes) {
		end = len(runes)
		start = end - searchSnippetRunes
		if start < 0 {
			start = 0
		}
	}
	out := string(runes[start:end])
	if start > 0 {
		out = "…" + out
	}
	if end < len(runes) {
		out += "…"
	}
	return out
}

// indexFoldRunes 已小写域的子串查找：返回 needle 在 hay（rune 切片）中的
// rune 下标，无命中 -1。入参长度有界（消息文本 ≤200 rune 摘要 × 短查询），
// 朴素比对即可——字节域下标在多字节文本上会切半字，rune 域取窗才是正确截断
func indexFoldRunes(hay, needle string) int {
	h := []rune(strings.ToLower(hay))
	n := []rune(needle)
	if len(n) == 0 || len(n) > len(h) {
		return -1
	}
	for i := 0; i+len(n) <= len(h); i++ {
		match := true
		for j := range n {
			if h[i+j] != n[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}
