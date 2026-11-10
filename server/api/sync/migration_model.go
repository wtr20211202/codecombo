package sync

import (
	"time"

	"codecombo/server/config"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 换机迁移——实例配置包导出/导入（P-20261003-147）。
//
// 单包单口令整机迁移：配置四块（凭据/令牌族/系统设置/实例注册表）+ 可选内容
// 全量包（复用 sync packUnitsInto/landZipReader 引擎）。双模：
//   - light  KB~MB 级亚秒，v1 单发信封（config.EncryptWithPassphraseFormat）
//   - full   GB 级流式，v2 分块信封（config.ChunkedEnvelopeWriter）+ zip
//            明文载荷（payload.json + sync 单元布局 u<i>/）
//
// 安全边界（与 remotehost 导出同族）：明文头仅格式/版本/KDF 参数/模式，摘要
// （主机名/时刻/块清单）在密文体；口令永不过 agent 通道（手册登记引导用户到
// 设置界面）；错口令与文件损坏统一失败文案（errmarkers.WrongPassphraseExport）。
// 明文凭据只在包内存在：导出侧把 enc: 态解成明文进包（包整体口令加密），
// 导入侧重落盘时按本机机器密钥重新加密——enc: 密文本身不可跨机（master-key
// 是本机 material）。

const (
	// migrationPayloadSchema 明文载荷 schema 标识（导入端校验，防拿错信封）
	migrationPayloadSchema = "simple-coding.migration-payload"
	// migrationPayloadVersion 载荷版本（字段演进随版本递增，旧包照读）
	migrationPayloadVersion = 1

	// MigrationModeLight 轻装包（配置四块）
	MigrationModeLight = "light"
	// MigrationModeFull 全量包（配置四块 + 项目与上下文内容）
	MigrationModeFull = "full"

	// 迁移包文件名成分（下载附件名：sc-migration-<ts>.scpkg）
	migrationFilePrefix = "sc-migration-"
	migrationFileExt    = ".scpkg"

	// 迁移包预留导入票据 TTL：预览（解密+spool）到应用（落盘）的窗口。
	// 一次性票据，用后即焚；过期后重新选文件预览即可
	migrationTicketTTL = 30 * time.Minute
)

// 冲突策略词汇（per 块；settings 块用 package/local 二选）
const (
	policyMerge     = "merge"     // 去重合并：已有键保留本机，新键补入（缺省）
	policyOverwrite = "overwrite" // 覆盖：已有键以包为准
	policySkip      = "skip"      // 跳过：该块整体不导入
	policyPackage   = "package"   // settings 块：以包为准（整块）
	policyLocal     = "local"     // settings 块：保留本机（整块）
)

// MigrationBlockSelection 配置四块勾选（导出请求与载荷共用形状）
type MigrationBlockSelection struct {
	Credentials bool `json:"credentials"`
	Tokens      bool `json:"tokens"`
	Settings    bool `json:"settings"`
	Instances   bool `json:"instances"`
}

// any 勾选了任一块
func (b MigrationBlockSelection) any() bool {
	return b.Credentials || b.Tokens || b.Settings || b.Instances
}

// MigrationProjectChoice 全量包逐项目勾选记录（请求入参与载荷留档同形）
type MigrationProjectChoice struct {
	ProjectID       string `json:"projectId"`
	Name            string `json:"name,omitempty"`
	Key             string `json:"key,omitempty"` // project:<基名>（单元键，留档）
	DirName         string `json:"dirName,omitempty"`
	IncludeGit      bool   `json:"includeGit"`
	IncludeContexts bool   `json:"includeContexts"`
}

// MigrationSSHKey 包内 SSH 私钥条目（明文 PEM 随信封整体加密）。形状与
// remote 包导出文件同构（v2 私钥随主机不因迁移断链），独立声明防跨包耦合
type MigrationSSHKey struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
	Algo        string `json:"algo"`
	PrivatePem  string `json:"privatePem"`
}

// MigrationCredentials 凭据块（三处 store 聚合）。Secret/Password/Pem/
// PrivatePem/AnthropicToken 均为**明文**——包整体口令加密承载，导入侧重新
// 加密落盘（encrypt-on-write 既有链）
type MigrationCredentials struct {
	// Git HTTPS/git 凭据（credential store；Secret/RefreshToken 明文）
	Git []*store.Credential `json:"git,omitempty"`
	// SSHHosts 远程主机（含明文口令/PEM；sshKeyId 引用由 SSHKeys 重映射）
	SSHHosts []config.RemoteHost `json:"sshHosts,omitempty"`
	// SSHKeys 全部 SSH 私钥（整机迁移不带引用死角——未被主机引用的密钥同样迁）
	SSHKeys []MigrationSSHKey `json:"sshKeys,omitempty"`
	// Deploy 部署凭据（AnthropicToken 明文）
	Deploy *config.DeployConfig `json:"deploy,omitempty"`
}

