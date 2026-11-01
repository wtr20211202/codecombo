package share

// 退役短链外泄观测（P-20261008-2）：Rotate 换链后旧 token 对访客面已死
// （404 与「从未存在」同观感——存在性信号无从探测，errShareNotFound 的
// 既有语义），但「死链仍被踩」正是发链接的人撤销/轮换时最想知道的答案：
// 链接确实在被继续访问 = 零误报的外泄确认（区别于未知 token 漫扫的高误报
// 面——后者是另一个话题，本观测只认「曾在台账中的 token」）。
//
// 命中钩子挂在 lookup 的未命中分支（token 解析层的映射查询点）：Get 失败
// 后经 store 的退役反向索引反查宿主（O(1)，未命中一次 map 读——扫描探测
// 不存在 token 的请求绝不被放大成全表读，见 store.FindRetired）。命中后：
//   - 计数：内存攒批（RetiredHitTracker），装配层随既有 3s flush 批量
//     RecordRetiredHit 落盘——访客响应路径零磁盘 I/O，hits.go 同款大前提；
//   - 留痕：每命中攒一条 share.retiredHit 审计事件（ViewAuditBuffer 复用，
//     P-257 同款两段式；Detail 含展示名/退役 token/累计命中/UA/IP）；
//   - 告警：通知中心 warning——首次命中即发、此后每 10 次汇总一条
//     （同链接反复扫时防轰炸；节拍状态内存持有，重启后重新首报与「首次
//     命中即发」语义一致）。
//
// 响应语义零变化：命中退役 token 的访客响应仍是原有 404（不改变静默撤销
// 的对下面孔，只补主人侧观测）。撤销（Delete）的记录随台账消亡——本观测
// 的载体是存活的 Share 记录，覆盖 rotate 链（泄露应对的主动作：发现泄露
// 先轮换，记录存活即持续观测）。

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// retiredNotifyEvery 通知去抖步长：首次命中即发，此后每累计该数次汇总一条
// （1、11、21……）。死链被反复踩时告警值得升级但不必逐条轰炸——通知中心
// 的一条 warning + 管理徽标的持续计数已足够响应
const retiredNotifyEvery = 10

// retiredLookup 退役短链反查的 optional 面（store.ShareStore 的子集）：
// 生产装配（shareapi.shareLookup→store.ShareStore）恒有该能力，测试桩未
// 实现时跳过观测（MarkFirstView 的 optional interface 断言同款先例）
type retiredLookup interface {
	FindRetired(retiredToken string) (*store.Share, bool)
}

// RetiredHitTracker 退役命中聚合器（Service 持有；零值可用——nil 接收者
// 各方法安全直通）。counts 是本次运行累计（通知节拍的判定基线，不随冲刷
// 清零）；pending 是未落盘增量（Flush 取走即清，失败不回灌——RecordHits
// 同一取舍：观测是尽力而为的旁路指标，存储故障时不回灌无界增长）
type RetiredHitTracker struct {
	mu      sync.Mutex
	counts  map[string]int64
	pending map[string]int64
}

// Note 记一次退役命中（访客响应路径内调用，只动内存），返回累计命中数与
// 本条是否触发通知（counts==1 首发之后每 retiredNotifyEvery 次一发）
func (t *RetiredHitTracker) Note(token string) (total int64, notify bool) {
	if t == nil || token == "" {
		return 0, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.counts == nil {
		t.counts = make(map[string]int64)
		t.pending = make(map[string]int64)
	}
	t.counts[token]++
	t.pending[token]++
	total = t.counts[token]
	return total, total == 1 || total%retiredNotifyEvery == 1
}

// FlushPending 取走未落盘的命中增量（装配层冲刷调用）。返回 map 可能共享
// 内部结构的拷贝语义由调用方只读使用保证——取走即换新 map，原状态不受
// 后续 Note 影响
func (t *RetiredHitTracker) FlushPending() map[string]int64 {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.pending) == 0 {
		return nil
	}
	out := t.pending
	t.pending = make(map[string]int64)
	return out
}

