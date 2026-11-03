package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type ProjectConfig struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
	// Frozen 项目冻结（P-20261003-9）：历史遗留/只读参考项目折入首页列表尾部
	// 弱化分区，跳过 ahead/behind 批量探测；仅影响呈现与探测，配置与重定位信息不删
	Frozen bool `json:"frozen"`
	// Locked 项目硬锁（P-20261004-3）：归档不可变档——置位后文件写族/git 写族/
	// 该项目终端创建一律 403（守卫见 server/middleware/projectlock.go），读面
	// 全放行。与 Frozen 独立可并存（静音+不可变叠加）；注册信息与磁盘内容不动，
	// 解锁即可恢复写。锁定/解锁入口 PUT /api/projects/:id/locked（双向审计）
	Locked bool `json:"locked"`
}

type CommitTemplate struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type Changelist struct {
	Name   string   `json:"name"`
	Files  []string `json:"files"`
	Active bool     `json:"active"`
	// ProjectID 归属项目（P-20261007-19 per-project 化）：变更列表是「某项目的
	// 一批改动」的分组，全局共享会让多项目同名列表与文件归属语义模糊。空 =
	// 存量全局条目（升级兼容：旧配置无该字段反序列化为空，在所有项目可见，
	// 行为同升级前，零迁移）；新建条目由调用方携带当前项目 id。
	ProjectID string `json:"projectId,omitempty"`
}

type Config struct {
	Server       ServerConfig        `json:"server"`
	Proxy        ProxyConfig         `json:"proxy"`
	Changelists  []Changelist        `json:"changelists"`
	OAuthClients []OAuthClientConfig `json:"oauth_clients"`
}

// OAuthClientConfig 用户配置的 OAuth 应用（Device Flow 的 client_id / 可选 secret）
// 同一平台在不同 host 上可有多条（如多个自建 Gitea 实例）
// ClientSecret 使用 enc: 前缀加密存储；Device Flow 通常不需要 secret（Public Client）
type OAuthClientConfig struct {
	Platform     string `json:"platform"` // "github" | "gitea"
	Host         string `json:"host"`     // "github.com" / "gitea.company.com"
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"` // enc: 前缀加密；空表示无 secret
}

// FindOAuthClient 按 platform + host 查找已配置的 OAuth 应用
// host 为空时匹配该 platform 下任意 host（用于 GitHub 官方平台这种无需区分 host 的场景）
func (c *Config) FindOAuthClient(platform, host string) *OAuthClientConfig {
	for i := range c.OAuthClients {
		oc := &c.OAuthClients[i]
		if oc.Platform != platform {
			continue
		}
		if host == "" || oc.Host == host {
			return oc
		}
	}
	return nil
}

// SaveOAuthClient 新增或更新 OAuth Client 配置（按 platform + host 唯一去重）
// client_secret 为空时保留原值（用于"仅改 client_id 不重置 secret"的更新场景）
// 入参 secret 若未加密会自动走 EncryptIfNeeded 加密
func (c *Config) SaveOAuthClient(oc OAuthClientConfig) {
	// 加密 secret（已加密 / 空串原样返回）
	if oc.ClientSecret != "" {
		oc.ClientSecret = EncryptIfNeeded(oc.ClientSecret)
	}
	for i := range c.OAuthClients {
		existing := &c.OAuthClients[i]
		if existing.Platform == oc.Platform && existing.Host == oc.Host {
			existing.ClientID = oc.ClientID
			// 仅当显式传了新 secret 才覆盖（空表示保留原值）
			if oc.ClientSecret != "" {
				existing.ClientSecret = oc.ClientSecret
			}
			return
		}
	}
	c.OAuthClients = append(c.OAuthClients, oc)
}

// DeleteOAuthClient 按 platform + host 删除 OAuth Client 配置
// 返回是否实际删除（用于 handler 区分 404 / 200）
func (c *Config) DeleteOAuthClient(platform, host string) bool {
	for i := range c.OAuthClients {
		if c.OAuthClients[i].Platform == platform && c.OAuthClients[i].Host == host {
			c.OAuthClients = append(c.OAuthClients[:i], c.OAuthClients[i+1:]...)
			return true
		}
	}
	return false
}

// CustomAgent 用户自定义智能体运行时：任意 CLI 智能体工具（gemini/aider 等）
// 自取注册名接入，获得与内置运行时（claude/codex/dsh）一致的体验——
// 新建会话下拉、可用性/版本探测、启动命令覆盖、默认智能体选型全部生效。
// Name 为唯一标识（slug，会话 meta 与 agentLaunchCommands 的 key）；
// DisplayName 为界面展示名（空回落 Name）；Command 为交互模式启动命令行，
// 经 PTY 注入 shell 执行（与手敲等价），首词作为可用性探测的二进制名
type CustomAgent struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Command     string `json:"command"`
}

// FindCustomAgent 按 Name 查找自定义智能体（未配置返回 nil）
func (s *ServerConfig) FindCustomAgent(name string) *CustomAgent {
	for i := range s.CustomAgents {
		if s.CustomAgents[i].Name == name {
			return &s.CustomAgents[i]
		}
	}
	return nil
}

// SaveCustomAgent 新增或更新自定义智能体（按 Name 唯一去重），
// 返回是否为更新已有项（false = 新增）
func (s *ServerConfig) SaveCustomAgent(a CustomAgent) bool {
	for i := range s.CustomAgents {
		if s.CustomAgents[i].Name == a.Name {
			s.CustomAgents[i] = a
			return true
		}
	}
	s.CustomAgents = append(s.CustomAgents, a)
	return false
}

// DeleteCustomAgent 按 Name 删除自定义智能体，返回是否实际删除
func (s *ServerConfig) DeleteCustomAgent(name string) bool {
	for i := range s.CustomAgents {
		if s.CustomAgents[i].Name == name {
			s.CustomAgents = append(s.CustomAgents[:i], s.CustomAgents[i+1:]...)
			return true
		}
	}
	return false
}

