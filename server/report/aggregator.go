// Package report 今日改动站内日报（P-20261001-30）：每日定时为每个项目聚合
// 当日事实（提交 / 审批 / 部署 / 智能体会话活跃度）并入通知中心。
//
// 全部只读聚合既有数据面（git log、审批与部署任务存储、terminal-history 与
// claudeindex 索引），无新采集；文案经 TitleKey/BodyKey + MsgParams 走前端
// i18n 模板（与部署日志 messageKey 同一惯例）。
//
// 模块装配见 module.go；本文件只承载纯聚合逻辑（数据源字段化注入，单测
// 以内存桩替换，不依赖全局 store）。
package report

import (
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/model"
	"codecombo/server/notification"
	"codecombo/server/store"
)

const (
	// commitScanLimit 单项目提交扫描上限：git log 按当日窗口 + 条数双界扫描，
	// 万级提交仓库不全量 walk（提案风险项）。当日提交按提交时间序必居日志
	// 最新段，50 条足够覆盖「计数 + 前 5 条摘要」
	commitScanLimit = 50

	// subjectLimit 日报正文附带的提交主题条数（前 N 条，新→旧）
	subjectLimit = 5

	// deployScanLimit 部署任务扫描上限：任务保留 30 天，ListRecent 按开始
	// 时间降序截断，最近 200 条覆盖单日绰绰有余（任务并发上限 3）
	deployScanLimit = 200

	// auditScanLimit 审计事件扫描上限（P-20261003-51）：审计写入人操作级低频
	// + 30 天保留，List 按时间倒序截断，当日事件必居最新段（同 commitScanLimit
	// 的双界思路）；量级余量覆盖「被刷密码」的极端日
	auditScanLimit = 500
)

// ReportHour 日报发送时刻（服务器本地时区的小时数）：21 点避开活跃时段，
// 此时当日事实基本定型
const ReportHour = 21

// gitDateFormat git --since/--until 接受的本地时间格式（时区按服务器本地，
// 提案约定）
const gitDateFormat = "2006-01-02 15:04:05"

// archiveDateFormat 日报存档的日期格式（存档键前缀与 Date 字段，服务器本地
// 时区——与聚合窗口同源，跨日零点边界两处判定天然一致）
const archiveDateFormat = "2006-01-02"

// DailyTitleKey 日报通知标题的 i18n key。独立常量供模块侧跨重启去重扫描
// （按 key 识别日报通知，与组装处共用同一字面量）
const DailyTitleKey = "report.daily.title"

// DailyBodySecKey 含安全事件行的日报正文模板 key（P-20261003-51）：当日有
// 审计事件时组装处选用，零事件沿用基础模板——「零事件整行省略」在模板键
// 选择处完成（Daily.Empty 同款防噪音思路），前端消费零改动
const DailyBodySecKey = "report.daily.bodySec"

// Daily 单项目当日聚合事实
type Daily struct {
	ProjectID   string
	ProjectName string

	Commits        int      // 当日提交数（commitScanLimit 内）
	CommitSubjects []string // 当日提交主题（前 subjectLimit 条，新→旧）
	ClaudeSessions int      // 当日活跃 claude 会话数（claudeindex 按 项目路径→工作目录 归属）
	ClaudeTokens   int64    // 当日窗口内 token 消耗（P-20261002-139，usage 行按自身时间归窗，会话跨天不串账）
	TerminalCmds   int      // 当日终端命令数（terminal-history）
}

// Empty 当日零事件（防噪音：这样的项目不发日报，提案约定）。审批/部署为
// 实例级事实不参与判定——项目自身无任何活动时，实例级数字随其他项目的
// 日报同样可达，单独为它发一条只会重复
func (d Daily) Empty() bool {
	return d.Commits == 0 && d.ClaudeSessions == 0 && d.TerminalCmds == 0
}

