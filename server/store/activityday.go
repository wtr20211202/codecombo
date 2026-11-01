package store

import (
	"encoding/json"
	"sort"
	"time"
)

// ActivityDay 实例级单日活动序列行（P-20261003-37）：日报发报链随存档落库
// 顺带追加的数值行（车道 1 结构化状态，kind=activityday 一文档一天，实例级
// 聚合——热力图回答的是「这台实例最近活不活跃」，无项目维度）。三项数值
// 与 DailyReport 同名聚合字段同源，不做二次采集
type ActivityDay struct {
	Date     string `json:"date"` // YYYY-MM-DD（服务器本地时区，与日报聚合窗口同一时区）
	Commits  int    `json:"commits"`
	Sessions int    `json:"sessions"`
	Commands int    `json:"commands"`
}

// ActivityDayStore 实例活动序列仓储：按日 upsert（同日重发整体覆盖，append
// 幂等），保留策略 365 天滚动（ActivityDayRetention，随发报巡检裁剪——
// append 型 kind 必须同 PR 带保留策略，持久化三车道纪律）
type ActivityDayStore interface {
	// Save 落一行（按日期 upsert：同键已存在则整体覆盖）
	Save(d ActivityDay) error
	// List 最近 days 天序列（date 升序，旧→新——热力图列即周次，升序直铺）；
	// days 钳制 [1, ActivityDayRetention 上限]；无数据返回空切片非错误
	List(days int) ([]ActivityDay, error)
	// CleanupBefore 删除 Date 早于 before 的行，返回删除数
	CleanupBefore(before time.Time) (int, error)
}

// activityDayKind 文档存储 kind 名
const activityDayKind = "activityday"

// ActivityDayRetention 活动序列保留窗口：365 天覆盖 contribution graph 的
// 年度视角（前端季度卡片只取尾段，滚动清理按此窗口）
const ActivityDayRetention = 365 * 24 * time.Hour

// activityDayListMax List days 钳制上限（与保留窗口天数一致，365 行封顶）
const activityDayListMax = 365

// activityDayRepo 实例活动序列仓储实现
//
// 无 repo 内互斥锁：键即并发粒度（filestore 锁是 kind 级），Save 的 upsert
// 语义与 dailyReportRepo 同款——同键并发落档最坏丢一次覆盖方向、内容仍是
// 完整文档，无读改写撕裂
type activityDayRepo struct{ doc DocumentStore }

// NewActivityDayRepo 构造实例活动序列仓储（导出供测试注入独立 DocumentStore，
// 同 NewDailyReportRepo 惯例）
func NewActivityDayRepo(doc DocumentStore) ActivityDayStore {
	return &activityDayRepo{doc: doc}
}

// validActivityDate 日期必须是真实存在的 YYYY-MM-DD（Parse 拒绝越界月日，
// 与 dailyreport 的 validReportDate 同款把关；不共用是省一层跨文件耦合，
// 语义一致由各自单测锁定）
func validActivityDate(date string) bool {
	_, err := time.Parse(dateLayout, date)
	return err == nil
}

// Save 实现 ActivityDayStore.Save：文档键即日期（定宽 10 字节，字典序=时间序，
// List 截断/CleanupBefore 零读值成本）
func (r *activityDayRepo) Save(d ActivityDay) error {
	if !validActivityDate(d.Date) {
		return ErrInvalidArg
	}
	data, err := json.Marshal(d)
	if err != nil {
		return err
	}
	if err := r.doc.Create(activityDayKind, d.Date, data); err == nil {
		return nil
	}
	// 已存在（同日重发/手动补跑）：整体覆盖为最新聚合，重放不累计（append 幂等）
	return r.doc.Update(activityDayKind, d.Date, data)
}

// List 实现 ActivityDayStore.List：键字典序取尾段即最近 days 天，升序返回。
// 行量有 365 保留封顶，全键读值成本可忽略
func (r *activityDayRepo) List(days int) ([]ActivityDay, error) {
	if days <= 0 {
		days = activityDayListMax
	}
	if days > activityDayListMax {
		days = activityDayListMax
	}
	keys, _, err := r.doc.List(activityDayKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	sort.Strings(keys)
	// 只保留合法日期形状的键（外来/损坏键跳过），取尾段 days 行
	start := len(keys) - days
	if start < 0 {
		start = 0
	}
	items := make([]ActivityDay, 0, len(keys)-start)
	for _, k := range keys[start:] {
		if !validActivityDate(k) {
			continue
		}
		data, err := r.doc.Get(activityDayKind, k)
		if err != nil {
			continue
		}
		var d ActivityDay
		if json.Unmarshal(data, &d) != nil {
			continue
		}
		items = append(items, d)
	}
	return items, nil
}

// CleanupBefore 实现 ActivityDayStore.CleanupBefore：键即日期，字典序比较免
// 逐行读值（保留窗口外的旧行整批删）
func (r *activityDayRepo) CleanupBefore(before time.Time) (int, error) {
	cutoff := before.Format(dateLayout)
	keys, _, err := r.doc.List(activityDayKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	var stale []string
	for _, k := range keys {
		if validActivityDate(k) && k < cutoff {
			stale = append(stale, k)
		}
	}
	if len(stale) == 0 {
		return 0, nil
	}
	if err := r.doc.DeleteBatch(activityDayKind, stale); err != nil {
		return 0, err
	}
	return len(stale), nil
}