type ServerConfig struct {
	Port          int    `json:"port"`
	Host          string `json:"host"`
	AutoFetch     bool   `json:"autoFetch"`
	FetchInterval int    `json:"fetchInterval"` // 秒
	UpdateURL     string `json:"updateURL"`
	// UpdateChecks 自动检查更新开关（P-20261103-1）：true=每 24h 定时检查并在
	// 新版本可用时推通知；false=完全静默（手动检查仍可用）。指针语义省略 = 不动，
	// 默认种子 true。自更新源本身零配置内置（UpdateURLOfficial），本开关只管定时器
	UpdateChecks bool `json:"updateChecks"`
	// UpdateChannel 更新通道（P-20261103-3）：stable=只认最新正式版（默认，
	// 存量缺字段同此）；prerelease=跟进 beta/rc 预发布（GitHub /releases/latest
	// 恒排 prerelease，预发布通道走列表端点取首个含本平台产物的 release）。
	// 合法值仅此二，保存期校验；npm 侧对应 dist-tag latest/next 同构
	UpdateChannel string `json:"updateChannel,omitempty"`
	// ExternalAccessURL 外部访问地址（P-20261019-10）：Tailscale/Cloudflare
	// Tunnel/公网反代接入时的手机可达 origin（scheme+host+可选 port，无路径/
	// query/fragment/凭据）。二维码接力在桌面端以回环地址打开时优先用它，
	// 让手机扫码直达外部入口。空串 = 不启用（存量配置缺字段即此形态，零迁移）；
	// 写路径校验与尾斜杠归一见 config.NormalizeExternalAccessURL
	ExternalAccessURL string `json:"externalAccessUrl,omitempty"`
	// SyncDestRoot 多实例同步的本端落位根（P-20261023-1）：pull/收 push 时项目
	// 目录的默认落位前缀（绝对路径；空 = 用户主目录下 codecombo-sync/）。
	// 非项目投递（deliver）目标必须落在该前缀内——白名单边界即路径穿越防线。
	// 写路径校验见 system.UpdateSettings（仅接受绝对目录路径）
	SyncDestRoot string `json:"syncDestRoot,omitempty"`
	// TrustedProxies 可信反向代理清单（P-20261020-1）：仅当直连对端命中该
	// 列表（IP 或 CIDR）时才采信 X-Forwarded-For / X-Forwarded-Proto /
	// X-Forwarded-Host / X-Real-IP，用于 c.ClientIP() 的限流/审计口径与
	// baseurl 的对外地址推导。**空/缺省 = 不信任任何转发头**（安全默认：
	// Gin 自带默认值是信任所有代理，直连形态下 XFF 可被任意伪造并绕过
	// 每 IP 解锁限流）。反代部署显式配置回环地址，如 ["127.0.0.1","::1"]。
	// 启动期经 middleware.ApplyTrustedProxies 生效，变更需重启；条目写路径
	// 校验见 config.NormalizeTrustedProxies（设置 API 可读写）。
	// 刻意不加 omitempty：显式清空写成 [] 必须能覆盖 config.json 的旧值
	//（nil=未配置 → 回落 config.json；[]=显式不信任，优先级更高）
	TrustedProxies          []string `json:"trustedProxies"`
	TerminalBackend         string   `json:"terminalBackend"`         // 终端后端：auto / tmux / native（默认 auto）
	TerminalScrollbackLines int      `json:"terminalScrollbackLines"` // 终端 scrollback 行数（默认 20000，影响服务端缓冲与前端 xterm.scrollback）
	// TerminalMaxSessions 单进程终端会话上限（P-20261006-12）：0/未配置 = 默认 50
	//（= 可配化之前的硬编码现值，存量行为零变化）。读取端边界见 terminal 包
	// EffectiveMaxSessions：下限护栏 10 防误配、上限软限 200 截断。内存代价按
	// 每会话 1.6~16MB 回放缓冲 + 若干 goroutine 自算（128G 服务器放宽到 200 从容、
	// 16G NAS 建议 30 以内）。服务端资源项归 config 不进 UI 设置（自托管调优
	// 惯例）；启动期一次定值，调整需重启生效
	TerminalMaxSessions int    `json:"terminalMaxSessions,omitempty"`
	TerminalTheme       string `json:"terminalTheme"` // 终端主题名（空串表示"按应用主题映射"，前端默认行为）
	TerminalFont        string `json:"terminalFont"`  // 终端字体：jetbrains / cascadia / ibmplex（默认 jetbrains）
	// 界面密度档（P-20261003-322）：compact（紧凑，列表行高 --row-h 22px）/
	// comfortable（舒适，26px = 历史现状）。空串兼容旧配置走默认；
	// 白名单校验见 system.UpdateSettings
	UIDensity string `json:"uidensity"`
	// 会话启动上下文注入面（P-20261006-47）：新建 agent 会话时自动附带的
	// 「工作台背景资料」多选，逗号分隔取值 git / notes / todos / env（git 状态
	// 摘要 / 项目笔记首段 / TODO 概要 / 项目环境画像，env 为 P-20261007-14 增量）
	// 或 none（全部不注入）；空串兼容旧配置回落 git（= P-176 既有默认行为零变化）。
	// 写路径白名单校验与归一见 system.UpdateSettings / NormalizeSessionContext
	SessionContext string `json:"sessionContext"`
	// 终端命令历史记录开关：指针区分"未配置"（默认开）与"显式关闭"——
	// bool 零值无法区分两者，旧配置文件缺该字段时保持默认开
	TerminalHistoryEnabled *bool `json:"terminalHistoryEnabled,omitempty"`
	// 高危命令粘贴预检开关（P-20261005-191）：指针区分"未配置"（默认开）与
	// "显式关闭"。开启时终端粘贴链与 palette 直达插入链在写入 PTY 前对高危
	// 命令调 POST /api/terminals/command-preview 弹影响面确认卡
	TerminalPastePrecheckEnabled *bool `json:"terminalPastePrecheckEnabled,omitempty"`
	// 远程终端 tmux 持久化开关：指针区分"未配置"（默认关）与"显式开启"。
	// 开启后远程控制台新建终端在远端 tmux 会话中启动（attach-or-create），
	// SSH 通道断开后远端进程与滚动缓冲仍在，重开 tab 重连续工作
	TerminalRemoteTmux *bool `json:"terminalRemoteTmux,omitempty"`
	// AI 助手底层智能体选型：auto（按注册顺序取第一个可用）/ claude / dsh /
	// 自定义注册名（白名单校验见 admin.UpdateSettings；默认 auto）
	AgentProvider string `json:"agentProvider"`
	// AgentNamingNoteEnabled 会话命名系统注记注入开关（P-20261023-3）：带初始
	// prompt 创建 agent 会话时，prompt 尾部自动附一行注记（会话 id= $CC_TERMINAL_ID、
	// 任务演化后用 ≤16 字简称重命名并先查重）——命名从「创建一次定死 + 指望
	// agent 自觉」升级为「派生去重 + 演化注入 + 查重警示」三层中的注入层。指针
	// 区分"未配置"（默认开）与"显式关闭"；旗标形态（--resume）与纯 shell 会话
	// 跳过（无 prompt 可注记 / 注记进 shell 命令行即污染）
	AgentNamingNoteEnabled *bool `json:"agentNamingNoteEnabled,omitempty"`
	// 每运行时的自定义启动命令覆盖（key=运行时注册名，经白名单校验）：
	// 空值回落该运行时的官方默认（Provider.InteractiveCommand）。命令经 PTY
	// 注入 shell 执行（本机用户权限，与用户手敲等价），非空校验 + 长度上限见
	// UpdateSettings。示例：claude → `claude --dangerously-skip-permissions`
	AgentLaunchCommands map[string]string `json:"agentLaunchCommands,omitempty"`
	// 用户自定义智能体运行时列表（任意 CLI 智能体工具自取注册名接入）。
	// 进程启动与每次增删改后经 agentops.SyncCustomAgents 同步进 Provider
	// 注册表——此后选型/白名单/Runtimes 清单与内置运行时走同一条路
	CustomAgents []CustomAgent `json:"customAgents,omitempty"`
	// AgentGuard 智能体令牌高危操作服务端强制审批开关（agentguard 中间件）。
	// 指针区分"未配置"（默认开）与"显式关闭"
	AgentGuard *bool `json:"agentGuard,omitempty"`
	// AgentApprovalMode 高危操作审批档位（AgentGuard 开启时生效，P-20261003-316）：
	// ask=每次询问（默认）；allow-session=会话级放行（仅 AgentSessionAllows 映射内
	// 会话，无会话标识退 ask）；allow-24h=全局放行 24 小时（AgentApprovalExpiresAt
	// 到期自动回 ask）；allow=永久放行（历史「完全允许」，既有值语义不变）。
	// 审批卡「完全允许」三选一切换，设置页可改回。未知值回落 ask
	AgentApprovalMode string `json:"agentApprovalMode,omitempty"`
	// AgentApprovalExpiresAt allow-24h 档位的到期时刻（UTC；零值=无时限）。
	// 到期判定惰性生效（EffectiveApprovalMode 回落 ask），写回 ask 由周期巡检
	// 物化；仅 allow-24h 档位消费该字段，其余档位写路径清零
	AgentApprovalExpiresAt time.Time `json:"agentApprovalExpiresAt,omitempty"`
	// AgentSessionAllows 会话级放行映射（P-20261003-316，仅 allow-session 档位
	// 生效）：key=agent 会话 ID（X-Session-ID 头 / ops-confirm sessionId），
	// value=授予时刻。与档位/规则表同住本 config 文档（规则表同款先例）；
	// 清理三处：授予时裁剪超限、终端会话关闭即时摘除、ai 模块周期巡检兜底裁
	// 死会话。上限 ApprovalMaxSessionAllows
	AgentSessionAllows map[string]time.Time `json:"agentSessionAllows,omitempty"`
	// AgentApprovalRules 审批分类规则（P-20261003-35 per-op 自动裁决）：有序
	// 列表按 op 前缀匹配取首个命中（allow|deny|ask），无命中回落本字段的全局
	// 模式；全局 allow 时规则不评估（全局优先）。判定逻辑与写入口校验见
	// approval_rules.go，规则表 CRUD 在设置·安全分区
	AgentApprovalRules []AgentApprovalRule `json:"agentApprovalRules,omitempty"`
	// CustomSensitivePatterns 自定义敏感模式（P-20261006-11）：用户正则表达的
	// 项目自有 secret 形态清单，敏感逻辑双端同源消费——Go 侧（终端命令历史
	// 整条跳过 / 审计 Detail 入账脱敏 / 快照遮蔽 mask.MaskText 链）与 TS 侧
	//（sensitiveMask 遮蔽链，relay/录制回放等消费点自动并入）各自编译同一
	// 列表。写入口校验与方言纪律见 ValidateCustomSensitivePatterns（RE2/JS
	// 公共子集，禁环视/反向引用/内联旗标/空匹配）；进程内编译注册表在
	// server/mask（SetCustomPatterns，启动期与设置写路径同步）。nil/空列表 =
	// 纯通用表现状零变化（存量配置缺字段即此形态，升级零迁移）
	CustomSensitivePatterns []string `json:"customSensitivePatterns,omitempty"`
	// HookURLAllowHosts 入站 Hook 的 URL 动作允许域（P-20261003-164）：
	// action:"url:<链接>" 仅 http(s) 且 host（url.Hostname() 口径，小写、
	// 不限端口）命中本清单才放行入站（通知动作是前端可执行跳转，域白名单
	// 即外链边界）。**空/缺省 = url 动作整体关闭**（仅 panel:，存量行为零
	// 变化）。归一（小写 hostname、剥端口、去重）与形态校验见
	// config.NormalizeHookURLAllowHosts（设置 API 可读写，保存即时生效——
	// 入站解析每请求现读配置）
	HookURLAllowHosts []string `json:"hookUrlAllowHosts,omitempty"`
	// ApprovalRecording 审批窗口过程实况录制开关（P-20261001-15）：ops-confirm
	// 产生到裁决后短窗口对发起会话开启 PTY tap，录下高危操作前后的屏幕实况
	//（asciinema v2 cast，含模式遮蔽）。指针区分"未配置"（默认关——隐私边界：
	// 屏幕字节流可能含 token/密码类敏感输出，须显式开启）
	ApprovalRecording *bool `json:"approvalRecording,omitempty"`
	// AgentApprovalTimeoutMin pending 审批等待超时自动拒绝的分钟数（P-20261003-45）：
	// 0 = 不超时（默认，存量行为不变）；>0 = pending 超过该时长无人裁决时自动置
	// denied（拒绝理由经 P-21 通道回传发起 agent + approval.resolved 广播 +
	// 通知中心入账）。写入端边界见 UpdateSettings（0 或 1~1440）
	AgentApprovalTimeoutMin int `json:"agentApprovalTimeoutMin,omitempty"`
	// git 网络/重操作类命令（fetch/push/pull/merge/rebase/lfs 等）的兜底超时秒数。
	// 默认 900（<=0 视为未配置）；本地读类命令固定 60s 不受此配置影响。
	// 仅调大容忍慢网络大仓库，不允许关闭兜底（关闭会重演挂起进程/worker 累积）
	GitNetworkTimeoutSec int `json:"gitNetworkTimeoutSec,omitempty"`
	// TerminalIdleTimeoutMin 终端空闲超时自动分离（P-20261003-192）：0/未配置 =
	// 关闭（默认，存量行为零变化）；1~maxTerminalIdleTimeoutMin 有效。无输入
	// 且无输出、且无交互 WS 客户端附着的会话超过该时长后自动分离并通知——
	// 忘记关闭的会话不再永久挂机（PTY 进程/tmux 会话常驻）。存储取分钟粒度
	//（UI 呈现 N 小时档位），同 AgentApprovalTimeoutMin 先例；写入端边界见
	// TerminalIdleTimeoutMinValid，判定与语义差异注记见 terminal/idle.go
	TerminalIdleTimeoutMin int `json:"terminalIdleTimeoutMin,omitempty"`
	// TerminalDefaultShell 终端默认 shell（P-20261004-57）：裸名（沿 PATH 解析）
	// 或完整路径均可；空串/未配置 = 平台缺省序（Windows pwsh→powershell→COMSPEC /
	// unix $SHELL→bash），存量行为零变化。写入端经 LookPath 存在性校验（设置页
	// 400 反馈），读取端（terminal.getShell）失效降级平台缺省不阻塞会话创建。
	// 仅影响新会话；agent 运行时会话的 PTY 底层 shell 同走该缺省（launch 命令
	// 经 shell 注入，bash/pwsh 形态均有效），但会话级覆盖字段对其不生效
	//（运行时自管）
	TerminalDefaultShell string `json:"terminalDefaultShell,omitempty"`
	// AuditRetentionDays 审计日志保留天数（P-20261003-123）：0/未配置 = 默认 30。
	// 合规留档可调长、磁盘紧张可调短（1~3650，写入端边界见 RetentionDaysValid）。
	// 消费点：system 模块每日审计裁剪 ticker + /audit/export 窗口上限——
	// 清理执行时读当前配置，调整次日巡更生效无需重启
	AuditRetentionDays int `json:"auditRetentionDays,omitempty"`
	// UISnapshotEnabled 用户 UI 现场上报开关（P-20261004-52）：前端把「用户此刻
	// 在看哪个项目/文件第几行/哪些面板开着/哪个终端会话在前」低频聚合上报，
	// agent 经 GET /api/ui/snapshot 读取（看着问，不盲问）。指针区分"未配置"
	// （默认**开**——仅位置不内容的隐私边界见手册「用户现场」节）与"显式关闭"
	// （关=上报停止 + 读取端点查无，即时生效）
	UISnapshotEnabled *bool `json:"uiSnapshotEnabled,omitempty"`
	// SensitiveExternalWatch 敏感文件工作台外写入观测开关（P-20261005-15）：文件
	// watcher 检测到磁盘变更时，命中敏感模式清单（share 包确定性模式表）且非工作
	// 台自身写入的路径 → 审计 project.file.external + 通知中心条目。指针区分
	// "未配置"（默认**开**——审计日志记了工作台内一切敏感动作，工作台外的敏感
	// 写入是真实边界盲区，默认可见才有开箱价值；观测只记路径元数据绝不含内容）
	// 与"显式关闭"。生效即时：判定点每条 watcher 事件现读配置，无需重启
	SensitiveExternalWatch *bool `json:"sensitiveExternalWatch,omitempty"`
	// PreviewCompatMode 预览面板同源兼容模式（P-20261019-1）：false/未配置 =
	// 预览 iframe 沙箱隔离（allow-scripts 等最小授权、绝不含 allow-same-origin
	// ——被预览 dev server 的脚本在不透明源运行，读不到主应用 localStorage/
	// 解锁令牌/锁 cookie，也无法同源携带凭据调 /api/*）；true = 回落同源直挂
	//（个别 dev app 依赖同源存储/Service Worker 时的用户显式选择，设置页红色
	// 警示确认）。指针区分"未配置"（默认关 = 沙箱生效，存量配置零迁移安全优先）
	// 与"显式开启"；消费面在 web 前端（PreviewPanel 按档位挂 sandbox 属性），
	// 服务端只承担设置读写与多端广播
	PreviewCompatMode *bool `json:"previewCompatMode,omitempty"`
	// LogRetentionDays 运行日志（DataDir/logs 按天滚动文件）保留天数
	//（P-20261003-123）：0/未配置 = 默认 15。消费点：app 层 dailyHandler
	// 清理（启动 + 每日巡更），同上读当前配置
	LogRetentionDays int `json:"logRetentionDays,omitempty"`
	// dsh（DeepSeek Harness）本机 Web UI 集成：
	// DshWebBase   默认目标（本机 dsh）上游地址（默认 http://127.0.0.1:3080）
	// DshWebToken  本机目标访问令牌（可选）。反代通道下通常无需配置：反代对
	//              无 cookie 的首页首访自动 302 携带当前 token（签发后 dsh 换
	//              30 天 cookie）；直连上游（关闭反代）时才注入 ?token= 查询参数
	// DshProxyPort 嵌入反代监听端口（默认 3081；0 = 关闭反代直连上游，
	//              仅当实测上游未设帧限制时才建议直连）
	// DshExposeAll 反代绑定所有网卡（0.0.0.0）。默认 false = 仅绑 127.0.0.1，
	//              嵌入通道只在 SC 本机浏览器可用且受系统锁保护（默认信任边界）；
	//              开放后 LAN 内浏览器可经 http://<本机>:<DshProxyPort> 直接使用
	//              dsh——通道无 SC 鉴权，开放语义与独立 dsh-web 转发器的 0.0.0.0
	//              暴露一致，需要单独访问时再开。切换即时重绑定监听，无需重启
	// DshLaunchCommand 一键启动命令（空 = dsh web --no-open）。上游未运行时
	//              控制台可一键拉起；stdout 重定向到 DataDir/dsh-web.log，
	//              自动捕获其中 launch token 写回 DshWebToken——dsh 每次启动
	//              换新 token，由此免去手动同步。WSL 场景可配
	//              `wsl.exe dsh web --no-open`
	// DshTargets   手动添加的外部 dsh 目标（跨机场景）：名称/上游地址/令牌可自定义，
	//              与本机目标共用同一嵌入反代通道（cookie 路由区分目标）
	// DshNpmCommand    npm 命令（默认 npm；dsh 在 WSL 时可配 wsl.exe npm）——
	//              版本列表查询与升级安装都经它执行
	// DshRollbackVersion 最近一次升级前的 dsh 版本（回退点；空 = 无回退点，
	//              如独立安装且非 npm 管理的 dsh——升级功能照常可用但回退不可用）。
	//              生命周期：upgrade/prepare 记录，此后保留至下次升级覆盖
	//              （不随升级成功/回退成功清除——语义是「最近一次升级前的版本」，
	//              P-20261010-2 起前端版本弹窗据此常驻回退入口）
	DshWebBase   string `json:"dshWebBase,omitempty"`
	DshWebToken  string `json:"dshWebToken,omitempty"`
	DshProxyPort int    `json:"dshProxyPort"`
	DshExposeAll bool   `json:"dshExposeAll"`
	// DshAllowStandalone 允许独立标签页访问 dsh（裸开反代地址）：指针区分
	// "未配置"（默认**关**——嵌入通道默认仅供 SC 内 iframe 使用，裸开返回
	// 引导页）与"显式开启"，读取走 DshAllowStandaloneOrDefault。守卫是礼貌层
	// 非安全边界：真边界是 dsh 自身令牌；不发 Sec-Fetch 头的浏览器（旧
	// Safari）无法区分、宽容放行
	DshAllowStandalone *bool       `json:"dshAllowStandalone,omitempty"`
	DshLaunchCommand   string      `json:"dshLaunchCommand,omitempty"`
	DshTargets         []DshTarget `json:"dshTargets,omitempty"`
	DshNpmCommand      string      `json:"dshNpmCommand,omitempty"`
	DshRollbackVersion string      `json:"dshRollbackVersion,omitempty"`
	// TLS：默认启用（未配置 = 开）——对外统一经 HTTPS/WSS 提供服务（同端口；
	// 浏览器页面协议自动决定 ws→wss，前端无需任何改动）。cert/key 均为空时
	// 自动生成自签证书（DataDir/certs，ECDSA P-256/10 年，SAN 覆盖
	// localhost/回环/网卡 IP/主机名），浏览器按 TOFU 处理（启动日志输出
	// SHA-256 指纹供核对）。启用期间本机回环另有明文辅助端口（默认主端口+1，
	// 仅绑 127.0.0.1），供 Agent 回调（CC_BASE_URL）与本机 CLI（stop/status）
	// 使用——局域网明文面为零。
	// 关闭方式：设置 tlsEnabled=false / CLI --no-tls / 环境变量 CC_TLS=0。
	// 指针区分"未配置"（默认开）与"显式关闭"——旧配置文件缺该字段时随升级
	// 自动获得 TLS（与 TerminalHistoryEnabled 的指针语义同款）
	TLSEnabled *bool `json:"tlsEnabled,omitempty"`
	// TLSVerifyPeer 实例间互连的 TLS 证书强校验开关（探测/代理/从中心更新
	// 等实例间 HTTPS 出站连接的客户端侧校验）。指针区分"未配置"与"显式关闭"：
	//   未配置(nil) / false = 跳过对端证书校验（内网自签直达，免去信任库导入）
	//   true                = 走系统信任库严格校验（需将对端 certs/cert.pem 装入
	//                         本机信任库，见部署文档"实例互联 TLS"一节）
	// 仅影响实例间互连；公网更新源（GitHub）下载始终严格校验不受此开关控制
	TLSVerifyPeer *bool `json:"tlsVerifyPeer,omitempty"`
	// TLSCertFile / TLSKeyFile 自定义证书对（成对配置；双空 = 自动生成自签）
	TLSCertFile string `json:"tlsCertFile,omitempty"`
	TLSKeyFile  string `json:"tlsKeyFile,omitempty"`
	// SharePort 文件分享子服务端口（0 = 默认主端口+2）。独立于主服务端口，
	// 专门对外提供文件/目录分享的预览与下载；主端口+1 留给 TLS 明文回环
	// 辅助口，互不冲突
	SharePort int `json:"sharePort,omitempty"`
	// ShareDefaultTTL 新建文件分享（live 活视图）的默认有效期档位
	//（P-20261020-5）："" / "permanent" = 永久（缺省，存量行为零变化）；
	// "1d" / "7d" / "30d" = 创建请求未显式选择有效期时按创建时刻起算。
	// 仅作用于 live 文件/目录分享：frozen 维持 store.FrozenTTL 30 天默认，
	// snippet/terminal/cast/session 各有固定窗口，均不受此键影响。
	// 写路径白名单见 system.UpdateSettings；读取端脏值收敛 permanent
	ShareDefaultTTL string `json:"shareDefaultTTL,omitempty"`
	// SharePublicBaseURL 分享链接外发基址（P-20261020-2）：分享 URL =
	// 该 origin + /s/<token>。反代/内置隧道只转发主端口、分享子服务第二端口
	// 不可达时，用它把链接指到外部入口；空串 = 不启用，前端按「外部访问地址 >
	// 当前非回环 host > 局域网候选 > 分享子服务端口」自动选址（存量形态零变化）。
	// 写路径校验与尾斜杠归一见 config.NormalizeSharePublicBaseURL（仅 http/https
	// origin；只作拼链内容，不做重定向）。omitempty 保证旧配置缺字段即空值。
	SharePublicBaseURL string `json:"sharePublicBaseUrl,omitempty"`
	// LoopbackPort TLS 明文回环辅助端口（0 = 默认主端口+1）。主端口+1 被
	// 第三方软件占用（网盘/VPN 类常驻服务）时在此改道，不必更换主端口
	LoopbackPort int `json:"loopbackPort,omitempty"`
	// HTTPPort 明文伴随端口（仅 TLS 启用时生效）。指针三态：
	//   未配置(nil)  = 默认开启，端口主端口+3（避开回环口+1、分享口+2）——
	//                  深度检测类设备拖慢 TLS 的网络开箱即有 http 访问面
	//   0 / 负数     = 显式关闭
	//   正数         = 指定端口
	// 该口凭据明文传输，关闭方式即配 "httpPort": 0
	HTTPPort *int `json:"httpPort,omitempty"`
	// UserPrefs 用户偏好层漫游单键（P-20261007-1 Settings Sync）：分轨原则下
	// 「跟人走」的用户偏好（键位覆盖/通知三件/终端复制选中/终端主题跟随）以
	// 稀疏偏差集存此处，schema 前端自治（服务端仅合法 JSON + ≤64KB 两道校验，
	// 见 userprefs.go）——后续新增偏好键零 Go 改动；经 PUT /api/settings 的
	// userPrefs 字段指针式更新（省略 = 不动），GET 带出 + settings.changed
	// 广播多端跟随。nil/缺字段 = 服务端无漫游偏好（前端回落本地镜像并播种），
	// 存量配置升级零迁移。设备偏好（字号/缩放/光标等 per-device 立场）刻意
	// 不进本键，仍留浏览器 localStorage
	UserPrefs json.RawMessage `json:"userPrefs,omitempty"`
	// RemoteAccess 远程接入（SSH 反向隧道，P-20261019-11）：用户自带 VPS
	// 中继的档案列表 + 当前激活项 + 启用开关。nil/缺字段 = 未配置（存量配置
	// 升级零迁移、隧道不启用）；同一时刻仅一条隧道在线（多档案 + 单活 +
	// 一键切换），结构为未来多活留纯增量扩展位。凭据加密与字段校验见
	// config/remoteaccess.go
	RemoteAccess *RemoteAccessConfig `json:"remoteAccess,omitempty"`
}

