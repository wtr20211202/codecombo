package share

// 访客访问审计（P-20261003-257）：访问留痕补齐「谁何时看了哪个链接」的
// 审计链——计数（P-20261002-14）只回答「被看了几次」，审计回答「谁看的」。
//
// 写路径与 HitCounter 同一条两段式纪律（访客响应路径零磁盘 I/O 是大前提，
// 见 hits.go——首版同步写盘曾破坏访客响应面）：recordView 只在内存攒事件
// （纳秒级），装配层（shareapi Module）经同一 3s 调度器 tick 批量 Append
// 进审计台账 + Stop 兜底冲刷。攒批封顶逐出最旧（跨项目变更流环形缓冲同款
// 策略）——3s 窗口内的正常访问远达不到，封顶只为访客风暴时内存有界；逐出
// 是有损降级（丢弃计数留日志，与审计写失败可见性同哲学），绝不阻塞访客响应。
//
// 口径 = 计数同款（页面打开 + 下载启动；meta/list/render/raw 子资源取数
// 不留痕——一次浏览连发多个子请求，逐请求留痕会把审计台账刷成访客页面的
// 内部取数日志，失去「链接被谁看过」的判读价值）。一次性分享（P-20261020-3）
// 例外：只记显式确认（POST /s/{token}/view）——预览抓取 GET/HEAD 不产生
// 审计；HEAD 一律不留痕。未知/已过期短链不留痕：链接 id 以解析到的记录为准
//（Detail 含链接 id 是本条的对账判据），探测不存在 token 的扫描是另一个
// 话题，不混入「看过哪个链接」。

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"codecombo/server/store"
)

// viewAuditMaxPending 攒批上限：恶意风暴时的内存护栏。逐出最旧保最新
// （对账价值最高的近期访问），丢弃量在冲刷时留日志
const viewAuditMaxPending = 512

// viewUAMaxRunes UA 简要的 rune 截断宽度：主流浏览器 UA 在 100~200 字符，
// 160 保住「什么浏览器什么系统」的判读信息，Detail 不被长尾巴撑爆
const viewUAMaxRunes = 160

// ViewAuditBuffer 访客访问审计聚合器（Service 持有；零值可用——nil 接收者
// 各方法安全直通，测试/未装配场景零接线零 panic，HitCounter 同款）
type ViewAuditBuffer struct {
	mu      sync.Mutex
	pending []store.AuditEvent
	dropped int
}

// Add 记一次访客访问（访客响应路径内调用，只动内存）
func (v *ViewAuditBuffer) Add(e store.AuditEvent) {
	if v == nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.pending) >= viewAuditMaxPending {
		v.pending = v.pending[1:]
		v.dropped++
	}
	v.pending = append(v.pending, e)
}

// Drain 取走攒下的全部事件与逐出计数（冲刷与写入互斥；dropped 由冲刷方
// 留日志——有损降级必须可见）。取走即清，失败不回灌（与 HitCounter.Flush
// 同一取舍：审计 Append 尽力而为，回灌会在存储故障时无界增长）
func (v *ViewAuditBuffer) Drain() (events []store.AuditEvent, dropped int) {
	if v == nil {
		return nil, 0
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	out := v.pending
	dropped = v.dropped
	v.pending = nil
	v.dropped = 0
	return out, dropped
}

// uaBrief UA 简要（审计 Detail 用）：UA 是请求方自报的任意串——控制字符
// 折叠为空格（单行化，防审计面板/CSV/日志注入），rune 截断防 Detail 无界，
// 空值占位「-」（curl 等裸客户端不带 UA 是常态，留痕不出现空洞）
func uaBrief(ua string) string {
	ua = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, ua)
	ua = strings.TrimSpace(ua)
	if runes := []rune(ua); len(runes) > viewUAMaxRunes {
		ua = string(runes[:viewUAMaxRunes]) + "…"
	}
	if ua == "" {
		return "-"
	}
	return ua
}

// clientIPOf 访客来源 IP：优先取同源入口注入的上下文值（主应用已按
// server.trustedProxies 解析转发头，P-20261020-1/2）；独立端口直连时退回
// RemoteAddr 的 host 部分——访客子服务没有自己的代理信任配置面，盲信
// X-Forwarded-For 会把捏造 IP 写进审计台账（RemoteAddr 是直连形态唯一能
// 担保的来路事实；IPv6 带端口形态拆 host）。
func clientIPOf(r *http.Request) string {
	if ip, ok := clientIPFromContext(r.Context()); ok {
		return ip
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// recordView 构造访客访问审计事件攒入缓冲（handlePage/doDownload 在
// hits.Count 同点位调用——计数与留痕同口径，两处语义互为锚）
func (s *Service) recordView(r *http.Request, sh *store.Share) {
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareView,
		Result: store.AuditResultSuccess,
		Time:   time.Now(),
		IP:     clientIPOf(r),
		// Detail 含链接 id（token）保指认能力：审计台账是本地持久化对账
		// 凭证而非外发工件，完整 token 不脱敏（share.rotate 记完整新旧
		// token 同先例；P-20261002-95 的脱敏界只收口 slog 与 gin 日志）。
		// 展示名给人读，UA 简要让「谁」更具体
		Detail: fmt.Sprintf("%s (%s), ua: %s", sh.Name, sh.Token, uaBrief(r.UserAgent())),
	})
}

// FlushViewAudits 把攒下的访问审计批量入账（apply = store.AuditLogStore.Append，
// 装配层注入——本包不反向依赖管理面，ShareLookup/ProjectRoots 同款接口注入
// 先例）。Append 自身尽力而为（失败只计数不上抛，见 store/auditlog.go），
// 此处无额外失败语义。apply 为 nil 时直接清空（测试/关停场景）。
// 装配层定时调用 + Module.Stop 兜底各一次（与 FlushHits 同节奏同收口）
func (s *Service) FlushViewAudits(apply func(store.AuditEvent)) int {
	events, dropped := s.views.Drain()
	if dropped > 0 {
		s.logger.Warn("share view audit overflowed, oldest dropped", "dropped", dropped)
	}
	for _, e := range events {
		if apply == nil {
			continue
		}
		apply(e)
	}
	return len(events)
}
