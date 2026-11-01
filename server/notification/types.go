package notification

import (
	"strings"
	"time"
)

// 通知类别常量（可扩展）
// 新增类别只需：在此添加常量 + i18n key + 默认偏好 + 触发点
const (
	CategoryGit    = "git"    // fetch/pull/push
	CategoryTask   = "task"   // 终端长任务完成（含 TaskRunner 和手动命令）
	CategoryClone  = "clone"  // 克隆
	CategorySystem = "system" // 更新/断开/重连
	CategoryError  = "error"  // 文件保存失败等
	CategoryDrop   = "drop"   // 快投递到达（P-20261006-51：手机/脚本 → 工作台的投递收件）
)

// Notification 通知项（全局资源，不绑定特定项目）
type Notification struct {
	ID            string    `json:"id"`
	Type          string    `json:"type"`     // success / warning / error / info
	Category      string    `json:"category"` // git / task / clone / system / error
	Title         string    `json:"title"`
	Body          string    `json:"body,omitempty"`
	Time          time.Time `json:"time"`
	Read          bool      `json:"read"`
	ProjectID     string    `json:"projectId,omitempty"`     // 关联项目（跨项目跳转用）
	ProjectName   string    `json:"projectName,omitempty"`   // 冗余显示用（避免前端反查）
	Action        string    `json:"action,omitempty"`        // terminal / panel / url / preview / watch-fallback / agent-fix / cron-retry（定时任务发起失败一键重试，payload=JSON {cronId,slot}）/ stash-recover（P-20261006-48 切回原分支的 autoStash 一键恢复，前端落档，payload=JSON {projectId,branch,message}）
	ActionPayload string    `json:"actionPayload,omitempty"` // terminal:<sessionId> / panel:<name> / url:<...> / preview:<port> / agent-fix:<deployTaskId>
	// SecondAction/SecondActionPayload 可选第二动作（P-20261005-150）：主动作
	// 旁的第二小钮（通知中心行内副钮，视觉层级弱于主动作）。主动作是单槽且
	// 契约不回退（如部署失败的 agent-fix、哨兵命中的 terminal 直达），第二入口
	// 走本槽位——哨兵命中主动作直达触发会话，第二动作 agent-fix 一键修复
	//（payload=「sentinel:<sessionId>」，前端按前缀分流组装修复上下文）。
	// 旧记录无字段（omitempty）→ 前端不渲染副钮，天然向后兼容零迁移；新生产
	// 方接入需同步 payload 快照与 TS 镜像（server/archguard/payloadfields 契约）
	SecondAction        string `json:"secondAction,omitempty"`
	SecondActionPayload string `json:"secondActionPayload,omitempty"`
	// TaskID 通知关联的部署任务 id（P-20261003-142）：部署终态通知「下载日志」
	// 行内入口的数据锚——Action 是单槽主动作（成功 panel:deploy / 失败
	// agent-fix，P-20261003-289 契约不回退），下载是第二入口走本字段。旧记录
	// 无此字段（omitempty）→ 前端不渲染下载入口，天然向后兼容；新生产方接入
	// 需同步 payload 快照与 TS 镜像（server/archguard/payloadfields 契约）
	TaskID string `json:"taskId,omitempty"`

	// Runtime 产生通知的智能体运行时（P-20261003-187）：runtime 注册名
	//（claude/codex/dsh/shell，AgentApproval.Agent 同一取值域）。审批类通知
	// 天然有发起方 agent 据此透传；任务/克隆等无归属运行时的类别留空。留空
	// 条目不参与前端 runtime 过滤（无归属不受过滤），旧记录无字段同效
	//（omitempty），向后兼容零迁移
	Runtime string `json:"runtime,omitempty"`

	// 模板化文案（P-20261001-30 日报引入）：titleKey/bodyKey 非空时前端优先
	// 按 key + MsgParams 走 i18n 模板渲染（与部署日志 MessageKey/MessageParams
	// 同一惯例），Title/Body 原文保留为无模板消费方（API 直读等）的回退。
	// Body 此时可承载语言中立明细（如提交主题列表），渲染于翻译摘要行之后
	TitleKey  string         `json:"titleKey,omitempty"`
	BodyKey   string         `json:"bodyKey,omitempty"`
	MsgParams map[string]any `json:"msgParams,omitempty"`

	// SnoozeUntil 稍后提醒到期时刻（P-20261003-36）：非 nil 且未到 = 延后中
	//（前端入「已延后」分组可查看/取消，不计未读徽标）；到点由 notify 模块
	// 分钟巡检重挂（置顶+未读+清标记）。指针 + omitempty：绝大多数条目未延后，
	// 值 time.Time 的零值会被 struct omitempty 规则照常序列化成
	// "0001-01-01T00:00:00Z" 噪声字段。字段随记录落盘天然跨重启持久
	SnoozeUntil *time.Time `json:"snoozeUntil,omitempty"`
}