// TerminalHistoryEnabledOrDefault 命令历史开关（未配置默认开启）
func (sc *ServerConfig) TerminalHistoryEnabledOrDefault() bool {
	if sc.TerminalHistoryEnabled == nil {
		return true
	}
	return *sc.TerminalHistoryEnabled
}

// TerminalPastePrecheckEnabledOrDefault 高危命令粘贴预检开关（P-20261005-191，
// 未配置默认开启）：终端粘贴链/palette 直达插入链在写入 PTY 前对高危命令
// （rm -rf/git reset --hard/覆盖重定向…）弹影响面确认卡。知情确认属安全
// 默认面，关闭即回到「直接入 PTY 零提示」的历史行为
func (sc *ServerConfig) TerminalPastePrecheckEnabledOrDefault() bool {
	if sc.TerminalPastePrecheckEnabled == nil {
		return true
	}
	return *sc.TerminalPastePrecheckEnabled
}

// AgentNamingNoteEnabledOrDefault 会话命名系统注记注入开关（P-20261023-3，
// 未配置默认开启）：读端统一收口，创建漏斗（LaunchAgentSessionWithShell）
// 与 GET /settings 同源取值
func (sc *ServerConfig) AgentNamingNoteEnabledOrDefault() bool {
	if sc.AgentNamingNoteEnabled == nil {
		return true
	}
	return *sc.AgentNamingNoteEnabled
}

