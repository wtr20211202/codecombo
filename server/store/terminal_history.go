package store

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"codecombo/server/mask"
)

// sensitiveKeyPat 敏感凭据「键名」词表：赋值形态里出现在 =/: 左侧的键词。
// 唯一权威定义——sensitiveCmdRe（终端历史整条跳过）与 auditlog 的入账脱敏
// MaskAuditDetail（Append 层兜底）共用，改词表两处同时生效，禁止各自复制
// （词表分叉 = 两侧口径漂移）。token 不加右词边界：token123 / TOKEN_1 这类
// 后接字符的变体同样命中（消费侧再按需吞并）
const sensitiveKeyPat = `password|passwd|\btoken|secret|api[_-]?key`

// sensitiveValuePat 敏感凭据「值形态」词表：不带键名直接出现的定长凭据值
// （AWS 访问密钥 ID，大小写敏感防误伤普通 hex）。同上唯一权威，两处共用
const sensitiveValuePat = `AKIA[0-9A-Z]{16}`

// sensitiveCmdRe 敏感命令模式：命中整条不落盘（半截 mask 重跑反而危险，故整条跳过）
// PRIVATE KEY / 贴附口令旗标（-pXXXX，误伤面含 /projects 类路径）两形态只在
// 「整条跳过」语义下使用——审计侧的改写语义（MaskAuditDetail）若照搬会把
// 路径类正常文本一并打码，故只收键名赋值 + 裸云密钥两个子形态（见 auditlog.go）
var sensitiveCmdRe = regexp.MustCompile(`(?i)(` + sensitiveKeyPat + `|PRIVATE KEY|` + sensitiveValuePat + `|[-/]p[A-Za-z0-9_$]{4,}\b)`)

// 历史条目来源（HistoryEntry.Source）：osc = shell integration 精确域（OSC 133
// E/D 事件，命令+退出码+时长全量可信）；input = 输入域（远程控制台等无 OSC 133
// 标记的流，前端 onData 收口行缓冲截获的「提交的输入行」——补全由远端展开，记录
// 的是补全前字面形态，无退出码/时长）。零值空串 = osc 缺省，旧条目零迁移向后兼容
const HistorySourceInput = "input"

// HistoryEntry 单条终端命令历史
type HistoryEntry struct {
	Command    string    `json:"command"`
	ExitCode   int       `json:"exitCode"`
	DurationMs int64     `json:"durationMs"`
	At         time.Time `json:"at"`
	// TerminalID 归属终端会话（CC_TERMINAL_ID 同源，P-20261004-35）：回答
	// 「这个会话跑了哪些命令」。omitempty 保证旧条目（无归属）JSON 形态不变，
	// 旧数据零迁移向后兼容——空值即「未归属」组
	TerminalID string `json:"terminalId,omitempty"`
	// Source 条目来源（P-20261005-188）：空 = osc 精确域（缺省）；input = 输入域
	// 「提交的输入行」（无 exitCode/时长数据，消费面显示「—」）。omitempty 同上
	Source string `json:"source,omitempty"`
	// Host 远程主机键（remote 条目附主机 id，P-20261005-188）：与本地命令同项目
	// 文档共存，消费面按此渲染主机徽标；空 = 本地。omitempty 同上
	Host string `json:"host,omitempty"`
}

// ProjectHistoryHit 跨项目聚合检索的单条命中（P-20261004-2）：项目归属 + 命令
// 条目最小面（不含 durationMs——全局检索关心「在哪、跑了什么、成没成」，耗时
// 属单项目面板的排障细节）
type ProjectHistoryHit struct {
	ProjectID string    `json:"projectId"`
	Command   string    `json:"command"`
	ExitCode  int       `json:"exitCode"`
	At        time.Time `json:"ts"`
	// Source/Host 来源与主机键透传（P-20261005-188）：输入域命中带主机徽标渲染面，
	// 空值 = 本地 osc 条目（旧文档零迁移）
	Source string `json:"source,omitempty"`
	Host   string `json:"host,omitempty"`
}