// MigrationTokens 令牌族块。
// 可迁：Agent Token（明文可逆存储——终端 env 注入需要，导入本机重派生哈希+
// 重加密）、对端实例令牌（随实例注册表块）。**不可迁**：机器 API token（sc_）/
// quickdrop（scd_）/hook（sch_）为仅哈希落盘且哈希盐（data/token-salt）机器
// 本机——明文不可恢复、哈希跨机不生效；导入预览明示「新机需重签」
type MigrationTokens struct {
	AgentToken string `json:"agentToken,omitempty"` // 明文（sca_）
}

// MigrationPortableSettings 跨机可迁的系统设置白名单（ServerConfig 的策展
// 子集）。**刻意排除**：Port/Host/TLS 证书路径/UpdateURL/UpdateProxy（更新链
// 出站代理与机器网络形态绑定，P-20261109-12）/ExternalAccessURL/
// TrustedProxies/SyncDestRoot/DshTargets 等机器与网络拓扑绑定字段——跨 OS 换机后这些
// 值是垃圾甚至有害（端口冲突/证书路径不存在），迁移由用户在新机重配；
// DshTargets 另含访问令牌且设置 GET 面本就不外发该字段，进 diff 预览等于
// 新开一处令牌展示面（宁缺勿滥）
type MigrationPortableSettings struct {
	AutoFetch                bool                       `json:"autoFetch"`
	FetchInterval            int                        `json:"fetchInterval"`
	TerminalBackend          string                     `json:"terminalBackend"`
	TerminalScrollbackLines  int                        `json:"terminalScrollbackLines"`
	TerminalMaxSessions      int                        `json:"terminalMaxSessions"`
	TerminalTheme            string                     `json:"terminalTheme"`
	TerminalFont             string                     `json:"terminalFont"`
	UIDensity                string                     `json:"uidensity"`
	SessionContext           string                     `json:"sessionContext"`
	TerminalHistoryEnabled   *bool                      `json:"terminalHistoryEnabled,omitempty"`
	TerminalPastePrecheck    *bool                      `json:"terminalPastePrecheckEnabled,omitempty"`
	TerminalRemoteTmux       *bool                      `json:"terminalRemoteTmux,omitempty"`
	TerminalTmuxMouseEnabled *bool                      `json:"terminalTmuxMouseEnabled,omitempty"`
	TerminalIdleTimeoutMin   int                        `json:"terminalIdleTimeoutMin"`
	TerminalDefaultShell     string                     `json:"terminalDefaultShell,omitempty"`
	AgentProvider            string                     `json:"agentProvider"`
	AgentNamingNoteEnabled   *bool                      `json:"agentNamingNoteEnabled,omitempty"`
	AgentLaunchCommands      map[string]string          `json:"agentLaunchCommands,omitempty"`
	CustomAgents             []config.CustomAgent       `json:"customAgents,omitempty"`
	AgentGuard               *bool                      `json:"agentGuard,omitempty"`
	AgentApprovalMode        string                     `json:"agentApprovalMode,omitempty"`
	AgentApprovalRules       []config.AgentApprovalRule `json:"agentApprovalRules,omitempty"`
	AgentApprovalTimeoutMin  int                        `json:"agentApprovalTimeoutMin"`
	ApprovalRecording        *bool                      `json:"approvalRecording,omitempty"`
	CustomSensitivePatterns  []string                   `json:"customSensitivePatterns,omitempty"`
	UISnapshotEnabled        *bool                      `json:"uiSnapshotEnabled,omitempty"`
	SensitiveExternalWatch   *bool                      `json:"sensitiveExternalWatch,omitempty"`
	AuditRetentionDays       int                        `json:"auditRetentionDays"`
	LogRetentionDays         int                        `json:"logRetentionDays"`
	GitNetworkTimeoutSec     int                        `json:"gitNetworkTimeoutSec"`
	HookURLAllowHosts        []string                   `json:"hookUrlAllowHosts,omitempty"`
	DshWebBase               string                     `json:"dshWebBase,omitempty"`
	DshProxyPort             int                        `json:"dshProxyPort"`
	DshExposeAll             bool                       `json:"dshExposeAll"`
	DshAllowStandalone       *bool                      `json:"dshAllowStandalone,omitempty"`
	DshLaunchCommand         string                     `json:"dshLaunchCommand,omitempty"`
	DshNpmCommand            string                     `json:"dshNpmCommand,omitempty"`
}

// MigrationLockConfig 锁配置可迁字段（**明确不含** PasswordHash——Bitwarden
// 模式：包泄露不等于锁门洞开，新机首设锁密码）
type MigrationLockConfig struct {
	Enabled         bool `json:"enabled"`
	AutoLockEnabled bool `json:"autoLockEnabled"`
	AutoLockMinutes int  `json:"autoLockMinutes"`
	TokenTTLMinutes int  `json:"tokenTTLMinutes"`
}

// MigrationSettingsBlock 系统设置块（settings 域：白名单 ServerConfig 字段 +
// 锁配置（除哈希）+ 通知偏好）
type MigrationSettingsBlock struct {
	Server      *MigrationPortableSettings `json:"server,omitempty"`
	Lock        *MigrationLockConfig       `json:"lock,omitempty"`
	NotifyPrefs *notification.Prefs        `json:"notifyPrefs,omitempty"`
}