// UISnapshotEnabledOrDefault 用户 UI 现场上报开关（未配置默认开启——隐私边界
// 是「仅位置不内容」而非隐藏，默认开才有「agent 看着问」的开箱价值；关闭即
// 双侧收敛：上报停止 + 读取端点查无）
func (sc *ServerConfig) UISnapshotEnabledOrDefault() bool {
	if sc.UISnapshotEnabled == nil {
		return true
	}
	return *sc.UISnapshotEnabled
}

// SensitiveExternalWatchOrDefault 敏感文件工作台外写入观测开关（未配置默认
// 开启——工作台外敏感写入是审计链的既有盲区，默认补齐可见性；关闭即观测
// 静默，审计/通知均不再产生，即时生效无需重启）
func (sc *ServerConfig) SensitiveExternalWatchOrDefault() bool {
	if sc.SensitiveExternalWatch == nil {
		return true
	}
	return *sc.SensitiveExternalWatch
}

// TerminalRemoteTmuxOrDefault 远程终端 tmux 持久化开关（未配置默认关闭）
func (sc *ServerConfig) TerminalRemoteTmuxOrDefault() bool {
	if sc.TerminalRemoteTmux == nil {
		return false
	}
	return *sc.TerminalRemoteTmux
}

// PreviewCompatModeOrDefault 预览面板同源兼容模式（P-20261019-1，未配置默认关
// = 沙箱隔离生效）：读端统一收口，GET /settings 与前端镜像同源取值
func (sc *ServerConfig) PreviewCompatModeOrDefault() bool {
	if sc.PreviewCompatMode == nil {
		return false
	}
	return *sc.PreviewCompatMode
}

