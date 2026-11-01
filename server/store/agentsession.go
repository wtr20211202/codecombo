package store

import (
	"encoding/json"
	"time"
)

// SessionMark 审阅基线标记（P-20261003-217）：阶段性审阅完成时点的快照。
// 产出视图可切换 diff 范围到任一标记（activity?since=<ts>），下轮审阅从新
// 基线算，长会话多轮改动不必每次都从 startHead 重看。
// diff 基点按时间戳经 rev-list --before 取「标记前最后一个提交」计算——
// Head 仅是标记时的参考快照不参与计算：会话期间的 rebase/amend 会使记录的
// HEAD 悬空，时间戳锚定不受历史改写影响。
type SessionMark struct {
	Ts   time.Time `json:"ts"`
	Head string    `json:"head,omitempty"`
}

// FleetBatch 编队批元数据（P-20261005-145）：bulk-agent 一次编队的身份与
// 花名册，逐成员会话各存一份同值拷贝（任一成员即可反查全批，成员会话部分
// 关闭后花名册仍完整——「这批还有谁、当时一起发了几个」不依赖存活面推导）。
// 批身份只落会话元数据车道（非 uiState）：agent 经 GET /api/terminals?fleet=
// 按批过滤即可编程追踪编队。
type FleetBatch struct {
	BatchID    string    `json:"batchId"`
	LaunchedAt time.Time `json:"launchedAt"`
	// Members 该批全部已创建会话 id（创建序；跳过项从未成为会话不入册）
	Members []string `json:"members"`
}