// 外发推送（webhook）模式：GET 模板插值或 POST JSON（Bark/ntfy 均兼容 POST）
const (
	WebhookModeGet  = "get"
	WebhookModePost = "post"
)

// 外发推送事件范围：important = 审批挂起 + 失败/异常类通知（type error/warning，
// 与前端桌面通知的弹出门控同一集合）；all = 全部落库通知
const (
	WebhookScopeImportant = "important"
	WebhookScopeAll       = "all"
)

// WebhookPrefs 外发推送偏好（P-20261002-31）：
// 站内事件 → 手机（Bark/ntfy/自定义接收端）。URL 常含推送密钥，
// 存储态经 config.EncryptIfNeeded 加密（store 层负责），内存/API 态为明文
type WebhookPrefs struct {
	Enabled bool   `json:"enabled"`
	Mode    string `json:"mode"` // WebhookModeGet / WebhookModePost
	// URL GET 模式为模板，支持 {title}/{body} 插值（值按查询参数转义）；
	// POST 模式为纯端点，请求体 JSON {"title":…,"body":…}
	URL string `json:"url"`
	// Scope WebhookScopeImportant（默认）/ WebhookScopeAll
	Scope string `json:"scope"`
}

// Normalized 空模式/范围回退默认值（历史存量偏好无 webhook 字段时零值可用）
func (w WebhookPrefs) Normalized() WebhookPrefs {
	if w.Mode != WebhookModeGet && w.Mode != WebhookModePost {
		w.Mode = WebhookModePost
	}
	if w.Scope != WebhookScopeImportant && w.Scope != WebhookScopeAll {
		w.Scope = WebhookScopeImportant
	}
	return w
}

// Ready 是否具备外发条件（启用且配置了端点）
func (w WebhookPrefs) Ready() bool {
	return w.Enabled && strings.TrimSpace(w.URL) != ""
}

// ProjectMute 项目×类别二维静音项（P-20261003-168）：ProjectID 与 Category
// 都非空才有效（归一在写入端 NormalizeProjectMutes 收口）
type ProjectMute struct {
	ProjectID string `json:"projectId"`
	Category  string `json:"category"`
}

// ProjectMuteMax 静音清单上限：量级是「项目数 × 类别数」的稀疏子集、由用户
// 经条目快捷/设置手动管理，正常远达不到；封顶只防 API 层无界载荷，超出裁
// 先加入的（清单天然按添加序）
const ProjectMuteMax = 200

// Prefs 用户通知偏好（全局）
type Prefs struct {
	Enabled             map[string]bool `json:"enabled"`             // 每类开关
	LongTaskThresholdMs int             `json:"longTaskThresholdMs"` // 长任务判定阈值，默认 5000
	DesktopNotify       bool            `json:"desktopNotify"`       // 是否启用桌面系统通知
	Webhook             WebhookPrefs    `json:"webhook"`             // 外发推送（零值 = 关闭）
	// LongSessionNotifySec agent 长会话正常退出提醒阈值（秒，默认 300 = 5 分钟，
	// P-20261002-140）。存量为该字段出现前落盘的偏好时零值，读端一律经
	// LongSessionThreshold 归一化，写端经 ClampLongSessionSec 钳制
	LongSessionNotifySec int `json:"longSessionNotifySec"`
	// ProjectMutes 项目级静音清单（P-20261003-168）：命中 (projectId, category)
	// 二维组合的通知不入账（与类别开关 AND 同点判定，见 store.Add）。存量偏好
	// 无该字段 → nil = 无静音，向后兼容零迁移
	ProjectMutes []ProjectMute `json:"projectMutes,omitempty"`
	// ClaudeSpendAlertTokens 会话花费阈值告警（P-20261003-157）：Claude 会话
	// 累计 token 用量（P-20261002-139 口径 = input+output+cache_read）达到该
	// 阈值时入账一条「该收尾或接力」通知，每会话一次。0/未配置 = 关（默认，
	// 存量偏好零值即关，向后兼容零迁移）；越界值经 ClampSpendTokens 收敛
	ClaudeSpendAlertTokens int `json:"claudeSpendAlertTokens"`
}