// UIDensityOrDefault 界面密度档（P-20261003-322，未配置/未知值默认 comfortable
// = 历史现状零变化；未知值收敛默认而非报错——读取路径不做白名单拒绝）
func (sc *ServerConfig) UIDensityOrDefault() string {
	if sc.UIDensity == "compact" {
		return "compact"
	}
	return "comfortable"
}

// SessionContext 会话启动上下文的多选合法取值（写路径白名单与读取端归一同一份清单）。
// env（项目环境画像，P-20261007-14）追加在尾：存量设置串规范序不变，升级零迁移
var sessionContextTokens = []string{"git", "notes", "todos", "env"}

// ValidSessionContextToken 写路径白名单谓词：与 NormalizeSessionContext 共用
// sessionContextTokens 单一清单（settings API 的 token 校验不再手抄一份，
// 新增注入源只改这里一处）
func ValidSessionContextToken(tok string) bool {
	tok = strings.TrimSpace(tok)
	for _, valid := range sessionContextTokens {
		if tok == valid {
			return true
		}
	}
	return false
}

// NormalizeSessionContext 会话启动上下文归一（P-20261006-47）：空串 = 未配置，
// 回落 "git"（P-176 既有默认行为零变化，存量配置升级零迁移）；"none" = 显式全关；
// 其余按合法 token 过滤 + 规范序去重重排（写路径已白名单拒绝非法值，此处兜
// 手改配置文件的脏值）；一个合法 token 都没有的显式脏值收敛 "none"——读不懂
// 的显式配置不猜测用户意图，宁可少注入也不塞未要求的上下文
func NormalizeSessionContext(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "git"
	}
	if raw == "none" {
		return "none"
	}
	parts := strings.Split(raw, ",")
	want := make(map[string]bool, len(parts))
	for _, p := range parts {
		want[strings.TrimSpace(p)] = true
	}
	kept := make([]string, 0, len(sessionContextTokens))
	for _, tok := range sessionContextTokens {
		if want[tok] {
			kept = append(kept, tok)
		}
	}
	if len(kept) == 0 {
		return "none"
	}
	return strings.Join(kept, ",")
}

