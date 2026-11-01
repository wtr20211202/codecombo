package report

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"codecombo/server/kernel"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// Module 今日日报模块（P-20261001-30）：每日 ReportHour 点为每个项目聚合
// 当日事实并入通知中心（P-20261003-4 起同步落 14 天存档，回看口见
// store.DailyReport 与 /api/reports/daily）。内核调度器为间隔制（无 cron 表达
// 能力），以分钟级巡检 + 当日已发标记实现「每日一次、到点即发」——服务晚于
// ReportHour 启动（或 21 点前后重启）同样能补发当日日报
type Module struct {
	k kernel.Kernel

	// emitFn 投递口：默认 Emit；单测替换以捕获投递（tick 的门槛/去重/清理
	// 逻辑与聚合逻辑解耦验证）
	emitFn func(now time.Time, l Loaders, add func(notification.Notification), archive func(store.DailyReport) error) int

	mu        sync.Mutex
	checkedOn string // 最近一次巡检处理（发出或判定无需再发）的日期 YYYY-MM-DD
}

func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "report" }
func (m *Module) DependsOn() []string { return nil }

// Init 记录内核引用（无装配期工作：数据面全部取自全局 store）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	return nil
}

// Start 注册分钟级巡检（聚合走 git 子进程与全量存储读，放在 scheduler
// 专属 goroutine 串行执行，不与请求路径争抢）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	m.k = k
	if !k.Scheduler().AddTicker("daily-report", time.Minute, func(context.Context) {
		m.tick(time.Now())
	}) {
		return errors.New("report: daily-report ticker already registered")
	}
	return nil
}

func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	m.checkedOn = ""
	return nil
}

// tick 到点巡检：过了 ReportHour 且今天还没处理过，就聚合发一轮。
// checkedOn 在聚合前置位（而非成功后）：聚合中途进程退出不至下一分钟
// 立刻重试堆积；当日事实次日仍可从各数据面回看
func (m *Module) tick(now time.Time) {
	if now.Hour() < ReportHour {
		return
	}
	today := now.Format("2006-01-02")
	m.mu.Lock()
	if m.checkedOn == today {
		m.mu.Unlock()
		return
	}
	m.checkedOn = today
	m.mu.Unlock()

	s := store.Get()
	if s == nil {
		return
	}
	// 存档滚动清理（P-20261003-4，幂等）：随当日首次巡检执行，放在重发去重
	// 扫描之前——21 点后重启的补发场景（扫描命中即 return）同样保证清理不缺勤。
	// 键前缀即日期，清理零读值成本。活动序列（P-20261003-37）同点位同款裁剪
	if _, err := s.DailyReport.CleanupBefore(now.Add(-store.DailyReportRetention)); err != nil {
		slog.Warn("daily report archive cleanup failed", "err", err)
	}
	if _, err := s.ActivityDay.CleanupBefore(now.Add(-store.ActivityDayRetention)); err != nil {
		slog.Warn("activity series cleanup failed", "err", err)
	}
	// 跨重启去重：checkedOn 是内存标记，21 点后重启会丢失——当日日报已在
	// 通知中心则不再重发。List 有 3s TTL 读缓存且封顶 200 条，扫描零负担
	start, end := dayWindow(now)
	for _, n := range s.Notification.List(0) {
		if n.TitleKey == DailyTitleKey && inWindow(n.Time, start, end) {
			return
		}
	}
	emit := m.emitFn
	if emit == nil {
		emit = Emit
	}
	// 落档口与投递口同批注入：先档后投由 Emit 内保证（见 Emit 注释）。
	// 活动累计器随落档口顺带收集（P-20261003-37），收尾一次落行
	accum := newActivityAccum(now)
	archive := func(r store.DailyReport) error {
		accum.add(r)
		return s.DailyReport.Save(r)
	}
	if n := emit(now, FromStore(), s.Notification.Add, archive); n > 0 {
		slog.Info("daily report sent", "projects", n)
	}
	saveActivityRow(accum)
}

// RunDaily 手动生成一轮日报（P-20261003-4 触发口，POST /api/reports/daily/run）：
//   - day 为零值或今天：立即投递通知并落档，与 21 点巡检同链路；绕过到点
//     门槛与当日去重（显式触发即用户意图，重复触发按 upsert 覆盖同键），
//     当晚巡检经通知扫描看到已发即不再重发
//   - day 为历史日：只补档不投递（存档是回看数据面，往日日报不在今天的
//     通知流里复活；实例级审批/部署事实按该日窗口重聚合）
//
// 返回处理的项目数（零事件项目照例跳过）。服务未装配 store 时不动作
func RunDaily(day time.Time) int {
	s := store.Get()
	if s == nil {
		return 0
	}
	today := time.Now()
	now := today
	notify := s.Notification.Add
	if !day.IsZero() {
		y, m, d := day.Date()
		now = time.Date(y, m, d, ReportHour, 0, 0, 0, day.Location())
		if now.Format(archiveDateFormat) != today.Format(archiveDateFormat) {
			notify = nil // 补历史档：只写存档不投递
		}
	}
	accum := newActivityAccum(now)
	n := Emit(now, FromStore(), notify, func(r store.DailyReport) error {
		accum.add(r)
		return s.DailyReport.Save(r)
	})
	saveActivityRow(accum)
	return n
}

// ── 实例活动序列挂点（P-20261003-37）──
//
// 热力图数据面是日报存档的旁路投影：随落档口顺带把各项目聚合数累计成实例级
// 单日行，收尾一次 upsert 进 activityday kind。放 module 侧而非 Emit 主链——
// 日报聚合/投递/落档语义零改动；写失败仅记日志（与存档落档同款尽力而为）。

// activityAccum 单轮发报的实例级活动累计器。单轮 Emit（或 RunDaily）只处理
// 一个自然日，日期在构造期即定，add 无条件累加（同轮各项目记录天然同日）
type activityAccum struct {
	row store.ActivityDay
}

// newActivityAccum 构造累计器，日期与存档同源（now 所在自然日、服务器本地
// 时区——与 ArchiveOf 的 Date 派生一致，跨日零点边界两处判定天然一致）
func newActivityAccum(now time.Time) activityAccum {
	return activityAccum{row: store.ActivityDay{Date: now.Format(archiveDateFormat)}}
}

// add 累计一份项目存档的三项数值（与存档字段同名同源，零二次采集）
func (a *activityAccum) add(r store.DailyReport) {
	a.row.Commits += r.Commits
	a.row.Sessions += r.ClaudeSessions
	a.row.Commands += r.TerminalCmds
}

// saveActivityRow 发报收尾落活动序列行：零活动日跳过（热力图缺行即空档，
// 与「零事件不发日报」同语义）；失败不阻断——日报主链已收尾，此处只投影
func saveActivityRow(a activityAccum) {
	if a.row.Date == "" || (a.row.Commits == 0 && a.row.Sessions == 0 && a.row.Commands == 0) {
		return
	}
	s := store.Get()
	if s == nil {
		return
	}
	if err := s.ActivityDay.Save(a.row); err != nil {
		slog.Warn("activity series append failed", "date", a.row.Date, "err", err)
	}
}