// 长会话提醒阈值边界：下限防误配成「会话一退就提醒」失去长会话语义，
// 上限封顶一天（再长的挂机提醒也无意义）
const (
	// DefaultLongSessionNotifySec 默认阈值：5 分钟（提案锚点）
	DefaultLongSessionNotifySec = 300
	minLongSessionNotifySec     = 10
	maxLongSessionNotifySec     = 24 * 3600
)

// DefaultPrefs 返回默认偏好
func DefaultPrefs() Prefs {
	return Prefs{
		Enabled: map[string]bool{
			CategoryGit:    true,
			CategoryTask:   true,
			CategoryClone:  true,
			CategorySystem: true,
			CategoryError:  true,
			CategoryDrop:   true,
		},
		LongTaskThresholdMs:  5000,
		DesktopNotify:        true,
		Webhook:              WebhookPrefs{Mode: WebhookModePost, Scope: WebhookScopeImportant},
		LongSessionNotifySec: DefaultLongSessionNotifySec,
	}
}

// ClampLongSessionSec 阈值写入钳制（设置 API 写入口共用同一边界，保证 GET
// 回读即合法值）；<=0 视为「回落默认」而非拒绝——部分合并语义下客户端可能
// 原样回传读到的存量零值
func ClampLongSessionSec(sec int) int {
	if sec <= 0 {
		return DefaultLongSessionNotifySec
	}
	if sec < minLongSessionNotifySec {
		return minLongSessionNotifySec
	}
	if sec > maxLongSessionNotifySec {
		return maxLongSessionNotifySec
	}
	return sec
}

// LongSessionThreshold 长会话完成提醒阈值（duration 视图）：存量偏好无该
// 字段时零值回落默认，越界值钳制到写入端同一边界
func (p Prefs) LongSessionThreshold() time.Duration {
	return time.Duration(ClampLongSessionSec(p.LongSessionNotifySec)) * time.Second
}

// 会话花费阈值边界（P-20261003-157）：与长会话阈值不同，本阈值 0 = 关（默认，
// 功能可整体停用）而非回落默认开。下限挡误配（transcript 每轮请求的
// input/cache_read 都计入累计量，正常会话几分钟即过 10 万——更低只有噪声），
// 上限封顶防无意义天文数字
const (
	minSpendAlertTokens = 100_000
	maxSpendAlertTokens = 1_000_000_000_000
)

// ClampSpendTokens 阈值写入钳制（设置 API 写入口共用同一边界，保证 GET 回读
// 即合法值）：<=0 = 关（合法档位，非回落）；0 < n < 下限收敛到下限（部分合并
// 语义下客户端可能回传试探小值）；超上限收敛到上限
func ClampSpendTokens(n int) int {
	if n <= 0 {
		return 0
	}
	if n < minSpendAlertTokens {
		return minSpendAlertTokens
	}
	if n > maxSpendAlertTokens {
		return maxSpendAlertTokens
	}
	return n
}

// IsEnabled 判断某类是否启用（未配置的类别视为启用）
func (p Prefs) IsEnabled(category string) bool {
	v, ok := p.Enabled[category]
	if !ok {
		return true
	}
	return v
}

// IsProjectMuted 判断某项目某类别是否被静音（P-20261003-168；未配置 = 未静音，
// 空 projectId/category 恒 false 与归一化规则对齐）。线性扫描：清单封顶
// ProjectMuteMax，Add 入账路径每次一次纯内存扫描，无 IO，量级可忽略
func (p Prefs) IsProjectMuted(projectID, category string) bool {
	if projectID == "" || category == "" {
		return false
	}
	for _, m := range p.ProjectMutes {
		if m.ProjectID == projectID && m.Category == category {
			return true
		}
	}
	return false
}

// NormalizeProjectMutes 静音清单写入端归一：去空项、去重、封顶裁最旧。API
// 写入口与单测共用同一规则——GET 回读即合法值，读端无需再设防。清空返回 nil
// 而非空切片（JSON omitempty 语义一致，落盘不留空数组噪声）
func NormalizeProjectMutes(mutes []ProjectMute) []ProjectMute {
	if len(mutes) == 0 {
		return nil
	}
	seen := make(map[ProjectMute]struct{}, len(mutes))
	out := make([]ProjectMute, 0, len(mutes))
	for _, m := range mutes {
		m.ProjectID = strings.TrimSpace(m.ProjectID)
		m.Category = strings.TrimSpace(m.Category)
		if m.ProjectID == "" || m.Category == "" {
			continue
		}
		if _, dup := seen[m]; dup {
			continue
		}
		seen[m] = struct{}{}
		out = append(out, m)
		if len(out) == ProjectMuteMax {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