// SessionContextOrDefault 会话启动上下文设置出参（GET /settings 与消费端同一份归一）
func (sc *ServerConfig) SessionContextOrDefault() string {
	return NormalizeSessionContext(sc.SessionContext)
}

// DshAllowStandaloneOrDefault 独立标签页访问 dsh 开关（未配置默认**关闭**——
// 嵌入通道默认仅供 SC 内使用，裸开反代地址返回引导页；需要独立访问在设置中显式开启）
func (sc *ServerConfig) DshAllowStandaloneOrDefault() bool {
	if sc.DshAllowStandalone == nil {
		return false
	}
	return *sc.DshAllowStandalone
}

// TLSEnabledOrDefault 传输加密开关（未配置默认**启用**）：
// 局域网部署的默认安全面是加密 + 自签 TOFU，明文需显式关闭
func (sc *ServerConfig) TLSEnabledOrDefault() bool {
	if sc.TLSEnabled == nil {
		return true
	}
	return *sc.TLSEnabled
}

// TLSVerifyPeerOrDefault 实例间 TLS 证书强校验开关（未配置默认**关闭**）：
// 关闭时实例间 HTTPS 出站连接跳过对端证书校验（自签直达，免去信任库导入），
// 开启后走系统信任库严格校验（对端证书需装入本机信任库）
func (sc *ServerConfig) TLSVerifyPeerOrDefault() bool {
	if sc.TLSVerifyPeer == nil {
		return false
	}
	return *sc.TLSVerifyPeer
}

// loopbackPort TLS 启用时的明文回环辅助端口（仅绑 127.0.0.1，主端口+1）。
// Agent 回调（CC_BASE_URL）与本机 CLI（stop/status）专用——自签证书下
// curl/fetch 默认拒绝握手，回环明文端口让 Agent/CLI 工作流零改动。
// 0 表示 TLS 未启用或辅助监听未就绪
var loopbackPort atomic.Int32

// SetLoopbackPort 由 app 启动序列在辅助监听就绪后调用
func SetLoopbackPort(p int) { loopbackPort.Store(int32(p)) }

// LoopbackPort 返回明文回环辅助端口（0 = TLS 未启用或未就绪）
func LoopbackPort() int { return int(loopbackPort.Load()) }

// tlsEnabled 主服务是否以 TLS（https/wss）对外服务。嵌入类子系统（dsh 反代）
// 据此对齐自身对外协议：iframe 与顶层页面同 scheme 才构成 schemeful 同站，
// dsh 的 SameSite=Strict 会话 cookie 才会在 iframe 内携带（https 页面嵌
// http iframe 被判跨站，cookie 永不携带，实测换发→401 鉴权页/补签死循环）
var tlsEnabled atomic.Bool

// SetTLSEnabled 由 app 启动序列在 TLS 状态解析后调用
func SetTLSEnabled(v bool) { tlsEnabled.Store(v) }

// TLSEnabled 主服务对外协议是否为 https
func TLSEnabled() bool { return tlsEnabled.Load() }

// SharePortOrDefault 分享子服务端口（未配置 = 主端口+2）
func (sc *ServerConfig) SharePortOrDefault(mainPort int) int {
	if sc.SharePort > 0 {
		return sc.SharePort
	}
	return mainPort + 2
}

// ShareTTLDuration 分享有效期预设档位 → 时长（P-20261020-5）。创建请求的
// ttl 字段与设置页的 shareDefaultTTL 共用同一张档位表；"permanent" 永久与
// 未知档位返回 ok=false（调用方按「无正值」处理）。30d 与 store.FrozenTTL
// 同值——frozen 默认窗口可在创建时被显式选择覆盖
func ShareTTLDuration(ttl string) (time.Duration, bool) {
	switch strings.TrimSpace(ttl) {
	case "1h":
		return time.Hour, true
	case "1d":
		return 24 * time.Hour, true
	case "7d":
		return 7 * 24 * time.Hour, true
	case "30d":
		return 30 * 24 * time.Hour, true
	default:
		return 0, false
	}
}

// ValidShareDefaultTTL shareDefaultTTL 写入端白名单：空串 / permanent =
// 永久（缺省），1d/7d/30d 为可选默认档。1h 只在单次创建时可选——把它设为
// 全局默认会让「忘了改」的普通分享默认一小时即失效，超出任务书的默认档集合
func ValidShareDefaultTTL(v string) bool {
	switch strings.TrimSpace(v) {
	case "", "permanent", "1d", "7d", "30d":
		return true
	default:
		return false
	}
}

// ShareDefaultTTLOrDefault shareDefaultTTL 读取端归一：未配置/脏值一律回落
// permanent（与 UIDensityOrDefault「未知值收敛默认而非报错」同款——读取路径
// 不做白名单拒绝）。白名单与写入端共用 ValidShareDefaultTTL：手工改配置塞进
// 1h 同样回落 permanent——1h 只是单次创建的临时档，不该因绕过 PUT 校验成为
// 所有新分享的持续时间
func (sc *ServerConfig) ShareDefaultTTLOrDefault() string {
	v := strings.TrimSpace(sc.ShareDefaultTTL)
	if ValidShareDefaultTTL(v) && v != "" {
		return v
	}
	return "permanent"
}

// HTTPPortOrDefault 明文伴随端口（仅 TLS 启用时调用）：
// 返回端口与是否启用。未配置 = 主端口+3 默认开启；
// 显式 0/负数 = 关闭；正数 = 指定端口
func (sc *ServerConfig) HTTPPortOrDefault(mainPort int) (port int, enabled bool) {
	if sc.HTTPPort == nil {
		return mainPort + 3, true
	}
	if *sc.HTTPPort <= 0 {
		return 0, false
	}
	return *sc.HTTPPort, true
}

// sharePort 分享子服务的实际监听端口（分享页短链拼接用；
// 0 = 未就绪或启动失败）
var sharePort atomic.Int32

// SetSharePort 由分享模块在监听就绪后调用
func SetSharePort(p int) { sharePort.Store(int32(p)) }

// RuntimeSharePort 返回分享子服务实际端口（0 = 未就绪）
func RuntimeSharePort() int { return int(sharePort.Load()) }

// ProxyConfig 代理可配置参数
type ProxyConfig struct {
	DefaultTimeout int `json:"defaultTimeout"` // 默认超时秒数，30
	LongTimeout    int `json:"longTimeout"`    // 长操作超时秒数，300
	IdleTimeout    int `json:"idleTimeout"`    // 流式空闲超时秒数，60
	MaxConcurrency int `json:"maxConcurrency"` // 每实例最大并发，50
	MaxIdleConns   int `json:"maxIdleConns"`   // 连接池大小，10
}

// DefaultProxyConfig 返回默认代理配置
func defaultProxyConfig() ProxyConfig {
	return ProxyConfig{
		DefaultTimeout: 30,
		LongTimeout:    300,
		IdleTimeout:    60,
		MaxConcurrency: 50,
		MaxIdleConns:   10,
	}
}

// GetProxyConfig 获取代理配置，未配置时返回默认值
func GetProxyConfig() ProxyConfig {
	cfgMu.Lock()
	pc := cfg.Proxy
	cfgMu.Unlock()
	if pc.DefaultTimeout == 0 {
		return defaultProxyConfig()
	}
	return pc
}