// noteRetiredHit 退役命中的观测入口（lookup 未命中分支调用）：反查宿主、
// 攒审计事件、判定通知节拍。HEAD 一律不计（P-14 口径：探测不是「被看」，
// 预览抓取对死链的 HEAD 不制造外泄告警噪声）；未装配反查能力或非退役
// token 时零副作用直通
func (s *Service) noteRetiredHit(r *http.Request, token string) {
	if r.Method == http.MethodHead {
		return
	}
	lk, ok := s.shares.(retiredLookup)
	if !ok {
		return
	}
	host, hit := lk.FindRetired(token)
	if !hit {
		return
	}
	total, notify := s.retired.Note(token)
	// 审计留痕（P-257 形态同款）：每次命中一条事件攒入既有缓冲（封顶逐出
	// 最旧，扫描风暴下有界），装配层随 3s flush 批量入账。Detail 含展示名
	// 与退役 token 保指认能力——审计台账是本地持久化对账凭证而非外发工件
	//（share.view/rotate 记完整 token 同先例，P-20261002-95 的脱敏界只收口
	// slog 与 gin 日志）
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareRetiredHit,
		Result: store.AuditResultSuccess,
		Time:   time.Now(),
		IP:     clientIPOf(r),
		Detail: fmt.Sprintf("%s (retired %s), hits: %d, ua: %s", host.Name, token, total, uaBrief(r.UserAgent())),
	})
	if notify {
		s.notes.Add(retiredAlert(host, token, total))
	}
}

// retiredAlert 构造外泄告警通知（主人侧回流事件的入账形态，guestNote 同款
// 惯例）：warning 形态 + 模板键供前端按界面语言渲染，Title/Body 中文原文
// 兜底无模板消费方（API 直读/webhook）；Action=panel:share-manager 点开即
// 分享管理器（退役徽标所在，可直接对账）
func retiredAlert(host *store.Share, retiredToken string, total int64) notification.Notification {
	return notification.Notification{
		Type:     "warning",
		Category: notification.CategorySystem,
		// 模板参数带退役 token 尾号（TokenSummary 同源形态）：同一分享多条
		// 退役链时能分辨是哪一代被踩；完整 token 在审计台账对账（通知摘要
		// 不承载对账职责，短摘要防面板溢出）
		TitleKey:      "share.retired.notify.title",
		BodyKey:       "share.retired.notify.body",
		Title:         "已作废的分享链接仍被访问",
		Body:          "「" + host.Name + "」的旧链接（…" + TokenSummary(retiredToken) + "）仍被访问（累计 " + fmt.Sprintf("%d", total) + " 次），可能已外泄",
		Time:          time.Now(),
		MsgParams:     map[string]any{"name": host.Name, "tail": TokenSummary(retiredToken), "n": total},
		Action:        "panel",
		ActionPayload: "share-manager",
	}
}

// FlushRetiredHits 把攒下的退役命中批量落盘（apply = store.Share.
// RecordRetiredHit，装配层注入——本包不反向依赖管理面，FlushHits 同款接口
// 注入先例）。宿主记录已撤销/过期（ErrNotFound）→ 静默丢弃该条：观测随
// 宿主消亡，不回灌（存储持续故障时回灌会让内存无界增长）。at 统一取冲刷
// 时点（RecordHits 同款批量语义——条内已无逐次时点，LastHitAt 精度=冲刷
// 周期，对「最近命中」的判读足够）。apply 为 nil 时直接清空（测试/关停）
func (s *Service) FlushRetiredHits(apply func(retiredToken string, n int64, at time.Time) error) int {
	batch := s.retired.FlushPending()
	if len(batch) == 0 {
		return 0
	}
	now := time.Now()
	applied := 0
	for token, n := range batch {
		if apply == nil {
			continue
		}
		if err := apply(token, n, now); err != nil {
			// token 打摘要不打全值（P-20261002-95，FlushHits 同款日志纪律）
			s.logger.Warn("share retired hit flush skipped", "token", TokenSummary(token), "hits", n, "err", err)
			continue
		}
		applied += int(n)
	}
	return applied
}