// Instance 实例级当日事实：审批与部署任务在数据模型上无项目归属（全局
// 资源），全实例聚合后随每份发出的日报附带
type Instance struct {
	ApprovalsPending int // 当前待审批（含往日未决——「进行中」是此刻状态）
	ApprovalsDone    int // 当日已裁决（allowed/denied）
	DeploysOK        int // 当日成功的部署任务
	DeploysFailed    int // 当日失败的部署任务

	// 安全事件（P-20261003-51）：审计台账（auditlog）当日计数，同为实例级
	// 事实。安全进入每日运营视野——异常解锁失败/令牌变更不必专门翻审计页
	SecEvents      int // 当日审计事件总数
	SecUnlockFail  int // 其中解锁失败（密码错/限流拒——结果非 success 的解锁）
	SecTokenChange int // 其中令牌变更（API/agent token 的签发/撤销/轮换）
}

// Loaders 聚合数据源。字段化注入：生产经 FromStore 装配（store 全局 +
// git/claudesessions 只读入口），单测以内存桩替换
type Loaders struct {
	Projects    func() ([]config.ProjectConfig, error)
	Commits     func(repoPath string, dayStart, dayEnd time.Time) ([]model.Commit, error)
	Approvals   func() ([]store.AgentApproval, error)
	DeployTasks func() ([]config.DeployTask, error)
	// ClaudeSessions 当日活跃会话（索引查询，零内容读）；ClaudeTokens 当日
	// token 消耗（P-20261002-139，逐窗内会话读 transcript 归窗累计——按天
	// 回溯必须逐行归窗，纯索引里的 Usage 是生命周期总量）
	ClaudeSessions  func(projectPath string) ([]store.ClaudeIndexEntry, error)
	ClaudeTokens    func(projectPath string, start, end time.Time) (int64, error)
	TerminalHistory func(projectID string) ([]store.HistoryEntry, error)
	// Audit 安全事件审计台账（P-20261003-51）：auditlog List 既有读取面，
	// 倒序截断后在聚合侧按当日窗口精确过滤
	Audit func() ([]store.AuditEvent, error)
}

// gitCommits 提交数据面：当日窗口传给 git 界定扫描范围（--since/--until），
// 聚合侧再按提交时间精确过滤（不依赖 git 的日期解析与时区语义）。
// 独立成函数供 FromStore 装配与单测共用（真实仓库聚合路径的一致性由单测锁定）
func gitCommits(repoPath string, dayStart, dayEnd time.Time) ([]model.Commit, error) {
	return git.GetLog(repoPath, "", commitScanLimit, 0, "",
		dayStart.Format(gitDateFormat), dayEnd.Format(gitDateFormat))
}