var (
	cfg     *Config
	cfgOnce sync.Once
	cfgMu   sync.Mutex
)

func configFile() string {
	return filepath.Join(DataDir(), "config.json")
}

// DataDir 返回运行时数据目录
// 优先级：CC_DATA_DIR 环境变量 > SC_DATA_DIR 环境变量（旧名兼容双读一个版本期，
// 移除时点见 datamigrate.go 头注）> ~/.codecombo 默认路径
// helper 子进程通过继承数据目录 env 定位与主进程同一份 master-key / 凭据存储
//
// 旧名回落会被 LegacyEnvUsed 记账（P-20261025-1）：启动面据此输出「使用了 SC_
// 旧名回落」告警，防外部脚本/远端 unit 静默回落造成数据面分叉的假象
func DataDir() string {
	if d := os.Getenv("CC_DATA_DIR"); d != "" {
		return d
	}
	if d := os.Getenv("SC_DATA_DIR"); d != "" {
		legacyEnvUsed.Store(true)
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// 回退到当前目录
		return ".codecombo"
	}
	return filepath.Join(home, ".codecombo")
}

// legacyEnvUsed 本进程是否发生过 SC_DATA_DIR 旧名回落（原子记账，测试可复位）
var legacyEnvUsed atomic.Bool

// LegacyEnvUsed 报告本进程是否使用过 SC_DATA_DIR 旧名回落（启动告警消费）
func LegacyEnvUsed() bool { return legacyEnvUsed.Load() }

// LegacyDefaultDir 返回旧版默认数据目录（~/.simple-coding；主目录不可得时
// 返回空串 = 无迁移可能）。仅数据目录迁移引擎（datamigrate.go）与 CLI 的
// pid 文件兼容查找消费，业务路径一律走 DataDir()
func LegacyDefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".simple-coding")
}

// UpdateURLOfficial 官方发布仓（P-20261103-1 零配置自更新的内置默认源）。
// 首启/存量缺字段即预填——检查更新对 api.github.com 发一次 GET（phone-home
// 披露：不希望联网检查的用户在设置里清空 updateURL 即关，语义与历史空值一致）；
// fork/自建源在设置里覆盖。仅作 defaultConfig 种子，不参与运行时回填
const UpdateURLOfficial = "https://github.com/wtr20211202/codecombo"

// defaultConfig 默认种子（Load 初始化、损坏降级复位与 Get 兜底共用同一份，
// 防三处字面量漂移）
func defaultConfig() *Config {
	return &Config{
		Server: ServerConfig{
			Port:          9999,
			Host:          "127.0.0.1",
			UpdateURL:     UpdateURLOfficial,
			UpdateChecks:  true,
			UpdateChannel: "stable",
		},
		// Default 种子条目 Active:false（P-20261007-19 起 active 是消费中的 UI 态：
		// 活跃组高亮+过滤目标；种子恒活跃会让每个项目都看到无文件的活跃组）
		Changelists: []Changelist{{Name: "Default", Files: []string{}, Active: false}},
	}
}

func Load() *Config {
	cfgOnce.Do(func() {
		// 确保数据目录存在（0700：目录内存 master-key、SSH 私钥、凭据等敏感数据，
		// 多用户主机上不允许同机其他用户进入）
		_ = os.MkdirAll(DataDir(), 0700)
		_ = os.MkdirAll(filepath.Join(DataDir(), "data"), 0700)

		cfg = defaultConfig()

		path := configFile()
		data, err := os.ReadFile(path)
		switch {
		case err == nil:
			if uerr := json.Unmarshal(data, cfg); uerr != nil {
				// 损坏分支显式化（P-20261006-10，机制与降级链见 corrupt.go）：
				// 部分类型错误场景 unmarshal 可能已污染字段，整体收敛回默认
				// 种子再保全+登记，保证「损坏 ⟹ 默认配置启动」语义干净
				*cfg = *defaultConfig()
				preserved := quarantineCorruptConfig(path)
				corruptState.Store(&ConfigCorruption{
					Path:          path,
					PreservedPath: preserved,
					Err:           uerr.Error(),
				})
				slog.Warn("config.json corrupt — starting with defaults",
					"path", path, "preserved", preserved, "err", uerr)
			}
		case errors.Is(err, fs.ErrNotExist):
			// 文件不存在 = 正常首启（既有正确路径，零变化）
		default:
			// 其余读失败（权限/IO 等）：同样以默认配置启动，原状静默跳过改为
			// 留痕——用户应当知道配置未生效（不保全不登记：读不到 ≠ 损坏，
			// 文件可能完好，改名反而毁现场）
			slog.Warn("config.json unreadable — starting with defaults",
				"path", configFile(), "err", err)
		}

		// 执行数据迁移（如有必要）
	})
	return cfg
}

func Get() *Config {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	if cfg == nil {
		cfg = defaultConfig()
	}
	return cfg
}

func save() error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	path := configFile()
	tmp := path + ".tmp"
	// 0600：config 内含 OAuth client secret 密文与部署配置，
	// 与 master-key/token-salt 同级敏感（历史 0644 在宽松 umask 下组/其他可读）
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Save 持久化当前 config 到磁盘（handler 改 OAuthClients 后调用）
// 调用方应已通过 Load/Get 持有最新 cfg 指针
func Save() error {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return save()
}

// ResetForTest 重置 config 单例与 master-key 缓存——仅供测试用
// 必须配合 t.Setenv("CC_DATA_DIR", t.TempDir()) 使用，确保每个测试用例隔离
func ResetForTest() {
	cfgMu.Lock()
	cfg = nil
	cfgOnce = sync.Once{}
	cfgMu.Unlock()
	// 同时重置 master-key 单例，让新 CC_DATA_DIR 重新加载/生成
	masterKeyOnce = sync.Once{}
	masterKey = nil
	// 损坏降级态随单例一并重置（P-20261006-10）：防上一用例的登记泄漏进
	// 后续用例的 CorruptionReport 断言
	corruptState.Store(nil)
	// 旧名回落记账随用例重置（P-20261025-1）：防 SC_ 回落标记跨用例泄漏
	legacyEnvUsed.Store(false)
}

// SetOAuthClientForTest 直接写入一个 OAuth Client（测试辅助）——仅供测试用
// 入参 oc.ClientSecret 不强制要求 enc: 前缀，调用方按需传入
func SetOAuthClientForTest(oc OAuthClientConfig) {
	c := Load()
	c.OAuthClients = append(c.OAuthClients, oc)
	_ = Save()
}

func (c *Config) GetChangelists() []Changelist {
	return c.Changelists
}

// AddChangelist 新建变更列表（作用域内重名拒绝，返回是否新建）：作用域内的
// 名字唯一是「按名切换活跃/移入文件」可用前提（同名条目会让这些操作歧义）；
// 跨作用域（不同项目/全局）允许同名
func (c *Config) AddChangelist(name string, projectID string) bool {
	for i := range c.Changelists {
		if c.Changelists[i].Name == name && c.Changelists[i].ProjectID == projectID {
			return false
		}
	}
	c.Changelists = append(c.Changelists, Changelist{
		Name:      name,
		Files:     []string{},
		Active:    false,
		ProjectID: projectID,
	})
	_ = save()
	return true
}

func (c *Config) RemoveChangelist(name string, projectID string) {
	for i, cl := range c.Changelists {
		if cl.Name == name && cl.ProjectID == projectID && name != "Default" {
			c.Changelists = append(c.Changelists[:i], c.Changelists[i+1:]...)
			_ = save()
			return
		}
	}
}