// MigrationPayload 信封内明文载荷（light=信封整体；full=zip 内 payload.json）
type MigrationPayload struct {
	Schema    string                  `json:"schema"`
	Version   int                     `json:"version"`
	Mode      string                  `json:"mode"`
	Host      string                  `json:"host"` // 源机 hostname 摘要（密文体，防拿错文件）
	CreatedAt time.Time               `json:"createdAt"`
	Blocks    MigrationBlockSelection `json:"blocks"`

	Credentials *MigrationCredentials   `json:"credentials,omitempty"`
	Tokens      *MigrationTokens        `json:"tokens,omitempty"`
	Settings    *MigrationSettingsBlock `json:"settings,omitempty"`
	Instances   []config.InstanceConfig `json:"instances,omitempty"` // 对端注册表（Token 明文；不含本机条目）

	// full 模式内容档：勾选留档（展示/审计）+ 单元元数据（与 zip 内 u<i>/
	// 一一对应——导入端 landZipReader 按它落位）
	Projects []MigrationProjectChoice `json:"projects,omitempty"`
	Content  *TransferMeta            `json:"content,omitempty"`
}

// ── 预览/报告形状（API 出参，绝不含秘密明文）──

// migrationFieldDiff 设置块逐字段 old→new（值为 JSON 序列化形态截断展示）
type migrationFieldDiff struct {
	Field    string `json:"field"`
	Local    string `json:"local,omitempty"`
	Incoming string `json:"incoming,omitempty"`
}

// migrationCredRow 凭据预览行（host/用户名级元数据，secret 永不出预览）
type migrationCredRow struct {
	Kind     string `json:"kind"` // git|sshHost|sshKey|deploy
	Label    string `json:"label"`
	Detail   string `json:"detail,omitempty"`
	Exists   bool   `json:"exists"`   // 本机已有同键条目（merge 策略下将跳过）
	Portable bool   `json:"portable"` // false = 提示不可迁移（占位行）
}

// migrationInstanceRow 实例注册表预览行
type migrationInstanceRow struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	URL    string `json:"url"`
	Exists bool   `json:"exists"`
	Online string `json:"online,omitempty"` // 导入端不做探测——留空；展示层不消费
}

// migrationUnitRow 全量包内容单元预览行
type migrationUnitRow struct {
	Key        string `json:"key"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	Files      int    `json:"files"`
	DirName    string `json:"dirName,omitempty"`
	IncludeGit bool   `json:"includeGit,omitempty"`
	DestPath   string `json:"destPath,omitempty"`
}

// migrationContentPreview 全量包内容档预览
type migrationContentPreview struct {
	DestRoot   string             `json:"destRoot"`
	DiskFree   int64              `json:"diskFree"`
	TotalBytes int64              `json:"totalBytes"`
	Units      []migrationUnitRow `json:"units"`
}

// migrationPreview POST /api/migration/import/preview 响应（data 段）。
// 逐块条目计数 + 设置 diff + 内容档项目清单；票据供 apply 二段引用（包本体
// 不重传）
type migrationPreview struct {
	Format    string                  `json:"format"`
	Version   int                     `json:"version"`
	Mode      string                  `json:"mode"`
	Host      string                  `json:"host"`
	CreatedAt time.Time               `json:"createdAt"`
	Blocks    MigrationBlockSelection `json:"blocks"`
	Ticket    string                  `json:"ticket"`

	Credentials   []migrationCredRow       `json:"credentials,omitempty"`
	Settings      []migrationFieldDiff     `json:"settingsDiff,omitempty"`
	Instances     []migrationInstanceRow   `json:"instances,omitempty"`
	HasAgentToken bool                     `json:"hasAgentToken,omitempty"`
	Content       *migrationContentPreview `json:"content,omitempty"`
}

// migrationBlockReport 单块导入结果
type migrationBlockReport struct {
	Imported int    `json:"imported"`
	Skipped  int    `json:"skipped"`
	Failed   int    `json:"failed"`
	Error    string `json:"error,omitempty"`
}

// migrationApplyReport POST /api/migration/import/apply 响应（data 段）。
// RolledBack=true 表示任一块失败已整体回滚（导入前状态恢复）；引导闭环数据
// （对端实例数）供前端一键首同步提示
type migrationApplyReport struct {
	Blocks     map[string]*migrationBlockReport `json:"blocks"`
	Content    *LandResult                      `json:"content,omitempty"`
	RolledBack bool                             `json:"rolledBack"`
	Error      string                           `json:"error,omitempty"`
	// PeerCount 导入成功的对端实例数（>0 时前端给「一键首同步」引导）
	PeerCount int `json:"peerCount,omitempty"`
	// LandedProjects 全量包成功落位的项目基名清单
	LandedProjects []string `json:"landedProjects,omitempty"`
}