// AgentSessionMeta 智能体会话元数据（B3 产出视图）：
// 记录会话创建时刻的工作目录与 HEAD——产出视图据此计算「本会话动了什么」
// （git diff startHead..工作区，含会话期间已提交的工作，确定性归属不靠事件猜）。
// 会话关闭时删除（孤儿元数据由列表侧过滤兜底）。
type AgentSessionMeta struct {
	ID             string `json:"id"` // 终端会话 ID（agent-<unixnano> / tmux 名）
	Dir            string `json:"dir"`
	Runtime        string `json:"runtime,omitempty"`        // shell / claude / codex / dsh / 用户自定义智能体注册名 / ''
	RuntimeVersion string `json:"runtimeVersion,omitempty"` // 创建时预检顺取的 --version 输出首行（P-20261003-134；旧会话/解析失败留空）
	// InitialPrompt 创建时注入的初始指令原文（P-20261003-146）：launchArgs 通道
	// 的原样快照（prompt 与 CLI 参数共用该通道，如 --resume <id>）。「重新发起」
	// 据此预填新建对话框；仅创建链写入（会话内后续输入不属于它），无注入/旧
	// 会话留空（omitempty 不落键，「旧数据面 + 新二进制」读回同形态零迁移）
	InitialPrompt string        `json:"initialPrompt,omitempty"`
	Name          string        `json:"name,omitempty"`      // 会话显示名（重启恢复时还原，用户重命名同步更新）
	ProjectID     string        `json:"projectID,omitempty"` // 项目会话归属（槽位名继承的反查键；agent 会话为空）
	Named         bool          `json:"named,omitempty"`     // 用户手动重命名过（区别于创建默认名，槽位继承只认它）
	NamedAt       time.Time     `json:"namedAt,omitempty"`   // 最近一次重命名时刻（同槽位多条时取最新）
	StartHead     string        `json:"startHead,omitempty"`
	Marks         []SessionMark `json:"marks,omitempty"` // 审阅基线标记（追加型，上限 10 FIFO——随 meta 生命周期存续，会话关闭即整体消亡）
	// Sensitive 人工策展的敏感标记（P-20261003-155）：调试时贴过凭据/token 的
	// 会话由用户显式标注，导出/分享等出域动作命中时要求二次确认（本地检索
	// 不受限——标记只管出域不管可见性）。默认无标 = 现状零变化；旧文档缺
	// 字段反序列化为 false，向后兼容
	Sensitive bool `json:"sensitive,omitempty"`
	// ExitCode 异常退出记录（P-20261004-60）：仅非 0 退出由退出钩子落键
	//（0 与「无记录」共用缺省——正常退出/存活中/旧数据同形，省一个指针字段）；
	// 会话销毁后验尸（GET /terminals/:id/postmortem）据此还原退出码。旧文档
	// 缺字段反序列化为 0，向后兼容零迁移
	ExitCode int `json:"exitCode,omitempty"`
	// ExitedAt 异常退出时刻（与 ExitCode 同写）：验尸报告时间窗的右沿
	ExitedAt time.Time `json:"exitedAt,omitempty"`
	// FleetBatch 编队批元数据（P-20261005-145，见 FleetBatch 注）：仅 bulk-agent
	// 链写入（创建漏斗变参 WithFleetBatch 携带，单开会话/调度链零键）；旧文档
	// 缺字段反序列化为 nil，指针 omitempty 不落键——「旧数据面 + 新二进制」
	// 读回同形态零迁移
	FleetBatch *FleetBatch `json:"fleetBatch,omitempty"`
	// Derived 会话名为系统派生（P-20261023-3）：创建时未显式命名、名字来自
	// prompt 首行摘要/槽位继承/序号默认名——命名来源的身份记录，同名步进
	// （「·2」后缀）与侧栏「新」徽标等身份面的数据面；用户一旦手动改名，
	// Named 翻转而 Derived 保持创建时点的事实。旧文档缺字段反序列化为 false，
	// omitempty 不落键，零迁移
	Derived bool `json:"derived,omitempty"`
	// Resumed 会话由恢复旗标创建（P-20261023-3）：launchArgs 为旗标形态
	//（--resume <id> 等 Claude 恢复链注入）——「接续」徽标判据（新建 ≠ 复用
	// 的界面承诺：接续会话继承槽位旧名，与新会话同名歧义的第二区分维度）。
	// 旧文档缺字段反序列化为 false，同上零迁移
	Resumed   bool      `json:"resumed,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type AgentSessionMetaStore interface {
	Save(meta AgentSessionMeta) error
	Get(id string) (*AgentSessionMeta, error)
	Delete(id string) error
	List() ([]AgentSessionMeta, error)
}

type agentSessionMetaRepo struct {
	doc DocumentStore
}

func newAgentSessionMetaRepo(doc DocumentStore) *agentSessionMetaRepo {
	return &agentSessionMetaRepo{doc: doc}
}

const agentSessionMetaKind = "agentsessionmeta"

func (r *agentSessionMetaRepo) Save(meta AgentSessionMeta) error {
	b, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return r.doc.Upsert(agentSessionMetaKind, meta.ID, b)
}

func (r *agentSessionMetaRepo) Get(id string) (*AgentSessionMeta, error) {
	b, err := r.doc.Get(agentSessionMetaKind, id)
	if err != nil {
		return nil, err
	}
	var meta AgentSessionMeta
	if err := json.Unmarshal(b, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func (r *agentSessionMetaRepo) Delete(id string) error {
	return r.doc.Delete(agentSessionMetaKind, id)
}

func (r *agentSessionMetaRepo) List() ([]AgentSessionMeta, error) {
	keys, _, err := r.doc.List(agentSessionMetaKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	out := make([]AgentSessionMeta, 0, len(keys))
	for _, k := range keys {
		if m, err := r.Get(k); err == nil {
			out = append(out, *m)
		}
	}
	return out, nil
}

// RuntimeForSession 会话运行时反查（审批卡片展示智能体类型用）：
// 会话不存在/未记录运行时返回空串——审批照常创建，卡片显示「未知来源」
func RuntimeForSession(id string) string {
	if id == "" {
		return ""
	}
	m, err := Get().AgentSession.Get(id)
	if err != nil || m == nil {
		return ""
	}
	return m.Runtime
}

// RuntimeVersionForSession 会话运行时版本反查（P-20261003-134，会话中心行
// tooltip 展示用）：旧会话 / 纯 shell / 自定义命令豁免链无记录返回空串——
// 展示端空显不虚构（「这条会话是 claude X.Y 跑的」的归因依据）
func RuntimeVersionForSession(id string) string {
	if id == "" {
		return ""
	}
	m, err := Get().AgentSession.Get(id)
	if err != nil || m == nil {
		return ""
	}
	return m.RuntimeVersion
}