// SetActiveChangelist 切换活跃列表：仅同作用域内互斥（激活项目 A 的列表不动
// 项目 B 的活跃态——多项目并行「各自有正在做的组」是分组语义的本意）
func (c *Config) SetActiveChangelist(name string, projectID string) {
	for i := range c.Changelists {
		if c.Changelists[i].ProjectID != projectID {
			continue
		}
		c.Changelists[i].Active = c.Changelists[i].Name == name
	}
	_ = save()
}

// AddFileToChangelist 把文件移入指定列表：文件在同一作用域内至多属于一个列表
// （移动即从同域其他列表摘除）；不同作用域的列表互不相干
func (c *Config) AddFileToChangelist(clName string, file string, projectID string) {
	for i := range c.Changelists {
		if c.Changelists[i].Name == clName && c.Changelists[i].ProjectID == projectID {
			for _, f := range c.Changelists[i].Files {
				if f == file {
					return
				}
			}
			c.Changelists[i].Files = append(c.Changelists[i].Files, file)
			// 从同作用域的其他 changelist 中移除
			for j := range c.Changelists {
				if j != i && c.Changelists[j].ProjectID == projectID {
					c.Changelists[j].Files = removeFromFileList(c.Changelists[j].Files, file)
				}
			}
			_ = save()
			return
		}
	}
}

func removeFromFileList(files []string, target string) []string {
	for i, f := range files {
		if f == target {
			return append(files[:i], files[i+1:]...)
		}
	}
	return files
}

func (c *Config) RemoveFileFromChangelist(clName string, file string, projectID string) {
	for i := range c.Changelists {
		if c.Changelists[i].Name == clName && c.Changelists[i].ProjectID == projectID {
			c.Changelists[i].Files = removeFromFileList(c.Changelists[i].Files, file)
			_ = save()
			return
		}
	}
}

// VisibleChangelists 作用域可见集：归属 projectID 的条目 + 存量全局条目
// （ProjectID 空，升级兼容在所有项目可见）。查询面单一入口，handler 与后续
// 消费方共用同一口径
func (c *Config) VisibleChangelists(projectID string) []Changelist {
	visible := make([]Changelist, 0, len(c.Changelists))
	for _, cl := range c.Changelists {
		if cl.ProjectID == "" || cl.ProjectID == projectID {
			visible = append(visible, cl)
		}
	}
	return visible
}

// AgentGuardOrDefault 服务端强制审批开关（默认开）
func (c *ServerConfig) AgentGuardOrDefault() bool {
	return c.AgentGuard == nil || *c.AgentGuard
}

// AgentApprovalModeStored 存量档位归一（不感知时间）：四档白名单之外（含空串
// 与历史脏值）回落 ask——旧行为兜底。设置 GET 出参展示与写路径判断用
func (c *ServerConfig) AgentApprovalModeStored() string {
	switch c.AgentApprovalMode {
	case ApprovalModeAllowSession, ApprovalModeAllow24h, ApprovalModeAllow:
		return c.AgentApprovalMode
	default:
		return ApprovalModeAsk
	}
}

// EffectiveApprovalMode 有效档位（时间感知判定，P-20261003-316 收敛出口）：
// allow-24h 到期（含脏数据缺到期时刻）惰性回落 ask——纯判定不回写文档（读路径
// 禁止写盘副作用红线），物化由 ai 模块周期巡检兜底；其余档位原样返回
func (c *ServerConfig) EffectiveApprovalMode(now time.Time) string {
	mode := c.AgentApprovalModeStored()
	if mode == ApprovalModeAllow24h &&
		(c.AgentApprovalExpiresAt.IsZero() || !now.Before(c.AgentApprovalExpiresAt)) {
		return ApprovalModeAsk
	}
	return mode
}

// ApprovalRecordingOrDefault 审批窗口过程实况录制开关（默认关——隐私边界，
// 与默认开的 AgentGuard 相反：证据录制涉及敏感输出落盘，必须显式开启）
func (c *ServerConfig) ApprovalRecordingOrDefault() bool {
	return c.ApprovalRecording != nil && *c.ApprovalRecording
}

// AgentApprovalTimeoutMinValid 超时分钟数写入端边界：0 = 不超时（合法，存量
// 行为）；1~maxApprovalTimeoutMin 有效；越界返回 false 供写入端拒绝。下限 1
// 防「配了却永远扫不到」的负配置，上限封顶一天（更长的等待应走完全允许模式）
const maxApprovalTimeoutMin = 1440

func AgentApprovalTimeoutMinValid(mins int) bool {
	return mins == 0 || (mins >= 1 && mins <= maxApprovalTimeoutMin)
}

// TerminalIdleTimeoutMinValid 终端空闲超时分钟数写入端边界（P-20261003-192）：
// 0 = 关闭（默认，合法，存量行为零变化）；1~maxTerminalIdleTimeoutMin 有效；
// 越界返回 false 供写入端拒绝。上限封顶 30 天（43200 分钟）——「空闲回收」
// 超过一个月已无边界意义，防手滑超大值让功能名存实亡；下限 1 分钟主要为
// e2e/测试注入档（UI 档位以小时起步），生产合理档位在小时量级
const maxTerminalIdleTimeoutMin = 43200

func TerminalIdleTimeoutMinValid(mins int) bool {
	return mins == 0 || (mins >= 1 && mins <= maxTerminalIdleTimeoutMin)
}

// 保留期可配边界（P-20261003-123）：审计/运行日志保留天数的默认值与写入端
// 上限。默认值 = 可配化之前的硬编码现值（存量兼容：旧配置缺字段即现行为）；
// 上限 10 年封顶合规留档场景——更长的留存磁盘责任自负（设置页注记）且几乎
// 无消费面，防手滑超大值让清理语义名存实亡
const (
	DefaultAuditRetentionDays = 30
	DefaultLogRetentionDays   = 15
	MaxRetentionDays          = 3650
)

// RetentionDaysValid 保留天数写入端边界：0 = 回落默认（合法，存量行为）；
// 1~3650 显式有效；负数/越界返回 false 供写入端拒绝
func RetentionDaysValid(days int) bool {
	return days == 0 || (days >= 1 && days <= MaxRetentionDays)
}

// AuditRetentionDaysOrDefault 审计保留天数（未配置/脏值回落默认 30）
func (sc *ServerConfig) AuditRetentionDaysOrDefault() int {
	return orDefaultRetentionDays(sc.AuditRetentionDays, DefaultAuditRetentionDays)
}

// LogRetentionDaysOrDefault 运行日志保留天数（未配置/脏值回落默认 15）
func (sc *ServerConfig) LogRetentionDaysOrDefault() int {
	return orDefaultRetentionDays(sc.LogRetentionDays, DefaultLogRetentionDays)
}

// orDefaultRetentionDays 读取侧防御：越界/负值一律回落默认（与
// UIDensityOrDefault「未知值收敛默认而非报错」同款——读取路径不做白名单拒绝）
func orDefaultRetentionDays(days, def int) int {
	if days >= 1 && days <= MaxRetentionDays {
		return days
	}
	return def
}

// DshTarget 手动添加的外部 dsh 目标（跨机场景）：与"本机 dsh"（DshWebBase 等
// 字段描述的默认目标）共用同一嵌入反代通道，按 cookie 路由区分。
type DshTarget struct {
	ID    string `json:"id"`              // 随机 hex；前端选择器与代理路由的稳定键
	Name  string `json:"name"`            // 展示名（用户自定义，便于区分多实例）
	Base  string `json:"base"`            // 上游地址（http://host:port，保存时规整去尾斜杠）
	Token string `json:"token,omitempty"` // 访问令牌（可选；dsh 0.1.2+ 每次启动轮换）
}
