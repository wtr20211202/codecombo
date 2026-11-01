// 会话列表可重建索引（车道 3 加速，docs/PERSISTENCE_LANES.md 车道 3）。
//
// 痛点：~/.claude/projects 下每个 .jsonl 是完整会话转写（单文件可达数百 MB），
// 历史列表接口每次请求全量读文件内容（标题/计数都要扫全文）。
//
// 方案：列表元数据镜像进车道 1 kind "claudeindex"（server/store/claudeindex.go），
// 每次列表请求做 stat 级对账——mtime+size 未变的文件直接用索引条目，
// 新增/变更文件才重读内容，消失文件的条目即时清除。
// 索引是加速缓存而非数据本体：删除 <DataDir>/data/claudeindex/ 后任意一次
// 列表即全量重建，损坏不影响正确性。
//
// 搜索（q 非空）仍走全量扫描：内容匹配必须读文件，索引不复制内容。
package claudesessions

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"codecombo/server/store"
)

// 与全量扫描版 List 一致的错误语义
var errRootUnavailable = errors.New("claude projects dir unavailable")

type errRootRead struct{ err error }

func (e errRootRead) Error() string { return "read claude projects dir: " + e.err.Error() }
func (e errRootRead) Unwrap() error { return e.err }

// Index 会话列表索引（按请求构造，无内部状态：对账态存于 claudeindex kind）
type Index struct {
	repo store.ClaudeIndexStore
	root string
}

// NewIndex 构造索引访问器；repo 来自 store.Get().ClaudeIndex，root 通常为 Root()
func NewIndex(repo store.ClaudeIndexStore, root string) *Index {
	return &Index{repo: repo, root: root}
}

