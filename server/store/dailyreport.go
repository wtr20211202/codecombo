package store

import (
	"encoding/json"
	"sort"
	"time"
)

// DailyReport 日报存档（P-20261003-4）：单项目单日的聚合事实快照，日报通知
// 发出时同步落档（车道 1 结构化状态，kind=dailyreport 一文档一项目日）。
// 聚合口径与通知 MsgParams 一致（commits/sessions/tokens/cmds/审批/部署），
// 差异仅两点：tokens 存原始数值（回看场景要跨天可比，紧凑格式化归前端）、
// commitSubjects 承载当日提交主题明细（通知 Body 的同源列表，已按展示口径截断）
type DailyReport struct {
	ProjectID   string `json:"projectId"`
	ProjectName string `json:"projectName"`
	Date        string `json:"date"` // YYYY-MM-DD（服务器本地时区，与聚合窗口同一时区）

	Commits        int      `json:"commits"`                  // 当日提交数
	CommitSubjects []string `json:"commitSubjects,omitempty"` // 当日提交主题（前 N 条，新→旧，展示截断）
	ClaudeSessions int      `json:"sessions"`                 // 当日活跃 claude 会话数
	ClaudeTokens   int64    `json:"tokens"`                   // 当日 token 消耗（原始值，P-20261002-139 口径）
	TerminalCmds   int      `json:"cmds"`                     // 当日终端命令数

	// 实例级事实（与通知同源附带：审批/部署无项目归属，发报时刻全实例快照）
	ApprovalsPending int `json:"approvalsPending"`
	ApprovalsDone    int `json:"approvalsDone"`
	DeploysOK        int `json:"deploysOk"`
	DeploysFailed    int `json:"deploysFail"`
}

// DailyReportStore 日报存档仓储：只写不改删（同日重发整体覆盖 upsert），
// 保留策略 14 天滚动（DailyReportRetention，由发报方随巡检裁剪——append 型
// kind 必须同 PR 带保留策略，持久化三车道纪律）
type DailyReportStore interface {
	// Save 落档（按 项目+日期 upsert：同键已存在则整体覆盖）
	Save(r DailyReport) error
	// List 最近存档倒序（date 降序、同日按项目 ID 升序），limit 封顶条数
	List(limit int) ([]DailyReport, error)
	// ListByDate 单日全部项目存档（项目 ID 升序）；无存档返回空切片非错误
	ListByDate(date string) ([]DailyReport, error)
	// CleanupBefore 删除 Date 早于 before 的存档，返回删除数
	CleanupBefore(before time.Time) (int, error)
}

// dailyReportKind 文档存储 kind 名
const dailyReportKind = "dailyreport"

// DailyReportRetention 日报保留窗口：14 天覆盖「周期回顾」的最小完整周期
// （双周），更久的历史属月度/季度报表职责（与 agenttask 7 天/audit 30 天同族）
const DailyReportRetention = 14 * 24 * time.Hour

// dailyReportListDefault List 未指定 limit 时的默认条数
const dailyReportListDefault = 100

// dailyReportListMax List limit 钳制上限（14 天 × 项目数封顶，200 与通知
// 中心同一量级）
const dailyReportListMax = 200

// dateLayout 存档日期（key 前缀与 Date 字段）的格式
const dateLayout = "2006-01-02"

// dailyReportRepo 日报存档仓储实现
//
// 无 repo 内互斥锁：文档键即并发粒度（filestore 锁是 kind 级，单键 Create/
// Update 各自原子），Save 的 upsert（Create 撞 ErrAlreadyExists 转 Update）
// 在「同键并发落档」下最坏丢一次覆盖方向、内容仍是完整文档，无读改写撕裂
type dailyReportRepo struct{ doc DocumentStore }

// NewDailyReportRepo 构造日报存档仓储（导出供测试注入独立 DocumentStore，
// 同 NewAuditLogRepo 惯例）
func NewDailyReportRepo(doc DocumentStore) DailyReportStore {
	return &dailyReportRepo{doc: doc}
}

