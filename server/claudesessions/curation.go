// 会话人工策展层（P-20261003-67）：把用户自域的星标/备注（车道 1 kind
// "claudecur"，server/store/claudecur.go）并入只读扫描结果。transcript 本体
// 是外部数据（车道 3），策展是本系统的增强层——两域仅在「会话 UUID」处相交。
//
// 入口：
//   - WithCuration：列表并入星标/备注 + 剔除隐藏（P-112）+ 星标置顶重排
//     （分页前调用，跨页有效）
//   - FetchCuration：按存储根批量取策展条目（读失败退化空表，不阻碍主链路）
//   - (*Index).MergeNoteHits：全文搜索把「备注命中」并入结果（P-19 检索扫描
//     逻辑零改动，note 只是其外的额外命中源），命中带备注原文供前端打「备注」
//     来源标识
//   - (*Index).ListHidden / DropHiddenHits / VisibleEntries：隐藏层三消费面
//     （P-112 管理视图 / 检索剔除 / 日报剔除）——transcript 文件零触碰，隐藏
//     只是索引层与各读面的策展叠加
package claudesessions

import (
	"sort"
	"strings"
	"time"

	"codecombo/server/mask"
	"codecombo/server/store"
)

// WithCuration 并入策展元数据（星标/备注）、剔除被隐藏会话（P-20261003-112
// 列表默认排除 hidden）并做星标置顶重排，返回处置后的切片（隐藏剔除会缩短
// 列表——调用方必须接住返回值再分页，Total 才能不含隐藏行）。
//
// 剔除与置顶都必须在分页前做——分页在 List 内部按 LastAt 倒序切片，若分页后
// 处置，后页的星标/隐藏会话行为就错了（星标进不了第一屏；隐藏行占分页名额）。
// 索引重扫自动尊重 hidden：hidden 存 claudecur（车道 1 用户自域），claudeindex
// 重扫重建的是 transcript 镜像不碰策展，重扫出的行在这里按策展再次退场，不复活。
func WithCuration(sessions []Session, curation ...map[string]store.ClaudeSessionCur) []Session {
	if len(curation) == 0 || len(curation[0]) == 0 {
		return sessions
	}
	cur := curation[0]
	kept := make([]Session, 0, len(sessions))
	for _, s := range sessions {
		if c, ok := cur[s.ID]; ok {
			if c.Hidden {
				continue // 隐藏会话不进默认视图（管理视图走 Index.ListHidden）
			}
			s.Starred = c.Starred
			s.Note = c.Note
		}
		kept = append(kept, s)
	}
	sortStarredFirst(kept)
	return kept
}

// sortStarredFirst 星标置顶的稳定重排：星标组在前、普通组在后，组内保持既有
// LastAt 倒序（稳定排序对同键元素保序，不重排输入顺序）
func sortStarredFirst(sessions []Session) {
	sort.SliceStable(sessions, func(i, j int) bool {
		if sessions[i].Starred != sessions[j].Starred {
			return sessions[i].Starred
		}
		return false // 同组：保持调用方已排好的 LastAt 倒序
	})
}

// FetchCuration 按存储根批量取全部策展条目，**按会话 id 重键**（repo 层
// GetBatch 以文档键 <rootHash>__<id> 为键，直接透传会让按 id 的查找全部落空）。
// repo 为 nil / root 为空 / 读失败一律返回 nil——策展是增强层，任何异常不得
// 阻断列表/搜索主链路
func FetchCuration(repo store.ClaudeSessionCurStore, root string) map[string]store.ClaudeSessionCur {
	if repo == nil || root == "" {
		return nil
	}
	m, err := repo.GetBatch(store.ClaudeCurPrefix(root))
	if err != nil {
		return nil
	}
	out := make(map[string]store.ClaudeSessionCur, len(m))
	for _, c := range m {
		out[c.ID] = c
	}
	return out
}

// ListHidden 管理视图（P-20261003-112「显示已隐藏」）：只返回被策展隐藏且
// transcript 仍存活的会话行。数据源 = claudeindex 条目（stat 级镜像，任意一次
// 默认列表请求即重建）∩ hidden 策展——与孤儿策展防御同款「存活 ∩ 策展」消费
// 惯例：transcript 已消失的隐藏条目不产幽灵行，同 id 重建（claude --resume 续写
// 新文件）后自动跟回。冷索引退化为空表（隐藏只能从列表行发起——先有列表后有
// 隐藏，管理视图打开前列表链路已把索引建好）。LastAt 倒序，行上并入星标/备注，
// Hidden 恒 true 供前端渲染「已隐藏」徽标。
func (ix *Index) ListHidden(projectPath string, curation map[string]store.ClaudeSessionCur) []Session {
	hidden := make(map[string]bool, len(curation))
	for _, c := range curation {
		if c.Hidden {
			hidden[c.ID] = true
		}
	}
	if len(hidden) == 0 {
		return []Session{}
	}
	if projectPath != "" {
		projectPath = strings.TrimRight(projectPath, `\/`)
	}
	known, err := ix.repo.GetBatch(store.ClaudeIndexPrefix(ix.root, EncodePath(projectPath)))
	if err != nil {
		return []Session{} // 索引读失败：空表而非报错（可重建缓存，不阻碍管理视图）
	}
	out := make([]Session, 0, len(hidden))
	for _, e := range known {
		if !hidden[e.ID] {
			continue
		}
		s := entryToSession(e, ix.root)
		if c, ok := curation[e.ID]; ok {
			s.Starred = c.Starred
			s.Note = c.Note
		}
		s.Hidden = true
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastAt.After(out[j].LastAt) })
	return out
}