// List 会话列表（无搜索词路径）。projectPath 非空 = 项目级；按 LastAt 倒序
// 取 [offset, offset+limit)。语义与全量扫描版 List 完全一致。
// curation 可选注入策展数据（P-20261003-67）：传入即并入星标/备注并星标置顶
// （置顶在分页前，跨页有效）；缺省零变化（既有调用方/测试语义不变）
func (ix *Index) List(projectPath string, limit, offset int, curation ...map[string]store.ClaudeSessionCur) (ListResult, error) {
	if ix.root == "" {
		return ListResult{}, errRootUnavailable
	}
	var dirs []string
	if projectPath != "" {
		projectPath = strings.TrimRight(projectPath, `\/`)
		dirs = []string{filepath.Join(ix.root, EncodePath(projectPath))}
	} else {
		entries, err := os.ReadDir(ix.root)
		if err != nil {
			return ListResult{}, errRootRead{err}
		}
		for _, e := range entries {
			if e.IsDir() {
				dirs = append(dirs, filepath.Join(ix.root, e.Name()))
			}
		}
	}

	all := make([]Session, 0, 32)
	present := make(map[string]bool, 64)
	for _, dir := range dirs {
		dirName := filepath.Base(dir)
		known, err := ix.repo.GetBatch(store.ClaudeIndexPrefix(ix.root, dirName))
		if err != nil {
			known = map[string]store.ClaudeIndexEntry{} // 索引读失败退化为全量重建该目录
		}
		files, err := os.ReadDir(dir)
		if err != nil {
			// 目录不存在/不可读：清掉该目录残留索引（如项目目录被删）后跳过
			for k := range known {
				_ = ix.repo.Delete(k)
			}
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(dir, f.Name())
			st, err := os.Stat(path)
			if err != nil {
				continue
			}
			id := strings.TrimSuffix(f.Name(), ".jsonl")
			key := store.ClaudeIndexKey(ix.root, dirName, id)
			present[key] = true
			// 命中：mtime+size 均未变且条目做过 usage 聚合与台账聚合（UsageKnown /
			// LedgerKnown 把升级前的旧条目判为未命中，各自一次性重扫补齐聚合，见
			// claudeindex.go / ledger.go）。
			// 标题可见性补判（P-20261031-1）：硬化 isTitleWorthy 之前写入的旧条目
			// 可能镜像了纯噪声标题（整串 U+FFFD/零宽符）——渲染即行失语，判为未
			// 命中走一次重扫（scanFile 换可见消息或回退 id 后 Put 覆盖），自愈一次
			// 后恢复零内容读
			if e, ok := known[key]; ok && e.UsageKnown && e.LedgerKnown && e.MtimeNs == st.ModTime().UnixNano() && e.SizeBytes == st.Size() && hasVisibleRunes(e.Title) {
				all = append(all, entryToSession(e, ix.root))
				continue
			}
			// 未命中：读内容重建该条目
			s, matched, err := scanFile(path, "")
			if err != nil || !matched {
				_ = ix.repo.Delete(key)
				continue
			}
			_ = ix.repo.Put(sessionToEntry(key, dirName, s, st))
			all = append(all, s)
		}
		// 目录内已消失文件的索引清除
		for k := range known {
			if !present[k] {
				_ = ix.repo.Delete(k)
			}
		}
	}
	// 全局列表：root 下整个项目目录被删时，其条目不会在目录遍历中出现——
	// 按 root 前缀兜底清除。项目级列表不越界（只碰自己目录的前缀）
	if projectPath == "" {
		if rootKnown, err := ix.repo.GetBatch(store.ClaudeIndexPrefix(ix.root, "")); err == nil {
			for k := range rootKnown {
				if !present[k] {
					_ = ix.repo.Delete(k)
				}
			}
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

func sessionToEntry(key, dirName string, s Session, st os.FileInfo) store.ClaudeIndexEntry {
	e := store.ClaudeIndexEntry{
		Key:          key,
		ID:           s.ID,
		Dir:          dirName,
		Title:        s.Title,
		Cwd:          s.Cwd,
		FirstAt:      s.FirstAt,
		LastAt:       s.LastAt,
		MessageCount: s.MessageCount,
		SizeBytes:    st.Size(),
		MtimeNs:      st.ModTime().UnixNano(),
		UsageKnown:   true, // 本次重扫已做 usage 聚合（无数据也是聚合结论，false 会引发重扫循环）
		LedgerKnown:  true, // 同上：台账聚合（P-208）本轮已做，nil 结论也要落标记
	}
	if s.Usage != nil {
		e.UsageInput = s.Usage.InputTokens
		e.UsageOutput = s.Usage.OutputTokens
		e.UsageCacheRead = s.Usage.CacheReadTokens
		e.UsageTotal = s.Usage.TotalTokens
	}
	if s.Ledger != nil {
		e.LedgerFiles = s.Ledger.FilesWritten
		e.LedgerCommands = s.Ledger.CommandsRun
		e.LedgerDurationMs = s.Ledger.DurationMs
	}
	return e
}

func entryToSession(e store.ClaudeIndexEntry, root string) Session {
	s := Session{
		ID:           e.ID,
		Title:        e.Title,
		Cwd:          e.Cwd,
		MessageCount: e.MessageCount,
		FirstAt:      e.FirstAt,
		LastAt:       e.LastAt,
		SizeBytes:    e.SizeBytes,
		// Active 是「当前时刻」的判定，不能沿用索引写入时的快照
		Active: time.Since(e.LastAt) <= activeWindow,
	}
	// transcript 路径同源派生（P-20261003-215）：索引条目持有编码目录名，root
	// 由访问器携带——产出与全量扫描路径（scanFile 直存真实路径）一致
	if root != "" && e.Dir != "" {
		s.TranscriptPath = filepath.Join(root, e.Dir, e.ID+".jsonl")
	}
	// 已扫描且确有用量才回填（UsageKnown+全零 = 扫过但无 usage 数据 → nil，
	// 与全文扫描路径的「无数据」形态一致）
	if e.UsageKnown && e.UsageTotal > 0 {
		s.Usage = &Usage{
			InputTokens:     e.UsageInput,
			OutputTokens:    e.UsageOutput,
			CacheReadTokens: e.UsageCacheRead,
			TotalTokens:     e.UsageTotal,
		}
	}
	// 台账同口径回填（P-208）：三项全零（纯只读工具会话）= 无展示数据 → nil，
	// 与扫描路径 result() 的「全零不上账」语义一致
	if e.LedgerKnown && (e.LedgerFiles > 0 || e.LedgerCommands > 0 || e.LedgerDurationMs > 0) {
		s.Ledger = &Ledger{
			FilesWritten: e.LedgerFiles,
			CommandsRun:  e.LedgerCommands,
			DurationMs:   e.LedgerDurationMs,
		}
	}
	return s
}