// archiveKey 存档文档键：日期在前（定宽 10 字节）+ 下划线 + 项目 ID。
// 日期前置使字典序 = 时间序（List 倒序截断/单日前缀扫描都靠它，免全量读值
// 排序）；项目 ID 从定宽偏移切分（uuid 含连字符，不依赖分隔符全局唯一）
func dailyReportKey(date, projectID string) string {
	return date + "_" + projectID
}

// keyDate 键内日期段；非本 kind 形状的键返回空（外来/损坏键跳过不误删）
func dailyReportKeyDate(key string) string {
	if len(key) < len(dateLayout)+1 || key[len(dateLayout)] != '_' {
		return ""
	}
	return key[:len(dateLayout)]
}

// validDate 日期字符串必须是真实存在的 YYYY-MM-DD（Parse 拒绝越界月日，
// 防前缀扫描被畸形输入撑爆）
func validReportDate(date string) bool {
	_, err := time.Parse(dateLayout, date)
	return err == nil
}

// Save 实现 DailyReportStore.Save
func (r *dailyReportRepo) Save(rep DailyReport) error {
	if rep.ProjectID == "" || !validReportDate(rep.Date) {
		return ErrInvalidArg
	}
	data, err := json.Marshal(rep)
	if err != nil {
		return err
	}
	key := dailyReportKey(rep.Date, rep.ProjectID)
	if err := r.doc.Create(dailyReportKind, key, data); err == nil {
		return nil
	}
	// 已存在（同日重发/补跑）：整体覆盖为最新聚合
	return r.doc.Update(dailyReportKind, key, data)
}

// List 实现 DailyReportStore.List：键字典序倒序即 date 降序（日期前置键的
// 直读），同日内反转为项目 ID 升序。存档量有 14 天保留封顶，全键读值成本可忽略
func (r *dailyReportRepo) List(limit int) ([]DailyReport, error) {
	if limit <= 0 {
		limit = dailyReportListDefault
	}
	if limit > dailyReportListMax {
		limit = dailyReportListMax
	}
	keys, _, err := r.doc.List(dailyReportKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	items := make([]DailyReport, 0, len(keys))
	for i := len(keys) - 1; i >= 0 && len(items) < limit; i-- {
		data, err := r.doc.Get(dailyReportKind, keys[i])
		if err != nil {
			continue
		}
		var rep DailyReport
		if json.Unmarshal(data, &rep) != nil {
			continue
		}
		items = append(items, rep)
	}
	// 同日多条呈 projectID 降序（整串倒序所致），按日期分组回落升序
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Date != items[j].Date {
			return items[i].Date > items[j].Date
		}
		return items[i].ProjectID < items[j].ProjectID
	})
	return items, nil
}

// ListByDate 实现 DailyReportStore.ListByDate：单日前缀扫描，键字典序即
// 项目 ID 升序
func (r *dailyReportRepo) ListByDate(date string) ([]DailyReport, error) {
	if !validReportDate(date) {
		return nil, ErrInvalidArg
	}
	keys, _, err := r.doc.List(dailyReportKind, ListOpts{Prefix: dailyReportKey(date, "")})
	if err != nil {
		return nil, err
	}
	items := make([]DailyReport, 0, len(keys))
	for _, k := range keys {
		data, err := r.doc.Get(dailyReportKind, k)
		if err != nil {
			continue
		}
		var rep DailyReport
		if json.Unmarshal(data, &rep) != nil {
			continue
		}
		items = append(items, rep)
	}
	return items, nil
}

// CleanupBefore 实现 DailyReportStore.CleanupBefore：键前 10 字节即日期，
// 字典序比较免逐档读值（保留窗口外的旧档整批删）
func (r *dailyReportRepo) CleanupBefore(before time.Time) (int, error) {
	cutoff := before.Format(dateLayout)
	keys, _, err := r.doc.List(dailyReportKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	var stale []string
	for _, k := range keys {
		if d := dailyReportKeyDate(k); d != "" && d < cutoff {
			stale = append(stale, k)
		}
	}
	if len(stale) == 0 {
		return 0, nil
	}
	if err := r.doc.DeleteBatch(dailyReportKind, stale); err != nil {
		return 0, err
	}
	return len(stale), nil
}