// FromStore 生产装配：全部数据面取自全局 store 与既有只读入口。
// 注意依赖调用方保证 store.Get() 非空（组合根在内核 StartAll 前装配）
func FromStore() Loaders {
	return Loaders{
		Projects:    func() ([]config.ProjectConfig, error) { return store.Get().Project.List() },
		Commits:     gitCommits,
		Approvals:   func() ([]store.AgentApproval, error) { return store.Get().AgentApproval.List("", 0) }, // 全量（按状态计数，不做过滤/截断）
		DeployTasks: func() ([]config.DeployTask, error) { return store.Get().DeployTask.ListRecent(deployScanLimit) },
		ClaudeSessions: func(projectPath string) ([]store.ClaudeIndexEntry, error) {
			root := claudesessions.Root()
			if root == "" {
				return nil, nil
			}
			// 项目级会话与列表 UI 同一归属键（root + 编码后项目路径前缀），
			// 纯索引查询不读会话文件
			batch, err := store.Get().ClaudeIndex.GetBatch(store.ClaudeIndexPrefix(root, claudesessions.EncodePath(projectPath)))
			if err != nil {
				return nil, err
			}
			// 隐藏排除（P-20261003-112）：与列表同一策展源同一口径，隐藏会话
			// 不再计入当日活跃数
			return claudesessions.VisibleEntries(batch, claudesessions.FetchCuration(store.Get().ClaudeCur, root)), nil
		},
		ClaudeTokens: func(projectPath string, start, end time.Time) (int64, error) {
			root := claudesessions.Root()
			if root == "" {
				return 0, nil
			}
			batch, err := store.Get().ClaudeIndex.GetBatch(store.ClaudeIndexPrefix(root, claudesessions.EncodePath(projectPath)))
			if err != nil {
				return 0, err
			}
			var total int64
			curation := claudesessions.FetchCuration(store.Get().ClaudeCur, root)
			for _, e := range batch {
				if c, ok := curation[e.ID]; ok && c.Hidden {
					continue // 隐藏排除（P-20261003-112）：token 消耗与活跃数同口径退场
				}
				// LastAt（文件 mtime）在窗前 = 窗内无新写入行，跳过零候选，
				// 不对历史长会话做无谓全文读
				if e.LastAt.Before(start) {
					continue
				}
				if u, ok, err := claudesessions.UsageWindow(root, e.Dir, e.ID, start, end); err == nil && ok {
					total += u.TotalTokens
				}
			}
			return total, nil
		},
		TerminalHistory: func(projectID string) ([]store.HistoryEntry, error) {
			return store.Get().TerminalHistory.Search(projectID, "", false, "")
		},
		Audit: func() ([]store.AuditEvent, error) {
			events, _, err := store.Get().Audit.List(auditScanLimit, 0)
			return events, err
		},
	}
}

// AggregateProject 聚合单项目当日事实。各数据源相互独立且尽力而为：
// 单源失败按零值计（非 git 目录的项目属常态），不拖垮整份日报
func (l Loaders) AggregateProject(p config.ProjectConfig, now time.Time) Daily {
	start, end := dayWindow(now)
	d := Daily{ProjectID: p.ID, ProjectName: p.Name}

	if l.Commits != nil {
		if commits, err := l.Commits(p.Path, start, end); err == nil {
			for _, c := range commits {
				if !inWindow(c.Date, start, end) {
					continue
				}
				d.Commits++
				if len(d.CommitSubjects) < subjectLimit {
					d.CommitSubjects = append(d.CommitSubjects, c.Message)
				}
			}
		}
	}
	if l.ClaudeSessions != nil {
		if entries, err := l.ClaudeSessions(p.Path); err == nil {
			for _, e := range entries {
				if inWindow(e.LastAt, start, end) {
					d.ClaudeSessions++
				}
			}
		}
	}
	if l.ClaudeTokens != nil {
		if tokens, err := l.ClaudeTokens(p.Path, start, end); err == nil {
			d.ClaudeTokens = tokens
		}
	}
	if l.TerminalHistory != nil {
		if entries, err := l.TerminalHistory(p.ID); err == nil {
			for _, e := range entries {
				if inWindow(e.At, start, end) {
					d.TerminalCmds++
				}
			}
		}
	}
	return d
}

// AggregateInstance 聚合实例级当日事实（审批 + 部署成败）。
// 取消的部署任务不计（用户主动行为，非「成/败」）
func (l Loaders) AggregateInstance(now time.Time) Instance {
	start, end := dayWindow(now)
	var inst Instance

	if l.Approvals != nil {
		if approvals, err := l.Approvals(); err == nil {
			for _, a := range approvals {
				if a.Status == store.ApprovalPending {
					inst.ApprovalsPending++
					continue
				}
				// 已裁决按裁决时间计当日；历史数据缺裁决时间退回创建时间
				resolved := a.CreatedAt
				if a.ResolvedAt != nil {
					resolved = *a.ResolvedAt
				}
				if inWindow(resolved, start, end) {
					inst.ApprovalsDone++
				}
			}
		}
	}
	if l.DeployTasks != nil {
		if tasks, err := l.DeployTasks(); err == nil {
			for _, t := range tasks {
				if t.StartedAt == nil || !inWindow(*t.StartedAt, start, end) {
					continue
				}
				switch t.Status {
				case config.TaskStatusCompleted:
					inst.DeploysOK++
				case config.TaskStatusFailed:
					inst.DeploysFailed++
				}
			}
		}
	}
	if l.Audit != nil {
		if events, err := l.Audit(); err == nil {
			for _, e := range events {
				if !inWindow(e.Time, start, end) {
					continue
				}
				inst.SecEvents++
				switch {
				case e.Action == store.AuditUnlock && e.Result != store.AuditResultSuccess:
					// 解锁失败含限流拒（denied）——连发试探的痕迹必须可见
					inst.SecUnlockFail++
				case isTokenChangeAction(e.Action):
					inst.SecTokenChange++
				}
			}
		}
	}
	return inst
}

