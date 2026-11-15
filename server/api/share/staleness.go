package shareapi

// 快照陈旧状态中枢（P-20261114-3-S2，双档判定收口）：
//
//   - **加速器**：订阅内核总线 file.changed（watch 模块按项目根递归注册，
//     总线订阅可行——module.go 双通道发布），载荷 path 对分享根做前缀过滤，
//     命中即置位 staleAt（秒级可见，无需等下次列表惰性对比）。**降级档不参与
//     置位**：inotify ENOSPC→轮询的广播 path 恒为项目根（watch/degraded.go
//     pollOnce）且不带 op——逐文件语义丢失，前缀过滤失效，若照单全收会把该
//     项目下全部分享误标陈旧；此处按「payload 无 op / path 等于项目根」双守卫
//     整条跳过，降级窗口的变更靠主档兜底。
//   - **主档调度**：列表/投影请求（shareResponse → verdict）惰性对比源根
//     当前 mtime 聚合 vs 记录内基准（share.SourceChanged，正确性主档在
//     server/share/staleness.go），覆盖重启丢事件与降级窗口。刻意不设节流：
//     「改源后立即打开管理面」必须在当次列表就出徽标（节流窗会吞掉这类
//     判定 = 假新鲜），而 WalkDir 成本受条目预算封顶（4000）且与列表既有
//     的 SnapshotUsage 逐树统计同量级；置位后走快路不再重扫，只有未陈旧
//     行重复对比（真实源未变是常态，重复对比结果恒 false）。
//
// 状态全部进程内存态（与持权/馈线同族）：重启即空 → 首次列表惰性对比重建
// 「重启丢事件」的真相，无需持久化。记录消亡（撤销/轮换/过期清账/级联）经
// Forget/Move/Prune 摘除标记与索引项，防死 token 标记无界累积。

import (
	"encoding/json"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/share"
	"codecombo/server/store"
)

// staleIndexTTL 事件过滤索引的重建周期：分享记录低频变更，TTL 重建即可跟上；
// 变更钩子（Bump）即刻失效重建，新分享的加速器盲窗趋近于零
const staleIndexTTL = 10 * time.Second

// staleRootIndex 事件前缀过滤索引项（frozen file 分享 × 每个分享根一条）：
// root 为项目根 + 分享根拼出的绝对路径（slash 归一，watch 事件路径同形对齐）。
// 刻意不按 Envelope.ProjectID 过滤：嵌套项目（findProjectIDFast 最长前缀语义）
// 下两项目共享物理子树，A 项目的事件落在 B 的分享根内同样要置位——物理路径
// 前缀匹配才是与内容源一致的判据
type staleRootIndex struct {
	token    string // 宿主分享 token（命中置位的键）
	root     string // 分享根绝对路径（slash 归一）
	projRoot string // 项目根绝对路径（slash 归一，降级守卫②的对照基准）
}

// staleHub 陈旧状态中枢（Module Start 构造接线，Stop 摘除；nil = 未装配，
// 投影与钩子全部静默降级——测试/降级部署零 panic）
type staleHub struct {
	st      *store.Store
	mu      sync.Mutex
	stale   map[string]time.Time // token → 陈旧认定时点（加速器/主档共用置位面）
	roots   []staleRootIndex     // 事件前缀过滤索引（惰性构建）
	rootsAt time.Time            // 索引构建时刻（TTL 重建 + Bump 失效）
	now     func() time.Time     // 单测缝（缺省 time.Now）
}

func newStaleHub(st *store.Store) *staleHub {
	return &staleHub{
		st:    st,
		stale: make(map[string]time.Time),
		now:   time.Now,
	}
}

// staleHubSvc 装配引用（shareSvc/liveWire 同款包级注入契约：Start 装配、
// Stop 摘除，防停机后管理端点命中旧实例）
var staleHubSvc *staleHub

func setStaleHub(h *staleHub) { staleHubSvc = h }

// staleVerdict 投影入口（shareResponse 调用；nil hub 静默降级）
func staleVerdict(s store.Share) (time.Time, bool) {
	if staleHubSvc == nil {
		return time.Time{}, false
	}
	return staleHubSvc.verdict(s)
}

