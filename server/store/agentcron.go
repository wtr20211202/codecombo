package store

import (
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// ErrAgentCronNotFound 定时任务不存在
var ErrAgentCronNotFound = errors.New("agent cron not found")

// 触发类型（P-20261003-124 定时任务依赖链）：空值 = CronTriggerSchedule
// （既有任务零迁移——旧数据无 trigger 字段，反序列化为空即定时语义）
const (
	// CronTriggerSchedule 定时触发（每日 HH:MM，既有语义）
	CronTriggerSchedule = "schedule"
	// CronTriggerAfter 前序完成触发：父任务回执落定后由调度器级联发起
	CronTriggerAfter = "after"
)

// CronTriggerAfter 的档位：空值 = CronAfterSuccess
const (
	// CronAfterSuccess 成功才触发：父任务 done 才级联
	CronAfterSuccess = "success"
	// CronAfterAlways 完成即触发：父任务 done/failed 都级联（流程必须继续，
	// 不论前序成果质量）
	CronAfterAlways = "always"
)

// CronRelayLatest RelayFrom 动态解析形态：触发时取项目（Dir）最近已结束的
// claude 会话作接力源（与显式会话 ID 二选一，P-20261005-207）
const CronRelayLatest = "latest"

// AgentCron 定时智能体任务（P-20261002-43）：到点经 agent 终端通道自动发起
// 一个 agent 会话（launchArgs 通道注入 prompt）。schedule 为 MVP 简化模型——
// 「每日 HH:MM + 周几集合」，不做完整 cron 表达式（周几空集 = 每天触发）。
// 运行期事实（LastRunAt/LastResult/History）由调度器经 RecordRun 单点写入，
// 用户编辑（Update）不得触碰，防编辑与触发互相覆盖。
type AgentCron struct {
	ID   string `json:"id"` // sc_cron_ + uuid，服务端生成
	Name string `json:"name"`

	// Hour/Minute 每日触发时刻（评估时区见 Timezone；0≤Hour≤23、0≤Minute≤59；
	// Trigger=after 时仅作展示遗留，调度器与级联链都不消费）
	Hour   int `json:"hour"`
	Minute int `json:"minute"`
	// Weekdays 生效周几集合（0=周日…6=周六，按评估时区的日历）；空 = 每天生效
	Weekdays []int `json:"weekdays,omitempty"`
	// Timezone 评估时区（P-20261005-217，可选）：IANA 名（如 Asia/Shanghai），
	// 空 = 服务器本地时区（既有语义；存量任务无此字段反序列化为空，幂等读
	// 零迁移——跨时区部署错点从玄学变显式可查，per-task 解锁「按业务地时间跑」）。
	// 保存口已校验 LoadLocation 可加载（api 层），运行期加载失败回落本地时区：
	// 平台 tz 数据缺失时宁可退回旧语义，不可让调度崩摆
	Timezone string `json:"timezone,omitempty"`

	// Runtime 底层运行时（""/"auto" = 按可用性选型；shell/claude/codex/dsh/自定义注册名）
	Runtime string `json:"runtime,omitempty"`
	// Prompt 发起时经 launchArgs 通道注入的任务指令（≤500 UTF-8 字节，与
	// agent 会话 launchArgs 上限同口径；支持 {date}/{time}/{weekday} 触发时
	// 展开——配额按模板字节计，展开后为注入面，注记见 agentcron/cron.go）
	Prompt string `json:"prompt"`
	// Dir 会话工作目录（空 = 用户主目录）
	Dir string `json:"dir,omitempty"`

	// Enabled 启停开关（停用任务被调度器跳过，配置保留）
	Enabled bool `json:"enabled"`
	// MissCatchUp 错过补偿：服务停机跨过触发点时启动后补跑一次
	MissCatchUp bool `json:"missCatchUp,omitempty"`

	// 依赖链三字段（P-20261003-124）：Trigger=after 时任务不再按时刻调度，
	// 由父任务（AfterCronID 指向同库另一任务）的完成回执驱动，档位 AfterMode
	// 决定父失败时是否继续。环在保存口拒绝（api 层链上溯），此处只存形状
	Trigger     string `json:"trigger,omitempty"`     // "" / schedule / after
	AfterCronID string `json:"afterCronId,omitempty"` // 父任务 ID（trigger=after 时必填）
	AfterMode   string `json:"afterMode,omitempty"`   // "" / success / always

	// RelayFrom 接力源（P-20261005-207）：触发时取源会话结论注入 launchArgs
	// 前言，长周期任务跨会话自动续命。"" = 不接力（旧数据无此字段零迁移）；
	// latest = 项目（Dir）最近已结束会话动态解析；其余非空值 = 显式 claude
	// 会话 ID（源不存在时触发期降级，见 agentcron/relay.go）
	RelayFrom string `json:"relayFrom,omitempty"`

	// Extract 指标抽取规则（P-20261005-237，缺省关——存量零迁移）：任务完成
	// 回执落定时从会话输出尾窗抽取数值入 per-任务时序（CronMetric 环形 30 点）。
	// 两形态：正则（Go RE2，首个命名捕获组承载数值、组名即指标名，如
	// `(?:build in) (?P<sec>[0-9.]+)s`）或 `json:` 前缀 + 点分路径（取尾窗
	// 首个可解析 JSON 对象，如 `json:duration.seconds`）。规则即 agent 可编程
	// 配置的探测面——保存口压实形态（api 层 validateExtract），运行期只可能
	// 「无数据」不可能「坏规则」
	Extract string `json:"extract,omitempty"`

	// LastRunAt 最近一次触发时刻（含手动试跑；调度器跨重启的当日去重锚点）
	LastRunAt time.Time `json:"lastRunAt,omitempty"`
	// LastResult 最近一次运行结果：launched / done / failed / skipped / error:<msg>
	LastResult string `json:"lastResult,omitempty"`
	// LastRelayAt / LastRelayNote 最近一次接力解析事实（RecordRelay 单点写入，
	// 用户编辑不可触碰——LastRunAt/LastResult 同纪律）。Note 词汇：relayed =
	// 已注入前言；skipped: <原因> = 降级无前言（源无结论/会话不存在/配额不够）
	LastRelayAt   time.Time `json:"lastRelayAt,omitempty"`
	LastRelayNote string    `json:"lastRelayNote,omitempty"`
	// History 最近运行历史（P-20261002-143，最新在尾；超出
	// agentCronRunHistoryMax 截断最旧）。与任务本体同文档内嵌，不新建存储
	History []AgentCronRun `json:"history,omitempty"`
	// MissedHistory 最近错过槽历史（P-20261006-22，最新在尾；超出
	// agentCronMissedHistoryMax 截断最旧）。调度器经 RecordMissed 单点写入，
	// 用户编辑不可触碰（History 同纪律）。存量数据无此字段，反序列化为 nil =
	// 空历史（幂等读，零迁移）
	MissedHistory []AgentCronMissed `json:"missedHistory,omitempty"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// IsAfterTrigger 前序完成触发任务判定（空 trigger = 定时，既有数据零迁移）
func (c AgentCron) IsAfterTrigger() bool { return c.Trigger == CronTriggerAfter }

// AgentCronRun 单次运行历史条目：At 触发时刻、Result 与 LastResult 同词汇
// （launched / done / failed / skipped / error:<msg>；skipped = 前序完成触发
// 因父任务失败/未执行被跳过，P-20261003-124）、ErrSummary 失败摘要（写入时
// rune 截断，成功路径为空）
type AgentCronRun struct {
	At         time.Time `json:"at"`
	Result     string    `json:"result"`
	ErrSummary string    `json:"errSummary,omitempty"`
}

// AgentCronMissed 单次错过槽条目（P-20261006-22）：Slot 计划槽点（非触发时刻
// ——错过即该槽没跑）、Action 处置词汇（skipped = 未开补偿只标记 / caught-up =
// 补跑发起成功 / failed = 补跑发起失败，ErrSummary 带错误）、ErrSummary 补跑
// 失败摘要（写入时 rune 截断，其余路径为空）。补跑自身的运行结果照常走
// RecordRun 运行账（done/failed 落 History），两账分工
type AgentCronMissed struct {
	Slot       time.Time `json:"slot"`
	Action     string    `json:"action"`
	ErrSummary string    `json:"errSummary,omitempty"`
}

const (
	// agentCronRunHistoryMax 运行历史保留条数（环形截断最旧）
	agentCronRunHistoryMax = 20
	// agentCronMissedHistoryMax 错过槽历史保留条数（环形截断最旧，与运行历史
	// 同量级——停机一周的每日任务也只产生个位数错过条目）
	agentCronMissedHistoryMax = 20
	// agentCronErrSummaryMax 失败摘要 rune 上限（写入时截断）
	agentCronErrSummaryMax = 120
)

// AgentCronStore 定时任务存储（doc store kind=agentcron，单文档全量数组 + repo
// 内互斥；任务为用户手工维护的小规模清单，全量读足够）
type AgentCronStore interface {
	// List 全量列表（触发时刻字典序）
	List() ([]AgentCron, error)
	// Get 单条（不存在返回 ErrAgentCronNotFound）
	Get(id string) (*AgentCron, error)
	// Create 新建（忽略传入 ID/时间戳/运行期事实，服务端生成）
	Create(input AgentCron) (*AgentCron, error)
	// Update 全量替换用户可编辑字段（Name/时刻/Weekdays/Timezone/Runtime/Prompt/
	// Dir/Enabled/MissCatchUp/Trigger/AfterCronID/AfterMode/RelayFrom/Extract），
	// 保留 ID/CreatedAt 与运行期事实；不存在返回 ErrAgentCronNotFound
	Update(id string, input AgentCron) (*AgentCron, error)
	// Delete 删除（不存在返回 ErrAgentCronNotFound）
	Delete(id string) error
	// RecordRun 调度器/试跑专用：记录触发时刻与结果并追加一条运行历史
	// （errSummary 失败摘要 ≤120 rune，写入时截断，成功路径传空；用户编辑路径
	// 不走此门）
	RecordRun(id string, at time.Time, result string, errSummary string) error
	// RecordRelay 调度器/试跑专用：记录最近一次接力解析事实（note 词汇见
	// LastRelayNote 注释，≤120 rune 写入时截断）。与 RecordRun 分门——接力事实
	// 不动 LastRunAt/LastResult/History（运行账与接力账语义独立）
	RecordRelay(id string, at time.Time, note string) error
	// RecordMissed 调度器专用：追加一条错过槽历史（P-20261006-22；action 词汇
	// 见 AgentCronMissed 注释，errSummary ≤120 rune 写入时截断）并环形截断。
	// 不动运行账（LastRunAt/LastResult/History）。同槽同处置幂等：进程内
	// markChecked 只防同进程重复，「未补偿跳过」不翻写运行账、跨重启会同槽
	// 再判一次 Missed，此处按槽+处置去重防条目堆积
	RecordMissed(id string, slot time.Time, action, errSummary string) error
}

const agentCronKind = "agentcron"

type agentCronRepo struct {
	mu  sync.Mutex // filestore 锁是 kind 级，读改写必须 repo 内互斥
	doc DocumentStore
}

func newAgentCronRepo(doc DocumentStore) *agentCronRepo {
	return &agentCronRepo{doc: doc}
}

func (r *agentCronRepo) load() ([]AgentCron, error) {
	data, err := r.doc.Get(agentCronKind, "all")
	if err != nil {
		return []AgentCron{}, nil // 首次使用/损坏文档按空处理，下次保存自愈
	}
	var crons []AgentCron
	if err := json.Unmarshal(data, &crons); err != nil {
		return []AgentCron{}, nil
	}
	return crons, nil
}

func (r *agentCronRepo) save(crons []AgentCron) error {
	if crons == nil {
		crons = []AgentCron{}
	}
	data, err := json.Marshal(crons)
	if err != nil {
		return err
	}
	return r.doc.Upsert(agentCronKind, "all", data)
}

func (r *agentCronRepo) List() ([]AgentCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return nil, err
	}
	sort.Slice(crons, func(i, j int) bool {
		if crons[i].Hour != crons[j].Hour {
			return crons[i].Hour < crons[j].Hour
		}
		if crons[i].Minute != crons[j].Minute {
			return crons[i].Minute < crons[j].Minute
		}
		return crons[i].Name < crons[j].Name
	})
	return crons, nil
}

func (r *agentCronRepo) Get(id string) (*AgentCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return nil, err
	}
	for _, c := range crons {
		if c.ID == id {
			out := c
			return &out, nil
		}
	}
	return nil, ErrAgentCronNotFound
}

// applyEditable 用户可编辑字段的替换语义（Create/Update 共用，服务端不二次校验
// 之外的改写；运行期事实与身份字段一律不可经此通道修改）
func applyEditable(dst *AgentCron, src AgentCron) {
	dst.Name = src.Name
	dst.Hour = src.Hour
	dst.Minute = src.Minute
	dst.Weekdays = src.Weekdays
	dst.Timezone = src.Timezone
	dst.Runtime = src.Runtime
	dst.Prompt = src.Prompt
	dst.Dir = src.Dir
	dst.Enabled = src.Enabled
	dst.MissCatchUp = src.MissCatchUp
	dst.Trigger = src.Trigger
	dst.AfterCronID = src.AfterCronID
	dst.AfterMode = src.AfterMode
	dst.RelayFrom = src.RelayFrom
	dst.Extract = src.Extract
}

func (r *agentCronRepo) Create(input AgentCron) (*AgentCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	c := AgentCron{ID: "sc_cron_" + uuid.NewString(), CreatedAt: now, UpdatedAt: now}
	applyEditable(&c, input)
	crons = append(crons, c)
	if err := r.save(crons); err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *agentCronRepo) Update(id string, input AgentCron) (*AgentCron, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return nil, err
	}
	for i := range crons {
		if crons[i].ID != id {
			continue
		}
		applyEditable(&crons[i], input)
		crons[i].UpdatedAt = time.Now()
		if err := r.save(crons); err != nil {
			return nil, err
		}
		out := crons[i]
		return &out, nil
	}
	return nil, ErrAgentCronNotFound
}

func (r *agentCronRepo) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return err
	}
	out := crons[:0]
	found := false
	for _, c := range crons {
		if c.ID == id {
			found = true
			continue
		}
		out = append(out, c)
	}
	if !found {
		return ErrAgentCronNotFound
	}
	return r.save(out)
}

// RecordRun 运行期事实落库：LastRunAt/LastResult 照旧翻写，History 追加一条
// 运行历史并环形截断（只留最近 agentCronRunHistoryMax 条，最旧先丢）。
// errSummary 经 rune 安全截断到 agentCronErrSummaryMax（保头——失败起因通常
// 在摘要开头）
func (r *agentCronRepo) RecordRun(id string, at time.Time, result string, errSummary string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return err
	}
	for i := range crons {
		if crons[i].ID != id {
			continue
		}
		crons[i].LastRunAt = at
		crons[i].LastResult = result
		crons[i].History = append(crons[i].History, AgentCronRun{
			At:         at,
			Result:     result,
			ErrSummary: truncateRunes(errSummary, agentCronErrSummaryMax),
		})
		if over := len(crons[i].History) - agentCronRunHistoryMax; over > 0 {
			crons[i].History = crons[i].History[over:]
		}
		crons[i].UpdatedAt = time.Now()
		return r.save(crons)
	}
	return ErrAgentCronNotFound
}

// RecordRelay 接力事实落库：只翻写 LastRelayAt/LastRelayNote（运行账不动，
// 见接口注释）。note 经 rune 安全截断——skip 原因含会话 id 等不可控输入
func (r *agentCronRepo) RecordRelay(id string, at time.Time, note string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return err
	}
	for i := range crons {
		if crons[i].ID != id {
			continue
		}
		crons[i].LastRelayAt = at
		crons[i].LastRelayNote = truncateRunes(note, agentCronErrSummaryMax)
		crons[i].UpdatedAt = time.Now()
		return r.save(crons)
	}
	return ErrAgentCronNotFound
}

// RecordMissed 错过槽事实落库：MissedHistory 追加一条并环形截断（只留最近
// agentCronMissedHistoryMax 条，最旧先丢），运行账不动（见接口注释）。errSummary
// 经 rune 安全截断到 agentCronErrSummaryMax（与 RecordRun 同口径）。同槽同处置
// 已有条目时跳过追加（幂等，防跨重启同日重判堆积重复条目——处置变化仍入账，
// 如用户中途开启补偿后同槽再判为补跑）
func (r *agentCronRepo) RecordMissed(id string, slot time.Time, action, errSummary string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	crons, err := r.load()
	if err != nil {
		return err
	}
	for i := range crons {
		if crons[i].ID != id {
			continue
		}
		for _, m := range crons[i].MissedHistory {
			if m.Slot.Equal(slot) && m.Action == action {
				return nil
			}
		}
		crons[i].MissedHistory = append(crons[i].MissedHistory, AgentCronMissed{
			Slot:       slot,
			Action:     action,
			ErrSummary: truncateRunes(errSummary, agentCronErrSummaryMax),
		})
		if over := len(crons[i].MissedHistory) - agentCronMissedHistoryMax; over > 0 {
			crons[i].MissedHistory = crons[i].MissedHistory[over:]
		}
		crons[i].UpdatedAt = time.Now()
		return r.save(crons)
	}
	return ErrAgentCronNotFound
}

// truncateRunes rune 安全截断（不切断多字节字符，超长丢尾）
func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}