// isTokenChangeAction 令牌生命周期动作（API token 与 agent token 同权）：
// 签发/撤销/轮换都算「令牌变更」；凭据（credential.*）不在其列——那是
// Git 凭据管理，与访问令牌是两回事
func isTokenChangeAction(action string) bool {
	switch action {
	case store.AuditTokenCreate, store.AuditTokenRevoke, store.AuditAgentRotated, store.AuditAgentRevoke:
		return true
	}
	return false
}

// subjectMaxLen 单条提交主题截断上限（rune）：日报是摘要视图，conventional
// 提交的数百字符尾注会把通知流撑成多屏，超长主题截断留头（类型/范围在前半句）
const subjectMaxLen = 80

// truncateHead 保留字符串开头 ≤max rune，截断以 … 收尾（与 deploy 的尾部
// 截断 truncateTail 相对：主题的定位信息在前半句）
func truncateHead(s string, max int) string {
	if max < 1 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

// DailyNotification 组装日报通知：类别 system、info 级（不触发桌面弹窗，
// 纯站内聚合）；携带项目跳转（panel:git 直达提交历史——日报主体是提交）。
// 文案走 i18n 模板（TitleKey/BodyKey + MsgParams），Title/Body 原文为无
// 模板消费方的中文回退。当日有审计事件时 BodyKey 切到含安全事件行的模板
// （P-20261003-51），零事件沿用基础模板——整行省略在键选择处完成
func DailyNotification(d Daily, inst Instance) notification.Notification {
	subjects := make([]string, 0, len(d.CommitSubjects))
	for _, s := range d.CommitSubjects {
		subjects = append(subjects, truncateHead(s, subjectMaxLen))
	}
	bodyKey := "report.daily.body"
	if inst.SecEvents > 0 {
		bodyKey = DailyBodySecKey
	}
	return notification.Notification{
		Type:     "info",
		Category: notification.CategorySystem,
		Title:    d.ProjectName + " · 今日动态",
		TitleKey: DailyTitleKey,
		Body:     strings.Join(subjects, "\n"),
		BodyKey:  bodyKey,
		MsgParams: map[string]any{
			"name":             d.ProjectName,
			"commits":          d.Commits,
			"approvalsDone":    inst.ApprovalsDone,
			"approvalsPending": inst.ApprovalsPending,
			"deploysOk":        inst.DeploysOK,
			"deploysFail":      inst.DeploysFailed,
			"sessions":         d.ClaudeSessions,
			"tokens":           formatTokensCompact(d.ClaudeTokens),
			"cmds":             d.TerminalCmds,
			"secTotal":         inst.SecEvents,
			"secUnlockFail":    inst.SecUnlockFail,
			"secTokenChange":   inst.SecTokenChange,
		},
		ProjectID:     d.ProjectID,
		ProjectName:   d.ProjectName,
		Action:        "panel",
		ActionPayload: "git",
	}
}

// ArchiveOf 日报存档快照（P-20261003-4）：与通知同一聚合事实的落档形态，
// 与 DailyNotification 同处组装保证两出口永不漂移。提交主题沿用通知的展示
// 截断（存档是回看视图，与当日所见一致）；tokens 存原始值（跨天可比），
// date 为 now 所在自然日（服务器本地时区，与聚合窗口同一时区）
func ArchiveOf(d Daily, inst Instance, now time.Time) store.DailyReport {
	subjects := make([]string, 0, len(d.CommitSubjects))
	for _, s := range d.CommitSubjects {
		subjects = append(subjects, truncateHead(s, subjectMaxLen))
	}
	return store.DailyReport{
		ProjectID:   d.ProjectID,
		ProjectName: d.ProjectName,
		Date:        now.Format(archiveDateFormat),

		Commits:        d.Commits,
		CommitSubjects: subjects,
		ClaudeSessions: d.ClaudeSessions,
		ClaudeTokens:   d.ClaudeTokens,
		TerminalCmds:   d.TerminalCmds,

		ApprovalsPending: inst.ApprovalsPending,
		ApprovalsDone:    inst.ApprovalsDone,
		DeploysOK:        inst.DeploysOK,
		DeploysFailed:    inst.DeploysFailed,
	}
}

// Emit 生成并投递当日全部项目日报，返回处理条数（投递的通知数或落档的
// 存档数，随两口注入情况而定）。无项目跳过；零事件项目跳过（防噪音）。
// 投递口注入（生产为 store.Notification.Add，落库后经出站口广播 WS），单测
// 以捕获函数替换。archive 为存档落档口（P-20261003-4，生产为
// store.DailyReport.Save）：与通知同批组装、先档后投（前端收到通知时回看口
// 已可查）；落档失败仅记日志不阻断通知主链（与 webhook 外发同款尽力而为）。
// add 与 archive 至少注入其一：二者皆 nil 视为无消费方直接返回 0
func Emit(now time.Time, l Loaders, add func(notification.Notification), archive func(store.DailyReport) error) int {
	if l.Projects == nil || (add == nil && archive == nil) {
		return 0
	}
	projects, err := l.Projects()
	if err != nil || len(projects) == 0 {
		return 0
	}
	inst := l.AggregateInstance(now)
	sent := 0
	for _, p := range projects {
		d := l.AggregateProject(p, now)
		if d.Empty() {
			continue
		}
		if archive != nil {
			if err := archive(ArchiveOf(d, inst, now)); err != nil {
				slog.Warn("daily report archive failed", "project", d.ProjectID, "err", err)
			}
		}
		if add != nil {
			add(DailyNotification(d, inst))
		}
		sent++
	}
	return sent
}

// dayWindow now 所在自然日（服务器本地时区）的起止：[start, start+24h)
func dayWindow(now time.Time) (time.Time, time.Time) {
	y, m, d := now.Date()
	start := time.Date(y, m, d, 0, 0, 0, 0, now.Location())
	return start, start.AddDate(0, 0, 1)
}

// formatTokensCompact token 用量紧凑展示（日报正文用）：<1k 原样、<1M 千位 k
// （≥100k 取整、其余一位小数，整数省小数位）、≥1M 一位小数 M——与前端会话
// 列表徽标同一口径（web ClaudeSessionPicker fmtTokens），两端数字互相对得上
func formatTokensCompact(n int64) string {
	switch {
	case n < 1000:
		return strconv.FormatInt(n, 10)
	case n < 1_000_000:
		k := float64(n) / 1000
		if k >= 100 {
			return strconv.FormatInt(int64(math.Round(k)), 10) + "k"
		}
		return strconv.FormatFloat(math.Round(k*10)/10, 'f', -1, 64) + "k"
	default:
		return strconv.FormatFloat(math.Round(float64(n)/100_000)/10, 'f', -1, 64) + "M"
	}
}

// inWindow t 是否落在 [start, end) 内
func inWindow(t, start, end time.Time) bool {
	return !t.Before(start) && t.Before(end)
}