// LookupTitle 按会话 id 从索引条目取标题（审计 Detail 自明化用——隐藏/恢复
// 事件带会话名，翻台账不用再查 id）。索引缺席/查不到回退会话 id 本身：策展
// 可先于/晚于索引生命周期，标题尽力而为不阻断策展主链路
func (ix *Index) LookupTitle(sessionID string) string {
	if sessionID == "" {
		return sessionID
	}
	known, err := ix.repo.GetBatch(store.ClaudeIndexPrefix(ix.root, ""))
	if err != nil {
		return sessionID
	}
	for _, e := range known {
		if e.ID == sessionID && e.Title != "" {
			return e.Title
		}
	}
	return sessionID
}

// DropHiddenHits 搜索命中剔除被隐藏会话（P-20261003-112 检索默认排除 hidden）。
// 剔除在命中汇总后做：transcript 内容仍可能被扫描但不离开服务端——隐藏是
// 界面级抹除而非加密删除，检索面不再出现即达意。命中区非分页语义（一次返回
// 至多 limit 条），过滤后不足 limit 无需补扫
func DropHiddenHits(res *SearchResult, curation map[string]store.ClaudeSessionCur) {
	if res == nil || len(curation) == 0 || len(res.Hits) == 0 {
		return
	}
	kept := res.Hits[:0]
	for _, h := range res.Hits {
		if c, ok := curation[h.SessionID]; ok && c.Hidden {
			continue
		}
		kept = append(kept, h)
	}
	res.Hits = kept
}

// VisibleEntries 索引条目的可见性过滤（P-20261003-112 日报消费面）：剔除被
// 策展隐藏的会话条目——与列表 WithCuration 同一策展源同一口径，隐藏会话不再
// 计入日报的当日活跃数与 token 消耗（hidden 清理后历史事实一并退场）
func VisibleEntries(entries map[string]store.ClaudeIndexEntry, curation map[string]store.ClaudeSessionCur) []store.ClaudeIndexEntry {
	out := make([]store.ClaudeIndexEntry, 0, len(entries))
	for _, e := range entries {
		if c, ok := curation[e.ID]; ok && c.Hidden {
			continue
		}
		out = append(out, e)
	}
	return out
}

// MergeNoteHits 全文搜索的备注命中源（P-67）：备注匹配 q 的会话并入搜索结果——
//   - 已在 hits 里的会话：补 Note 字段（上下文行之外再带备注原文）
//   - 不在 hits 里的会话：追加 note-only 命中（Lines 空、Note = 备注原文）。
//     仅当其 claudeindex 条目存在时才追加：条目提供标题/cwd/LastAt 元数据，
//     同时证明 transcript 尚存活（索引对账即删消失文件的条目）——无条目不产
//     幽灵命中（冷索引场景该会话本轮缺席，任意一次列表请求即重建索引）
//
// projectPath 非空 = 项目级：note-only 命中要求索引条目目录与项目目录一致
// （备注条目自身无 cwd，归属只能借索引条目）。命中原文经 P-108 敏感遮蔽（备注
// 可能含粘贴的密钥，与 transcript 上下文同口径）。并入后超 limit 截断并如实
// 上报 truncated。备注扫描是车道 1 内存遍历（条目数 = 用户策展量级），无
// transcript 扫描的护栏需求
func (ix *Index) MergeNoteHits(res *SearchResult, cur map[string]store.ClaudeSessionCur, projectPath, q string, limit int) {
	if res == nil || len(cur) == 0 || strings.TrimSpace(q) == "" {
		return
	}
	// 索引条目按会话 id 索引（读失败退化为空表：已有命中照常补 Note，
	// note-only 追加因缺元数据全部跳过——宁缺勿幽灵）
	known, err := ix.repo.GetBatch(store.ClaudeIndexPrefix(ix.root, ""))
	meta := map[string]store.ClaudeIndexEntry{}
	if err == nil {
		for _, e := range known {
			meta[e.ID] = e
		}
	}
	if projectPath != "" {
		projectPath = strings.TrimRight(projectPath, `\/`)
	}
	qLower := strings.ToLower(q)

	// 按下标富化（勿持 *SearchHit 指针：下方 append 可能触发 Hits 扩容搬迁，
	// 旧指针写入会静默丢失——map 遍历序随机，先 append 后 enrich 的平台必现）
	byIdx := make(map[string]int, len(res.Hits))
	for i := range res.Hits {
		byIdx[res.Hits[i].SessionID] = i
	}
	for _, c := range cur {
		if c.Note == "" || c.Hidden {
			continue // 隐藏会话的备注不产命中（P-112：检索默认排除 hidden）
		}
		if !strings.Contains(strings.ToLower(c.Note), qLower) {
			continue
		}
		note := mask.MaskText(c.Note)
		if i, ok := byIdx[c.ID]; ok {
			res.Hits[i].Note = note // transcript 命中 + 备注也命中：同一行补备注标识
			continue
		}
		e, ok := meta[c.ID]
		if !ok {
			continue
		}
		if projectPath != "" && e.Dir != EncodePath(projectPath) {
			continue // 项目级范围：目录归属不符的备注命中不并入
		}
		res.Hits = append(res.Hits, SearchHit{
			SessionID: c.ID,
			Title:     e.Title,
			Cwd:       e.Cwd,
			LastAt:    e.LastAt,
			Active:    time.Since(e.LastAt) <= activeWindow,
			Note:      note,
		})
	}
	// 追加后条数可能越响应上限：与 searchWithin 同款截断 + 如实上报
	if len(res.Hits) > limit {
		res.Hits = res.Hits[:limit]
		res.Truncated = true
	}
}