// TerminalHistoryStore 终端命令历史（按项目隔离，doc key=projectID）
type TerminalHistoryStore interface {
	// Append 追加一条（敏感命令静默跳过；超出上限丢最旧）
	Append(projectID string, entry HistoryEntry) error
	// Search 查询（倒序最新在前）；q 为包含匹配，failedOnly 过滤 exitCode!=0，
	// terminalID 非空时仅返回该会话条目（会话归属过滤，P-20261004-35；空 = 全部，
	// 「未归属」旧条目只在空值查询中出现）
	Search(projectID, q string, failedOnly bool, terminalID string) ([]HistoryEntry, error)
	// SearchAll 跨项目聚合查询（P-20261004-2 全局检索面）：全部项目的命令按
	// q 包含匹配（不区分大小写，q 空则不过滤），扁平返回、全局时间倒序、limit
	// 截断。projectIDs 非空时仅命中这些项目（handler 传存活项目集——过滤先于
	// 截断，孤儿文档不挤占 limit 名额）。调用方（API 层）负责 q 最短长度下限，
	// 防止宽泛词全量扫
	SearchAll(q string, limit int, projectIDs map[string]struct{}) ([]ProjectHistoryHit, error)
	// Clear 清空项目历史
	Clear(projectID string) error
	// DeleteEntry 按倒序下标删除单条（与 Search 返回顺序一致，idx 越界返回 ErrNotFound）
	DeleteEntry(projectID string, idx int) error
	// DeleteEntryAt 按条目时间戳身份删除单条（面板条目删除用）：at 为条目落盘
	// 时刻（JSON RFC3339Nano 往返精确，Equal 比较时刻而非时钟读数），命中第一个
	// Equal(at) 的条目，找不到返回 ErrNotFound。用身份而非下标——GET 快照与删除
	// 之间并发 Append 会在倒序列表头部插行、q/failedOnly 过滤让快照下标失义，
	// 两种位移都会让下标错删相邻条目；时间戳身份不受影响（P-20261003-63）
	DeleteEntryAt(projectID string, at time.Time) error
}

const (
	terminalHistoryKind = "terminal_history"
	// TerminalHistoryMax 每项目保留条数上限（LRU：超出丢最旧）
	TerminalHistoryMax = 500
	// duplicateWindow 双挂接/多标签重复上报的判定窗口：指纹相同且落在此窗口内
	// 的上报视为同一次执行的重复投递（实测重复投递间隔 ~4ms）
	duplicateWindow = 2 * time.Second
	// truncatedCmdMarkLen 命令长度达到该值视为被 shell 侧 8KB 截断（head -c 8192
	// 截断后长度为 8192，边界容差取 8190），落盘时追加 "..." 标记
	truncatedCmdMarkLen = 8190
	// TerminalHistorySearchDefaultLimit 跨项目检索缺省返回条数
	TerminalHistorySearchDefaultLimit = 50
	// TerminalHistorySearchMaxLimit 跨项目检索单次返回上限（防御性封顶：
	// 响应体量与浮层渲染条数都不随调用方传入值失控）
	TerminalHistorySearchMaxLimit = 200
)

type terminalHistoryRepo struct {
	// filestore 锁是 kind 级，Get→append→Update 读改写必须 repo 内互斥，
	// 否则并发 Append 会互相覆盖丢条目
	mu  sync.Mutex
	doc DocumentStore
}

func newTerminalHistoryRepo(doc DocumentStore) *terminalHistoryRepo {
	return &terminalHistoryRepo{doc: doc}
}

// load 读取项目历史，文档不存在或损坏时返回空切片
func (r *terminalHistoryRepo) load(projectID string) []HistoryEntry {
	data, err := r.doc.Get(terminalHistoryKind, projectID)
	if err != nil {
		return nil
	}
	var entries []HistoryEntry
	if json.Unmarshal(data, &entries) != nil {
		return nil
	}
	return entries
}