// staleRels 记录的分享根集合（单路径含项目根空串；批量 = 规范化选择集）
func staleRels(s *store.Share) []string {
	if len(s.Paths) > 0 {
		return s.Paths
	}
	return []string{s.Path}
}

// verdict 陈旧判定两段：置位快路（加速器/既往判定）→ 主档惰性对比。
// 返回 (staleAt, stale)；判定不出来的形态（live/无基准/项目不可达/超预算）
// 一律不置位不误报——陈旧徽标是提示性面，漏报可由加速器或下次对比兜底，
// 误报则直接误导撤销/刷新决策（宁缺勿错）
func (h *staleHub) verdict(s store.Share) (time.Time, bool) {
	kind := s.Kind
	if kind == "" {
		kind = store.ShareKindFile // 存量记录零迁移语义
	}
	if kind != store.ShareKindFile || !s.Frozen || !share.HasStaleBaseline(s.SourceMtimes) {
		return time.Time{}, false
	}
	now := h.now()
	if s.Expired(now) {
		return time.Time{}, false // 过期行访客面已死，陈旧徽标是噪音
	}
	h.mu.Lock()
	if at, ok := h.stale[s.Token]; ok {
		h.mu.Unlock()
		return at, true // 快路：置位带记忆，重复列表零 WalkDir
	}
	h.mu.Unlock()
	root, ok := h.projectRoot(s.ProjectID)
	if !ok {
		return time.Time{}, false
	}
	changed, decided := share.SourceChanged(root, staleRels(&s), s.SourceMtimes)
	if decided && changed {
		h.mu.Lock()
		at := h.markLocked(s.Token, now)
		h.mu.Unlock()
		return at, true
	}
	return time.Time{}, false
}

// onFileChanged 内核总线 file.changed 订阅回调（Module Start 接线）：
// 降级双守卫 → 前缀过滤 → 命中置位。热路径量级：构建风暴下每事件一次
// 锁 + O(索引) 字符串前缀比较（索引条目 = frozen 分享根数，个位数到十位数），
// 索引重建受 TTL/Bump 双闸（至多每 10s 一次 List 读盘）
func (h *staleHub) onFileChanged(env projectEvent) {
	var p struct {
		Path string `json:"path"`
		Op   string `json:"op"`
	}
	if b, err := json.Marshal(env.Payload); err != nil || json.Unmarshal(b, &p) != nil || p.Path == "" {
		return
	}
	// 降级守卫①：无 op 的广播（降级轮询指纹逐项目至多一条，watch/degraded.go
	// 刻意省略 op——「根下有变化」不可归因到文件）整条跳过，防误标全部分享
	if p.Op == "" {
		return
	}
	eventPath := filepath.ToSlash(filepath.Clean(p.Path))
	h.mu.Lock()
	roots, fresh := h.rootsForLocked()
	h.mu.Unlock()
	if !fresh {
		return // 索引构建失败（List 读盘错误）：本轮不置位，下个事件重试
	}
	for i := range roots {
		// 降级守卫②：path 等于项目根（降级广播形态；正常 fsnotify 对根目录
		// 本身只有 chmod 类非内容事件）——根级信号不可归因，跳过靠主档
		if eventPath == roots[i].projRoot {
			return
		}
	}
	now := h.now()
	for i := range roots {
		r := roots[i].root
		if !strings.HasPrefix(eventPath, r) || (len(eventPath) > len(r) && eventPath[len(r)] != '/') {
			continue
		}
		h.mu.Lock()
		at := h.markLocked(roots[i].token, now)
		h.mu.Unlock()
		slog.Debug("share stale marked by file event", "token", share.TokenSummary(roots[i].token),
			"path", p.Path, "staleAt", at.Format(time.RFC3339))
	}
}

// projectEvent 内核总线回调的裁剪面（Module 侧从 Envelope 取 Payload 传入，
// 本包不 import kernel 的载荷类型——测试可直接构造。Envelope.ProjectID 刻意
// 不取：置位判据是物理路径前缀（见 staleRootIndex 注），按事件归属项目过滤
// 反而漏掉嵌套项目的合法置位）
type projectEvent struct {
	Payload any
}

// markLocked 置位（first-writer-wins：并发事件/对比同 token 只锚最早时点；
// 调用方须持 h.mu）
func (h *staleHub) markLocked(token string, at time.Time) time.Time {
	if existing, ok := h.stale[token]; ok {
		return existing
	}
	h.stale[token] = at
	return at
}

// rootsForLocked 事件过滤索引（调用方须持 h.mu）：TTL 过期或从未构建时重建；
// 构建失败保持旧索引并返回 fresh=false（宁可漏一次事件置位——主档兜底——
// 也不带残缺索引回答）
func (h *staleHub) rootsForLocked() ([]staleRootIndex, bool) {
	now := h.now()
	if h.roots != nil && now.Sub(h.rootsAt) < staleIndexTTL {
		return h.roots, true
	}
	shares, err := h.st.Share.List()
	if err != nil {
		return h.roots, false
	}
	projRoots := make(map[string]string)
	idx := make([]staleRootIndex, 0, len(shares))
	for i := range shares {
		s := &shares[i]
		kind := s.Kind
		if kind == "" {
			kind = store.ShareKindFile
		}
		if kind != store.ShareKindFile || !s.Frozen || !share.HasStaleBaseline(s.SourceMtimes) || s.ProjectID == "" {
			continue // 只索引「有基准的 frozen file 分享」——投影闸同口径，置位才有消费方
		}
		root, ok := projRoots[s.ProjectID]
		if !ok {
			p, err := h.st.Project.GetByID(s.ProjectID)
			if err != nil || p.Path == "" {
				projRoots[s.ProjectID] = ""
				continue
			}
			root = p.Path
			projRoots[s.ProjectID] = root
		}
		if root == "" {
			continue
		}
		for _, rel := range staleRels(s) {
			abs := root
			if rel != "" {
				abs = filepath.Join(root, filepath.FromSlash(rel))
			}
			idx = append(idx, staleRootIndex{
				token:    s.Token,
				root:     filepath.ToSlash(filepath.Clean(abs)),
				projRoot: filepath.ToSlash(filepath.Clean(root)),
			})
		}
	}
	h.roots = idx
	h.rootsAt = now
	return idx, true
}

// projectRoot 主档对比的项目根解析（GetByID 为内存配置读，节流窗后每次对比
// 一次；项目不存在/无路径 → unknown 不置位）
func (h *staleHub) projectRoot(projectID string) (string, bool) {
	if projectID == "" {
		return "", false
	}
	p, err := h.st.Project.GetByID(projectID)
	if err != nil || p.Path == "" {
		return "", false
	}
	return p.Path, true
}

// Reset 基准复位（原地刷新/重发携新采样落库后调用）：清陈旧标记——复位
// 瞬间基准定义上就是当前源，随后投影路径的对比恒 false（响应不带 staleAt，
// 徽标即时消失）；索引即刻失效（token 键不变，重建成本一次 List）
func (h *staleHub) Reset(token string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.stale, token)
	h.rootsAt = time.Time{}
}

// Move 轮换迁键（Rotate 换短链不改内容）：陈旧认定随记录走新 token，旧
// token 键摘除——轮换不重置陈旧语义（换的是链不是内容），徽标不闪断
func (h *staleHub) Move(oldToken, newToken string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if at, ok := h.stale[oldToken]; ok {
		if _, exists := h.stale[newToken]; !exists {
			h.stale[newToken] = at
		}
		delete(h.stale, oldToken)
	}
	h.rootsAt = time.Time{}
}

// Forget 记录消亡摘除（撤销面调用；过期清账/级联走 Prune keep 集）
func (h *staleHub) Forget(token string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.stale, token)
	h.rootsAt = time.Time{}
}

// Prune 存活集对账摘除（过期清理巡检同族钩子：CascadeRelease/Prune 同点位）：
// keep = 存活 token 集，集外标记/索引项全部摘除，防死 token 无界累积
func (h *staleHub) Prune(keep map[string]bool) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for token := range h.stale {
		if !keep[token] {
			delete(h.stale, token)
		}
	}
	h.rootsAt = time.Time{}
}

// Bump 变更钩子（创建/刷新/撤销/轮换后调用）：索引即刻失效，新分享的加速器
// 盲窗从 TTL 上限收敛到「下一个事件」
func (h *staleHub) Bump() {
	if h == nil {
		return
	}
	h.mu.Lock()
	h.rootsAt = time.Time{}
	h.mu.Unlock()
}