// save 写回项目历史（upsert）
func (r *terminalHistoryRepo) save(projectID string, entries []HistoryEntry) error {
	if entries == nil {
		entries = []HistoryEntry{}
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	return r.doc.Upsert(terminalHistoryKind, projectID, data)
}

// IsSensitiveCommand 判断命令文本是否命中敏感模式（导出供 API 层日志/测试使用）：
// 通用词表 sensitiveCmdRe 之外并入自定义敏感模式（P-20261006-11，mask 包注册表
// ——设置写路径/启动期注入，空列表零变化），命中同样整条跳过
func IsSensitiveCommand(cmd string) bool {
	return sensitiveCmdRe.MatchString(cmd) || mask.MatchCustom(cmd)
}

func (r *terminalHistoryRepo) Append(projectID string, entry HistoryEntry) error {
	if projectID == "" {
		return ErrInvalidArg
	}
	// 敏感命令整条跳过（静默成功：调用方 fire-and-forget，无需感知）。经
	// IsSensitiveCommand 判定（通用词表 + 自定义模式，与 API 层共用单点）
	if IsSensitiveCommand(entry.Command) {
		return nil
	}
	// 命令长度触及 shell 侧 8KB 截断上限（≥8190 视为已截断）时追加省略号标记，
	// 防止残缺命令被用户从历史误复制重跑
	if len(entry.Command) >= truncatedCmdMarkLen {
		entry.Command += "..."
	}
	if entry.At.IsZero() {
		entry.At = time.Now()
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	entries := r.load(projectID)

	// 双挂接/多标签去重：同一会话被多个宿主渲染（或多个标签页各自附着）时，
	// 同一 D 事件会经每条附着 WS 各上报一次（实测间隔 ~4ms、durationMs 逐毫秒
	// 一致）。命令+退出码+时长+来源+主机 指纹相同且落在 2s 窗口内的上报视为
	// 同一次执行的重复投递，幂等跳过；真实重复执行的 durationMs 几乎不可能逐
	// 毫秒一致，误伤可忽略。Source/Host 必须入指纹：输入域条目 exitCode/durationMs
	// 恒 0，多主机并行运维（两个远程 pane 先后提交同命令）会被 0/0 指纹撞上
	// ——按主机隔离才不误判为重复投递
	for i := len(entries) - 1; i >= 0; i-- {
		prev := entries[i]
		if entry.At.Sub(prev.At) > duplicateWindow {
			break
		}
		if prev.Command == entry.Command && prev.ExitCode == entry.ExitCode && prev.DurationMs == entry.DurationMs && prev.Source == entry.Source && prev.Host == entry.Host {
			return nil
		}
	}

	entries = append(entries, entry)
	if len(entries) > TerminalHistoryMax {
		entries = entries[len(entries)-TerminalHistoryMax:]
	}
	return r.save(projectID, entries)
}

func (r *terminalHistoryRepo) Search(projectID, q string, failedOnly bool, terminalID string) ([]HistoryEntry, error) {
	if projectID == "" {
		return nil, ErrInvalidArg
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	entries := r.load(projectID)
	q = strings.ToLower(strings.TrimSpace(q))
	terminalID = strings.TrimSpace(terminalID)
	out := make([]HistoryEntry, 0, len(entries))
	// 倒序遍历：最新在前
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if failedOnly && e.ExitCode == 0 {
			continue
		}
		if terminalID != "" && e.TerminalID != terminalID {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(e.Command), q) {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// SearchAll 跨项目聚合查询：逐项目文档独立加载（峰值内存 = 单项目文档 + 命中
// 集合，不一次性展开全量），q 包含匹配不区分大小写，全局按时间倒序后截断 limit。
// projectIDs 非空时按 doc key（项目 ID）前置过滤——截断在过滤之后，limit 语义
// 是「返回条数」而非「扫描条数」；q 由 API 层保证 ≥2 字符，此处空 q 只是有界
// 的最新 N 条（防御性调用方兜底）
func (r *terminalHistoryRepo) SearchAll(q string, limit int, projectIDs map[string]struct{}) ([]ProjectHistoryHit, error) {
	if limit <= 0 {
		limit = TerminalHistorySearchDefaultLimit
	}
	if limit > TerminalHistorySearchMaxLimit {
		limit = TerminalHistorySearchMaxLimit
	}
	q = strings.ToLower(strings.TrimSpace(q))

	r.mu.Lock()
	defer r.mu.Unlock()
	keys, _, err := r.doc.List(terminalHistoryKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	hits := make([]ProjectHistoryHit, 0, 64)
	for _, key := range keys {
		if len(projectIDs) > 0 {
			if _, ok := projectIDs[key]; !ok {
				continue
			}
		}
		// load 为无锁内部方法，此处持 repo 锁调用与既有 Search 同语义
		for _, e := range r.load(key) {
			if q != "" && !strings.Contains(strings.ToLower(e.Command), q) {
				continue
			}
			hits = append(hits, ProjectHistoryHit{ProjectID: key, Command: e.Command, ExitCode: e.ExitCode, At: e.At, Source: e.Source, Host: e.Host})
		}
	}
	// 全局时间倒序（最新在前）——多项目混排时「上次那条命令」总是列表头部
	sort.Slice(hits, func(i, j int) bool { return hits[i].At.After(hits[j].At) })
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

func (r *terminalHistoryRepo) Clear(projectID string) error {
	if projectID == "" {
		return ErrInvalidArg
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if has, _ := r.doc.Has(terminalHistoryKind, projectID); !has {
		return nil // 无历史时清空为幂等成功
	}
	return r.doc.Delete(terminalHistoryKind, projectID)
}

func (r *terminalHistoryRepo) DeleteEntry(projectID string, idx int) error {
	if projectID == "" {
		return ErrInvalidArg
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	entries := r.load(projectID)
	// idx 为倒序下标（与 Search 返回一致），转换为正序下标
	pos := len(entries) - 1 - idx
	if pos < 0 || pos >= len(entries) {
		return ErrNotFound
	}
	entries = append(entries[:pos], entries[pos+1:]...)
	return r.save(projectID, entries)
}

func (r *terminalHistoryRepo) DeleteEntryAt(projectID string, at time.Time) error {
	if projectID == "" || at.IsZero() {
		return ErrInvalidArg
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	entries := r.load(projectID)
	for i := range entries {
		if entries[i].At.Equal(at) {
			entries = append(entries[:i], entries[i+1:]...)
			return r.save(projectID, entries)
		}
	}
	return ErrNotFound
}
