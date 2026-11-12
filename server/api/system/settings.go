package system

import (
	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/mask"
	"codecombo/server/middleware"
	"codecombo/server/proxy"
	"codecombo/server/store"
	"codecombo/server/terminal"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/update"
)

// processStartTime 进程启动时刻（HealthCheck 据此计算运行时长）
var processStartTime = time.Now()

// 构建信息，由 main.go 在启动时注入
var (
	buildVersion = "dev"
	buildCommit  = "none"
	buildTime    = "unknown"
)

// SetBuildInfo 注入构建信息
func SetBuildInfo(v, c, t string) {
	buildVersion = v
	buildCommit = c
	buildTime = t
}

// BuildInfo 读取构建信息（/api/meta 能力探测端点用，与 SetBuildInfo 同一注入源）。
// 匿名返回值：命名结果 buildTime 会遮蔽同名包级变量，返回恒空串
func BuildInfo() (string, string, string) {
	return buildVersion, buildCommit, buildTime
}

// GetSettings 获取设置
func GetSettings(c *gin.Context) {
	cfg := store.Get().Settings.Get()

	// terminalBackend 默认值为 auto（兼容旧配置）
	backend := cfg.Server.TerminalBackend
	if backend == "" {
		backend = "auto"
	}

	// terminalFont 默认值 jetbrains
	font := cfg.Server.TerminalFont
	if font == "" {
		font = "jetbrains"
	}

	// terminalTheme 默认值 classic-dark（不再用空串做"跟随应用主题"映射）
	terminalTheme := cfg.Server.TerminalTheme
	if terminalTheme == "" {
		terminalTheme = "classic-dark"
	}

	// AI 助手底层智能体选型默认 auto（空串兼容旧配置）
	agentProvider := cfg.Server.AgentProvider
	if agentProvider == "" {
		agentProvider = "auto"
	}

	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"autoFetch":                    cfg.Server.AutoFetch,
			"fetchInterval":                cfg.Server.FetchInterval,
			"terminalBackend":              backend,
			"terminalScrollbackLines":      terminal.GetScrollbackLines(cfg.Server.TerminalScrollbackLines),
			"terminalIdleTimeoutMin":       cfg.Server.TerminalIdleTimeoutMin,
			"terminalDefaultShell":         cfg.Server.TerminalDefaultShell,
			"terminalHistoryEnabled":       cfg.Server.TerminalHistoryEnabledOrDefault(),
			"terminalPastePrecheckEnabled": cfg.Server.TerminalPastePrecheckEnabledOrDefault(),
			"terminalRemoteTmux":           cfg.Server.TerminalRemoteTmuxOrDefault(),
			// tmux 鼠标接管开关（P-20261109-7）：默认开（鼠标接管）；false=复制
			// 优先模式（tmux mouse off，拖选落回 xterm 原生选择）
			"terminalTmuxMouseEnabled": cfg.Server.TerminalTmuxMouseEnabledOrDefault(),
			"terminalTheme":            terminalTheme,
			"terminalFont":             font,
			"uidensity":                cfg.Server.UIDensityOrDefault(),
			"sessionContext":           cfg.Server.SessionContextOrDefault(),
			"agentProvider":            agentProvider,
			// 会话命名系统注记注入开关（P-20261023-3）：未配置默认开
			"agentNamingNoteEnabled": cfg.Server.AgentNamingNoteEnabledOrDefault(),
			// 会话自动命名开关（P-20261111-6 S2）：未配置默认开
			"agentAutoNameEnabled":   cfg.Server.AgentAutoNameEnabledOrDefault(),
			"agentProviders":         agentops.ProviderNames(),
			"agentLaunchCommands":    cfg.Server.AgentLaunchCommands,
			"customAgents":           customAgentsJSON(cfg),
			"agentGuard":             cfg.Server.AgentGuardOrDefault(),
			"agentApprovalMode":      cfg.Server.EffectiveApprovalMode(time.Now()),
			"agentApprovalExpiresAt": approvalExpiresAtJSON(cfg.Server),
			"agentApprovalSessions":  len(cfg.Server.AgentSessionAllows),
			"agentApprovalRules":     agentApprovalRulesJSON(cfg.Server.AgentApprovalRules),
			// 自定义敏感模式（P-20261006-11）：单一权威源 config 经既有设置
			// API 下发前端（TS sensitiveMask 链编译同一列表）；恒返数组
			//（nil 归一空数组）——agent 编程消费该字段时不必判 null
			"customSensitivePatterns": customSensitivePatternsJSON(cfg.Server.CustomSensitivePatterns),
			// 入站 Hook URL 动作允许域（P-20261003-164）：空数组 = url 动作
			// 整体关闭（仅 panel:，默认安全档）；恒返数组（nil 归一空数组，
			// customSensitivePatterns 同款防 null 判空面）
			"hookUrlAllowHosts":       hookURLAllowHostsJSON(cfg.Server.HookURLAllowHosts),
			"approvalRecording":       cfg.Server.ApprovalRecordingOrDefault(),
			"agentApprovalTimeoutMin": cfg.Server.AgentApprovalTimeoutMin,
			"gitNetworkTimeoutSec":    cfg.Server.GitNetworkTimeoutSec,
			"auditRetentionDays":      cfg.Server.AuditRetentionDaysOrDefault(),
			"logRetentionDays":        cfg.Server.LogRetentionDaysOrDefault(),
			"uiSnapshotEnabled":       cfg.Server.UISnapshotEnabledOrDefault(),
			"sensitiveExternalWatch":  cfg.Server.SensitiveExternalWatchOrDefault(),
			// 预览面板同源兼容模式（P-20261019-1）：false（缺省，存量配置零迁移）
			// = 预览 iframe 沙箱隔离；agent 可经本键查询/惯例化调整当前档位
			"previewCompatMode":  cfg.Server.PreviewCompatModeOrDefault(),
			"dshWebBase":         dshWebBaseOrDefault(cfg.Server.DshWebBase),
			"dshWebToken":        cfg.Server.DshWebToken,
			"dshLaunchCommand":   cfg.Server.DshLaunchCommand,
			"dshProxyPort":       dshProxyPortOrDefault(cfg.Server.DshProxyPort),
			"dshExposeAll":       cfg.Server.DshExposeAll,
			"dshAllowStandalone": cfg.Server.DshAllowStandaloneOrDefault(),
			"dshNpmCommand":      cfg.Server.DshNpmCommand,
			"dshRollbackVersion": cfg.Server.DshRollbackVersion,
			"updateURL":          cfg.Server.UpdateURL,
			"updateChecks":       cfg.Server.UpdateChecks,
			"updateChannel":      cfg.Server.UpdateChannel,
			// 更新链出站代理（P-20261109-12）：空 = 回环境变量感知（HTTPS_PROXY）
			"updateProxy": cfg.Server.UpdateProxy,
			// 系统代理自动探测开关（P-20261110-1 S6）：默认 false（存量零变化）；
			// 当前生效档位见 GET /api/updates/proxy-status
			"updateProxyAutoDetect": cfg.Server.UpdateProxyAutoDetect,
			"externalAccessUrl":     cfg.Server.ExternalAccessURL,
			// 多实例同步本端落位根（P-20261023-1）：空串 = 默认（主目录下
			// simple-coding-sync/），前端展示默认值说明
			"syncDestRoot": cfg.Server.SyncDestRoot,
			// 新建文件分享默认有效期（P-20261020-5）：permanent（缺省，存量
			// 行为零变化）/ 1d / 7d / 30d。创建请求未显式选择时服务端应用
			"shareDefaultTTL": cfg.Server.ShareDefaultTTLOrDefault(),
			// 分享链接外发基址（P-20261020-2）：空 = 自动选址（当前地址/局域网
			// 候选/分享子服务端口）；非空 = 链接固定为 <base>/s/<token>
			"sharePublicBaseUrl": cfg.Server.SharePublicBaseURL,
			// 可信代理清单（P-20261020-1）：只读投影当前生效配置，供部署核对；
			// 写路径经 PUT 同字段（保存后需重启生效）。空数组 = 不信任转发头
			"trustedProxies":    trustedProxiesJSON(cfg.Server.TrustedProxies),
			"tlsEnabled":        cfg.Server.TLSEnabledOrDefault(),
			"tlsVerifyPeer":     cfg.Server.TLSVerifyPeerOrDefault(),
			"tlsCertConfigured": cfg.Server.TLSCertFile != "" && cfg.Server.TLSKeyFile != "",
			"tmuxAvailable":     terminal.IsTmuxAvailable(),
			"version":           buildVersion,
			"commit":            buildCommit,
			"buildTime":         buildTime,
			"goVersion":         runtime.Version(),
			"platform":          runtime.GOOS + "/" + runtime.GOARCH,
			// 用户偏好层漫游单键（P-20261007-1）：nil → JSON null（前端判「服务端
			// 无漫游偏好」走播种分支；非 null 即服务端真值，多端启动期跟随）
			"userPrefs": userPrefsJSON(cfg.Server.UserPrefs),
			// 远程接入中继档案（P-20261019-11）：密码永不出参（只回 hasPassword），
			// 运行态（enabled/activeId）由 start/stop 端点维护，此处原样投影
			"remoteAccess": remoteAccessJSON(cfg.Server.RemoteAccess),
		},
	})
}

// remoteAccessJSON GET /settings 出参投影：档案不含密码（含密文），只回
// hasPassword；恒返对象（未配置 = 空档案列表）让前端免判空分支。
func remoteAccessJSON(ra *config.RemoteAccessConfig) gin.H {
	out := gin.H{"profiles": []gin.H{}, "activeId": "", "enabled": false}
	if ra == nil {
		return out
	}
	profiles := make([]gin.H, 0, len(ra.Profiles))
	for i := range ra.Profiles {
		p := ra.Profiles[i]
		profiles = append(profiles, gin.H{
			"id":             p.ID,
			"name":           p.Name,
			"host":           p.Host,
			"port":           p.EffectivePort(),
			"user":           p.User,
			"authType":       p.AuthType,
			"sshKeyId":       p.SshKeyID,
			"hasPassword":    p.AuthType == config.RemoteAccessAuthPassword && p.Password != "",
			"remoteBindHost": p.EffectiveRemoteBindHost(),
			"remotePort":     p.EffectiveRemotePort(),
			"domain":         p.Domain,
			"createdAt":      p.CreatedAt,
			"updatedAt":      p.UpdatedAt,
		})
	}
	out["profiles"] = profiles
	out["activeId"] = ra.ActiveID
	out["enabled"] = ra.Enabled
	return out
}

// customSensitivePatternsJSON GET /settings 出参：自定义敏感模式恒返数组
// （nil → 空数组，agent/前端编程消费免判 null）
func customSensitivePatternsJSON(patterns []string) []string {
	if len(patterns) == 0 {
		return []string{}
	}
	return patterns
}

// hookURLAllowHostsJSON GET /settings 出参（P-20261003-164）：恒返数组
// （nil → 空数组）。与 customSensitivePatternsJSON 同形不共用——两清单域
// 不同（敏感模式 vs URL 动作允许域），独立命名防误改串域
func hookURLAllowHostsJSON(hosts []string) []string {
	if len(hosts) == 0 {
		return []string{}
	}
	return hosts
}

// trustedProxiesJSON GET /settings 出参（P-20261020-1）：数据面设置显式写过
// 该键即回真值（含显式 [] = 不信任）；未写过（nil，存量配置缺键）回落
// config.json 的同名字段——与启动期 ApplyTrustedProxies 的取值优先级一致，
// 避免设置页显示值与实际生效边界漂移。恒返数组（nil → 空数组）。
func trustedProxiesJSON(stored []string) []string {
	if stored == nil {
		stored = config.Load().Server.TrustedProxies
	}
	if len(stored) == 0 {
		return []string{}
	}
	return stored
}

// userPrefsJSON GET /settings 出参：用户偏好单键（nil → JSON null——与
// customSensitivePatterns 的「恒返数组」不同，这里 null 是语义值：服务端从未
// 写过漫游偏好，前端据此走「本地镜像播种上传」分支而非「服务端真值覆盖」）
func userPrefsJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

func dshWebBaseOrDefault(v string) string {
	if strings.TrimSpace(v) == "" {
		return "http://127.0.0.1:3080"
	}
	return v
}

// approvalExpiresAtJSON GET /settings 出参：allow-24h 档位的到期时刻
// （RFC3339；零值 = 无时限出空串）。与 agentApprovalMode（有效档位，到期已
// 归一 ask）同发，前端据此渲染剩余时限徽标
func approvalExpiresAtJSON(server config.ServerConfig) string {
	if server.AgentApprovalExpiresAt.IsZero() {
		return ""
	}
	return server.AgentApprovalExpiresAt.UTC().Format(time.RFC3339)
}

func dshProxyPortOrDefault(v int) int {
	if v == 0 {
		return 3081
	}
	if v < 0 {
		return 0
	}
	return v
}

// UpdateSettings 更新设置
func UpdateSettings(c *gin.Context) {
	var req struct {
		AutoFetch                    *bool   `json:"autoFetch"`
		FetchInterval                *int    `json:"fetchInterval"`
		TerminalBackend              *string `json:"terminalBackend"`
		TerminalScrollbackLines      *int    `json:"terminalScrollbackLines"`
		TerminalIdleTimeoutMin       *int    `json:"terminalIdleTimeoutMin"`
		TerminalDefaultShell         *string `json:"terminalDefaultShell"`
		TerminalHistoryEnabled       *bool   `json:"terminalHistoryEnabled"`
		TerminalPastePrecheckEnabled *bool   `json:"terminalPastePrecheckEnabled"`
		TerminalRemoteTmux           *bool   `json:"terminalRemoteTmux"`
		// tmux 鼠标接管开关（P-20261109-7）：指针直接透传（nil=不动，保持原值/
		// 默认开）。落盘成功后 ApplyTmuxMouseOption 热切换——mouse 全局 session
		// option 逐事件读取，现存全部专有 socket 会话即刻生效，无需重启/重挂
		TerminalTmuxMouseEnabled *bool   `json:"terminalTmuxMouseEnabled"`
		TerminalTheme            *string `json:"terminalTheme"`
		TerminalFont             *string `json:"terminalFont"`
		UIDensity                *string `json:"uidensity"`
		SessionContext           *string `json:"sessionContext"`
		AgentProvider            *string `json:"agentProvider"`
		// AgentNamingNoteEnabled 会话命名系统注记注入开关（P-20261023-3）：
		// 省略 = 不动；指针三态与既有开关字段同口径
		AgentNamingNoteEnabled *bool `json:"agentNamingNoteEnabled"`
		// AgentAutoNameEnabled 会话自动命名开关（P-20261111-6 S2）：省略 = 不动；
		// 指针三态与既有开关字段同口径
		AgentAutoNameEnabled    *bool                       `json:"agentAutoNameEnabled"`
		AgentLaunchCommands     *map[string]string          `json:"agentLaunchCommands"`
		AgentGuard              *bool                       `json:"agentGuard"`
		AgentApprovalMode       *string                     `json:"agentApprovalMode"`
		AgentApprovalExpiresAt  *string                     `json:"agentApprovalExpiresAt"`
		AgentApprovalRules      *[]config.AgentApprovalRule `json:"agentApprovalRules"`
		CustomSensitivePatterns *[]string                   `json:"customSensitivePatterns"`
		// HookURLAllowHosts 入站 Hook URL 动作允许域（P-20261003-164）：
		// 省略 = 不动；数组 = 全量替换（空数组 = url 动作整体关闭，默认安全
		// 档）。归一（小写 hostname/剥端口/去重）与形态校验见
		// config.NormalizeHookURLAllowHosts；生效即时（入站解析每请求现读）
		HookURLAllowHosts       *[]string `json:"hookUrlAllowHosts"`
		AgentApprovalTimeoutMin *int      `json:"agentApprovalTimeoutMin"`
		ApprovalRecording       *bool     `json:"approvalRecording"`
		GitNetworkTimeoutSec    *int      `json:"gitNetworkTimeoutSec"`
		AuditRetentionDays      *int      `json:"auditRetentionDays"`
		LogRetentionDays        *int      `json:"logRetentionDays"`
		UISnapshotEnabled       *bool     `json:"uiSnapshotEnabled"`
		SensitiveExternalWatch  *bool     `json:"sensitiveExternalWatch"`
		// PreviewCompatMode 预览面板同源兼容模式（P-20261019-1）：指针直接透传
		//（nil=不动，保持原值/默认关=沙箱隔离）。开启是安全姿态降级（预览内容
		// 获得本应用权限），前端设置页承担红色警示确认面，服务端照实落盘
		PreviewCompatMode  *bool   `json:"previewCompatMode"`
		DshWebBase         *string `json:"dshWebBase"`
		DshWebToken        *string `json:"dshWebToken"`
		DshLaunchCommand   *string `json:"dshLaunchCommand"`
		DshProxyPort       *int    `json:"dshProxyPort"`
		DshExposeAll       *bool   `json:"dshExposeAll"`
		DshAllowStandalone *bool   `json:"dshAllowStandalone"`
		DshNpmCommand      *string `json:"dshNpmCommand"`
		DshRollbackVersion *string `json:"dshRollbackVersion"`
		UpdateURL          *string `json:"updateURL"`
		UpdateProxy        *string `json:"updateProxy"` // 更新链出站代理（P-20261109-12），省略=不动
		// UpdateProxyAutoDetect 系统代理自动探测开关（P-20261110-1 S6）：省略 =
		// 不动；指针三态与既有开关字段同口径
		UpdateProxyAutoDetect *bool `json:"updateProxyAutoDetect"`
		// UpdateChecks 自动检查更新开关（P-20261103-1）：省略 = 不动；
		// 指针三态与既有开关字段同口径
		UpdateChecks *bool `json:"updateChecks"`
		// UpdateChannel 更新通道（P-20261103-3）：stable/prerelease，省略 = 不动
		UpdateChannel     *string `json:"updateChannel"`
		ExternalAccessURL *string `json:"externalAccessUrl"`
		// SyncDestRoot 多实例同步本端落位根（P-20261023-1）：省略 = 不动；
		// 空串 = 恢复默认（用户主目录下 simple-coding-sync/）；非空须为绝对
		// 目录路径（不要求已存在——落位层按需创建；相对路径 400 早反馈）
		SyncDestRoot *string `json:"syncDestRoot"`
		// ShareDefaultTTL 新建文件分享默认有效期（P-20261020-5）：省略 = 不动；
		// permanent/1d/7d/30d 白名单校验，空串等价 permanent。仅影响「创建时
		// 未显式选择」的 live 文件分享，存量记录零变化
		ShareDefaultTTL *string `json:"shareDefaultTTL"`
		// SharePublicBaseURL 分享链接外发基址（P-20261020-2）：省略 = 不动；
		// 空串 = 清除（回落自动选址）；仅 http/https origin（同 externalAccessUrl
		// 校验核，写错 400 早反馈）。只作拼链内容，不参与重定向
		SharePublicBaseURL *string `json:"sharePublicBaseUrl"`
		// TrustedProxies 可信反向代理清单（P-20261020-1）：省略 = 不动；
		// 数组 = 全量替换（空数组 = 不信任任何转发头）。写路径校验 IP/CIDR、
		// 条数与长度；保存后需重启生效（Gin Engine 的信任表在启动期装配）
		TrustedProxies *[]string `json:"trustedProxies"`
		TLSEnabled     *bool     `json:"tlsEnabled"`
		TLSVerifyPeer  *bool     `json:"tlsVerifyPeer"`
		TLSCertFile    *string   `json:"tlsCertFile"`
		TLSKeyFile     *string   `json:"tlsKeyFile"`
		// UserPrefs 用户偏好漫游单键（P-20261007-1）：RawMessage 非指针，
		// 借 encoding/json 的缺失/显式 null 区分实现三态——
		//   省略（缺失）= 不动（设置页整体提交不携带该字段，天然不被全量保存清掉）；
		//   显式 null  = 清空（恢复「服务端从未配置」形态，GET 回 null 触发各端
		//                播种分支；agent 复位/e2e 数据面隔离用）；
		//   对象       = 全量替换（多端 last-write-wins，与设置域现状语义一致）
		UserPrefs json.RawMessage `json:"userPrefs"`
		// RemoteAccess 中继档案（P-20261019-11）：省略 = 不动；对象 = 档案列表
		// 全量替换（与 agentApprovalRules 同款）。running 态字段（enabled/
		// activeId）只由 POST /api/remoteaccess/tunnel 维护，此处保留现值——
		// 设置页编辑档案不会意外停掉/切换正在运行的隧道
		RemoteAccess *config.RemoteAccessConfig `json:"remoteAccess"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
		return
	}

	cfg := store.Get().Settings.Get()
	if req.AutoFetch != nil {
		cfg.Server.AutoFetch = *req.AutoFetch
	}
	if req.FetchInterval != nil {
		cfg.Server.FetchInterval = *req.FetchInterval
	}
	if req.TerminalBackend != nil {
		// 白名单校验
		switch *req.TerminalBackend {
		case "auto", "tmux", "native":
			cfg.Server.TerminalBackend = *req.TerminalBackend
		default:
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid terminalBackend: %s", *req.TerminalBackend))
			return
		}
	}
	if req.TerminalScrollbackLines != nil {
		// 允许范围 1000 ~ 200000，超出拒绝（防止 0/负值或过大值导致内存爆炸）
		if *req.TerminalScrollbackLines < 1000 || *req.TerminalScrollbackLines > 200000 {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("terminalScrollbackLines out of range: %d", *req.TerminalScrollbackLines))
			return
		}
		cfg.Server.TerminalScrollbackLines = *req.TerminalScrollbackLines
	}
	// 终端空闲超时自动分离（P-20261003-192）：0=关闭（默认，存量行为零变化）；
	// 1~43200 分钟（30 天封顶）有效。nil=不动。生效即时：判定点每轮巡检现读
	// 配置，无需重启（缩小/关闭阈值后已分离的会话不追溯恢复——分离不可逆，
	// tmux 会话重连即可）
	if req.TerminalIdleTimeoutMin != nil {
		if !config.TerminalIdleTimeoutMinValid(*req.TerminalIdleTimeoutMin) {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("terminalIdleTimeoutMin out of range (0 or 1-43200): %d", *req.TerminalIdleTimeoutMin))
			return
		}
		cfg.Server.TerminalIdleTimeoutMin = *req.TerminalIdleTimeoutMin
	}
	// 终端默认 shell（P-20261004-57）：空串 = 清除（回落平台缺省序，存量行为）；
	// 非空须通过 LookPath 存在性校验（裸名沿 PATH / 完整路径直验），否则 400
	// 明确报错——保存期早反馈优于建会话时静默回落。仅影响新会话
	if req.TerminalDefaultShell != nil {
		v := strings.TrimSpace(*req.TerminalDefaultShell)
		if v != "" {
			if err := terminal.ValidateShellPath(v); err != nil {
				shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
				return
			}
		}
		cfg.Server.TerminalDefaultShell = v
	}
	// 命令历史开关：指针直接透传（nil=未配置不动，保持原值/默认开）
	if req.TerminalHistoryEnabled != nil {
		cfg.Server.TerminalHistoryEnabled = req.TerminalHistoryEnabled
	}
	// 高危命令粘贴预检开关（P-20261005-191）：指针直接透传（nil=未配置不动，
	// 保持原值/默认开）。关闭后前端粘贴链/palette 直达不再做写入前预检
	if req.TerminalPastePrecheckEnabled != nil {
		cfg.Server.TerminalPastePrecheckEnabled = req.TerminalPastePrecheckEnabled
	}
	// 远程终端 tmux 持久化开关：指针直接透传（nil=未配置不动，保持原值/默认关）
	if req.TerminalRemoteTmux != nil {
		cfg.Server.TerminalRemoteTmux = req.TerminalRemoteTmux
	}
	// tmux 鼠标接管开关（P-20261109-7）：指针直接透传（nil=未配置不动，保持
	// 原值/默认开）。热切换在落盘成功后统一执行（见 Save 之后）
	if req.TerminalTmuxMouseEnabled != nil {
		cfg.Server.TerminalTmuxMouseEnabled = req.TerminalTmuxMouseEnabled
	}
	if req.TerminalTheme != nil {
		// 终端主题白名单（与前端 terminalThemeRegistry 保持一致）
		switch *req.TerminalTheme {
		case "classic-dark", "classic-light", "one-dark", "dracula",
			"cyber-hud", "industrial", "deep-space":
			cfg.Server.TerminalTheme = *req.TerminalTheme
		default:
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid terminalTheme: %s", *req.TerminalTheme))
			return
		}
	}
	if req.TerminalFont != nil {
		// 字体白名单
		switch *req.TerminalFont {
		case "jetbrains", "cascadia", "ibmplex":
			cfg.Server.TerminalFont = *req.TerminalFont
		default:
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid terminalFont: %s", *req.TerminalFont))
			return
		}
	}
	if req.UIDensity != nil {
		// 界面密度白名单（P-20261003-322，与前端 ui-density store 两档一致）：
		// compact=紧凑 / comfortable=舒适（默认，历史现状）。空串归一默认，
		// 供 agent 经 settings API 惯例化调整界面密度
		switch *req.UIDensity {
		case "comfortable", "":
			cfg.Server.UIDensity = "comfortable"
		case "compact":
			cfg.Server.UIDensity = "compact"
		default:
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid uidensity: %s", *req.UIDensity))
			return
		}
	}
	if req.SessionContext != nil {
		// 会话启动上下文白名单（P-20261006-47）：逗号分隔多选 git/notes/todos/env
		// （env = 项目环境画像，P-20261007-14 增量），"none"=全关（须单独给值，与
		// 多选组合无意义），空串=回落默认 git（P-176 既有行为）。非法 token 400
		// 拒绝（防脏值让前端装配面失控）；合法值经 NormalizeSessionContext 规范序
		// 去重后落盘，agent 可经 settings API 惯例化按任务类型自调上下文。白名单
		// 谓词与归一共用 config.sessionContextTokens 单一清单，不在此手抄
		v := strings.TrimSpace(*req.SessionContext)
		if v != "" && v != "none" {
			for _, tok := range strings.Split(v, ",") {
				if !config.ValidSessionContextToken(tok) {
					shared.Error(c, http.StatusBadRequest, "Settings operation failed",
						fmt.Errorf("invalid sessionContext token: %s", tok))
					return
				}
			}
		}
		cfg.Server.SessionContext = config.NormalizeSessionContext(v)
	}
	if req.AgentProvider != nil {
		// AI 底层智能体白名单：auto + 已注册的 Provider 名（新增 Provider 自动可配）
		name := strings.TrimSpace(*req.AgentProvider)
		if name == "" {
			name = "auto"
		}
		if name != "auto" && !agentops.IsRegisteredProvider(name) {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid agentProvider: %s", name))
			return
		}
		cfg.Server.AgentProvider = name
	}
	if req.AgentNamingNoteEnabled != nil {
		// 会话命名系统注记注入开关（P-20261023-3）：读端 OrDefault 同源默认开
		cfg.Server.AgentNamingNoteEnabled = req.AgentNamingNoteEnabled
	}
	if req.AgentAutoNameEnabled != nil {
		// 会话自动命名开关（P-20261111-6 S2）：读端 OrDefault 同源默认开；
		// 保存后随 settings.changed 广播（observe 侧判定点每 tick 现读内存缓存，
		// 无需重启）
		cfg.Server.AgentAutoNameEnabled = req.AgentAutoNameEnabled
	}
	if req.AgentLaunchCommands != nil {
		// 每运行时启动命令覆盖：整体替换语义（省略的 key 即删除）。
		// key 必须是已注册运行时；值经 shell 执行，trim 后非空 + 长度上限
		//（经 PTY 注入 shell 执行 = 本机用户权限，与手敲等价；上限防误粘超长串）
		clean := make(map[string]string, len(*req.AgentLaunchCommands))
		for k, v := range *req.AgentLaunchCommands {
			if !agentops.IsRegisteredProvider(k) {
				shared.Error(c, http.StatusBadRequest, "Settings operation failed",
					fmt.Errorf("invalid agentLaunchCommands key (unregistered runtime): %s", k))
				return
			}
			v = strings.TrimSpace(v)
			if len(v) > 200 {
				shared.Error(c, http.StatusBadRequest, "Settings operation failed",
					fmt.Errorf("agentLaunchCommands[%s] too long (max 200): %d", k, len(v)))
				return
			}
			if v != "" {
				clean[k] = v
			}
		}
		cfg.Server.AgentLaunchCommands = clean
	}
	// 服务端强制审批总开关：默认开（nil=不动）
	if req.AgentGuard != nil {
		cfg.Server.AgentGuard = req.AgentGuard
	}
	// 高危操作审批档位白名单（P-20261003-316 四档）：ask=每次询问 /
	// allow-session=会话级放行 / allow-24h=全局放行 24 小时（保存即从此刻起算，
	// 显式注入的 agentApprovalExpiresAt 优先——测试时间旅行用）/ allow=永久放行
	//（历史「完全允许」，值语义不变）（nil=不动）。切离 allow-session 时清空
	// 会话放行映射——授予随档位生命周期走，重新进入不复活历史授予（静默放权面）
	// oldApprovalMode 审计基线（P-20261005-162）：设置页每次保存都携带 mode 字段
	//（前端通用设置整体提交），只有档位实际翻转才入账——同值保存零入账不刷台账
	oldApprovalMode := cfg.Server.AgentApprovalModeStored()
	if req.AgentApprovalMode != nil {
		switch *req.AgentApprovalMode {
		case config.ApprovalModeAsk, config.ApprovalModeAllowSession,
			config.ApprovalModeAllow24h, config.ApprovalModeAllow:
			cfg.Server.AgentApprovalMode = *req.AgentApprovalMode
			if *req.AgentApprovalMode == config.ApprovalModeAllow24h {
				expiresAt := time.Now().Add(config.ApprovalAllow24hTTL)
				if req.AgentApprovalExpiresAt != nil && *req.AgentApprovalExpiresAt != "" {
					t, err := time.Parse(time.RFC3339, *req.AgentApprovalExpiresAt)
					if err != nil {
						shared.Error(c, http.StatusBadRequest, "Settings operation failed",
							fmt.Errorf("invalid agentApprovalExpiresAt (RFC3339): %s", *req.AgentApprovalExpiresAt))
						return
					}
					expiresAt = t
				}
				cfg.Server.AgentApprovalExpiresAt = expiresAt
			} else {
				cfg.Server.AgentApprovalExpiresAt = time.Time{}
			}
			if *req.AgentApprovalMode != config.ApprovalModeAllowSession {
				cfg.Server.AgentSessionAllows = nil
			}
		default:
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid agentApprovalMode: %s", *req.AgentApprovalMode))
			return
		}
	} else if req.AgentApprovalExpiresAt != nil && *req.AgentApprovalExpiresAt != "" &&
		cfg.Server.AgentApprovalModeStored() == config.ApprovalModeAllow24h {
		// 到期时刻独立微调（模式字段未携带时）：仅对在档的 allow-24h 生效——
		// 供测试时间旅行/运维调整剩余时限，其余档位忽略该字段
		t, err := time.Parse(time.RFC3339, *req.AgentApprovalExpiresAt)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid agentApprovalExpiresAt (RFC3339): %s", *req.AgentApprovalExpiresAt))
			return
		}
		cfg.Server.AgentApprovalExpiresAt = t
	}
	// 审批分类规则（P-20261003-35）：整体替换语义（省略 = 不动，显式数组 =
	// 全量覆盖）——规则是有序整体，行级增删改在前端本地编辑后一次保存。
	// pattern/effect 白名单与数量护栏见 config.ValidateApprovalRules；归一化
	// pattern 首尾空白后再校验落盘（读取侧同口径清洗）；pathPattern 归一
	//（trim+反斜杠统一正斜杠，P-20261004-67 路径条件）后同口径校验落盘。
	// tempUntil 指针透传
	//（P-20261003-243 临时启用至：nil=永久规则；已过去的时刻合法收下——判定侧
	// 惰性按 ask 裁决、巡检/创建点物化清账，无需写入端拒绝）
	if req.AgentApprovalRules != nil {
		cleaned := make([]config.AgentApprovalRule, 0, len(*req.AgentApprovalRules))
		for _, r := range *req.AgentApprovalRules {
			cleaned = append(cleaned, config.AgentApprovalRule{
				OpPattern:   strings.TrimSpace(r.OpPattern),
				PathPattern: config.NormalizeApprovalPathPattern(r.PathPattern),
				Effect:      r.Effect,
				TempUntil:   r.TempUntil,
			})
		}
		if msg := config.ValidateApprovalRules(cleaned); msg != "" {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid agentApprovalRules: %s", msg))
			return
		}
		cfg.Server.AgentApprovalRules = cleaned
	}
	// 自定义敏感模式（P-20261006-11）：整体替换语义（省略 = 不动，显式数组 =
	// 全量覆盖，与 agentApprovalRules 同款）。归一（trim/去空）后校验——条数/
	// 长度上限、RE2 编译、方言纪律（禁内联旗标/环视/反向引用，保 Go 与 JS
	// 双端可编译同语义）、禁空匹配；校验失败 400 带下标定位，保存期早反馈
	if req.CustomSensitivePatterns != nil {
		cleaned := config.NormalizeCustomSensitivePatterns(*req.CustomSensitivePatterns)
		if msg := config.ValidateCustomSensitivePatterns(cleaned); msg != "" {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid customSensitivePatterns: %s", msg))
			return
		}
		cfg.Server.CustomSensitivePatterns = cleaned
	}
	// 入站 Hook URL 动作允许域（P-20261003-164）：整体替换语义（省略 = 不动，
	// 显式数组 = 全量覆盖，空数组 = 关闭 url 动作）。条目归一为小写 hostname
	//（剥端口，清单语义 = 信任主机不限端口）+ 形态校验（非纯 host/通配符
	// 400 带值定位，保存期早反馈优于入站静默拒绝）；落盘后入站解析每请求
	// 现读，保存即时生效无需重启
	if req.HookURLAllowHosts != nil {
		cleaned, err := config.NormalizeHookURLAllowHosts(*req.HookURLAllowHosts)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
			return
		}
		cfg.Server.HookURLAllowHosts = cleaned
	}
	// 审批窗口过程实况录制开关（P-20261001-15）：指针直接透传（nil=不动，
	// 保持原值/默认关）。关闭后活动录制由 recording 模块经 settings.changed
	// 观察者立即收尾，无需重启
	if req.ApprovalRecording != nil {
		cfg.Server.ApprovalRecording = req.ApprovalRecording
	}
	// pending 审批等待超时自动拒绝（P-20261003-45）：0=不超时（默认，存量行为
	// 不变）；1~1440 分钟有效。nil=不动
	if req.AgentApprovalTimeoutMin != nil {
		if !config.AgentApprovalTimeoutMinValid(*req.AgentApprovalTimeoutMin) {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("agentApprovalTimeoutMin out of range (0 or 1-1440): %d", *req.AgentApprovalTimeoutMin))
			return
		}
		cfg.Server.AgentApprovalTimeoutMin = *req.AgentApprovalTimeoutMin
	}
	if req.GitNetworkTimeoutSec != nil {
		// 范围 30 ~ 21600（6 小时）：下限防误配过小值误杀正常远端操作，
		// 上限防离谱配置让兜底名存实亡；0/负值 = 回落默认 900（不允许关闭兜底）
		v := *req.GitNetworkTimeoutSec
		if v < 0 || v > 21600 {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("gitNetworkTimeoutSec out of range (0 or 30-21600): %d", v))
			return
		}
		cfg.Server.GitNetworkTimeoutSec = v
	}
	// 审计/运行日志保留天数（P-20261003-123）：0 = 回落默认（30/15，存量行为）；
	// 1~3650 显式有效；越界拒绝（上限封顶合规留档场景，防手滑超大值让清理
	// 名存实亡——超长留存的磁盘责任注记见设置页）。nil = 不动。生效路径：
	// 各清理点执行时读当前配置（审计/日志每日巡更），无需重启
	if req.AuditRetentionDays != nil {
		if !config.RetentionDaysValid(*req.AuditRetentionDays) {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("auditRetentionDays out of range (0 or 1-%d): %d", config.MaxRetentionDays, *req.AuditRetentionDays))
			return
		}
		cfg.Server.AuditRetentionDays = *req.AuditRetentionDays
	}
	if req.LogRetentionDays != nil {
		if !config.RetentionDaysValid(*req.LogRetentionDays) {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("logRetentionDays out of range (0 or 1-%d): %d", config.MaxRetentionDays, *req.LogRetentionDays))
			return
		}
		cfg.Server.LogRetentionDays = *req.LogRetentionDays
	}
	// 用户 UI 现场上报开关（P-20261004-52）：指针直接透传（nil=不动，保持原值/
	// 默认开）。双侧即时生效：上报侧经 settings.changed 广播重读停发，读取侧
	// 判定点现读配置（uisnap.go uisnapEnabled）
	if req.UISnapshotEnabled != nil {
		cfg.Server.UISnapshotEnabled = req.UISnapshotEnabled
	}
	// 敏感文件工作台外写入观测开关（P-20261005-15）：指针直接透传（nil=不动，
	// 保持原值/默认开）。生效即时：watcher 判定点现读配置，无需重启
	if req.SensitiveExternalWatch != nil {
		cfg.Server.SensitiveExternalWatch = req.SensitiveExternalWatch
	}
	// 预览面板同源兼容模式（P-20261019-1）：指针直接透传（nil=不动，保持原值/
	// 默认关=沙箱隔离）。生效即时：前端经 settings.changed 广播重读档位，
	// PreviewPanel 姿态翻转即重载 iframe（无需重启）
	if req.PreviewCompatMode != nil {
		cfg.Server.PreviewCompatMode = req.PreviewCompatMode
	}
	if req.DshWebBase != nil {
		v := strings.TrimSpace(*req.DshWebBase)
		if v != "" && !strings.HasPrefix(v, "http://") && !strings.HasPrefix(v, "https://") {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid dshWebBase: must start with http:// or https://"))
			return
		}
		cfg.Server.DshWebBase = v // 空串 = 回落默认 3080
	}
	if req.DshWebToken != nil {
		cfg.Server.DshWebToken = strings.TrimSpace(*req.DshWebToken)
	}
	if req.DshLaunchCommand != nil {
		cfg.Server.DshLaunchCommand = strings.TrimSpace(*req.DshLaunchCommand)
	}
	if req.DshProxyPort != nil {
		if *req.DshProxyPort < 0 || *req.DshProxyPort > 65535 {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("dshProxyPort out of range: %d", *req.DshProxyPort))
			return
		}
		cfg.Server.DshProxyPort = *req.DshProxyPort
	}
	if req.DshExposeAll != nil {
		cfg.Server.DshExposeAll = *req.DshExposeAll
	}
	if req.DshAllowStandalone != nil {
		cfg.Server.DshAllowStandalone = req.DshAllowStandalone
	}
	if req.DshNpmCommand != nil {
		cfg.Server.DshNpmCommand = strings.TrimSpace(*req.DshNpmCommand)
	}
	if req.DshRollbackVersion != nil {
		cfg.Server.DshRollbackVersion = strings.TrimSpace(*req.DshRollbackVersion)
	}
	// 更新链四字段（分发源/出站代理/探测开关/通道）任一被携带即标记，组内校验
	// 全部通过后统一经 update.ApplySource 单点重装配一次（P-20261110-1 S6 收口：
	// 探测开关开时装配点会同步探测系统代理，原先每字段各调一次在多字段保存时
	// 会重复探测）
	reapplyUpdate := false
	if req.UpdateURL != nil {
		// 更新分发源（serve-binary 跨平台缓存的 GitHub Release 地址）：
		// 空串 = 清除（同平台子实例直接用中心自身二进制，无需更新源）；
		// 非空仅允许 https——更新通道承载可执行文件，明文 http 是供应链风险
		//（与 update.NewGitHubSource 的入站校验一致，这里提供保存期早反馈）
		u := strings.TrimSpace(*req.UpdateURL)
		if u != "" && !strings.HasPrefix(u, "https://") {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid updateURL (https only): %s", *req.UpdateURL))
			return
		}
		cfg.Server.UpdateURL = u
		// 运行时热接线（P-20261106）：自更新源按新设置即时重装配（空=官方仓
		// 内置回填），不必重启
		reapplyUpdate = true
	}
	// 更新链出站代理（P-20261109-12）：空串=清除（回环境变量感知）；非空仅接受
	// http/https/socks5/socks5h，缺端口补默认归一。回环/内网代理地址合法（本地
	// clash 端口、公司内网代理正是目标场景）。保存即热化（update.ApplySource 重装
	// 出站状态与更新源），代理路径守卫=官方域白名单（urlsafety.go）
	if req.UpdateProxy != nil {
		v, err := update.NormalizeProxyURL(*req.UpdateProxy)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
			return
		}
		cfg.Server.UpdateProxy = v
		reapplyUpdate = true
	}
	// 系统代理自动探测开关（P-20261110-1 S6）：省略 = 不动；保存即热化——经
	// update.ApplySource 既有单点重装配出站态（开时装配点同步探测一次），选路档序
	// 显式 > env > 系统探测 > 直连
	if req.UpdateProxyAutoDetect != nil {
		cfg.Server.UpdateProxyAutoDetect = *req.UpdateProxyAutoDetect
		reapplyUpdate = true
	}
	// 自动检查更新开关（P-20261103-1）：省略 = 不动；false = 定时检查完全
	// 静默（手动检查不受影响——更新源内置化后始终可检）
	if req.UpdateChecks != nil {
		cfg.Server.UpdateChecks = *req.UpdateChecks
	}
	// 更新通道（P-20261103-3）：仅 stable/prerelease 二值（大小写归一），
	// 非法值 400 早反馈；prerelease 时检查口径含 beta/rc（应用链与校验链零特例）
	if req.UpdateChannel != nil {
		ch := strings.ToLower(strings.TrimSpace(*req.UpdateChannel))
		if ch != "stable" && ch != "prerelease" {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid updateChannel %q (stable|prerelease only)", *req.UpdateChannel))
			return
		}
		cfg.Server.UpdateChannel = ch
		// 运行时热切换（P-20261106）：通道标志原本只在 update Init 接线一次，
		// 保存后要重启才生效（用户实锚：开了「跟进预发布版本」仍查不到 beta）
		// ——这里按新设置即时重装配源，开关保存即生效
		reapplyUpdate = true
	}
	if reapplyUpdate {
		update.ApplySource(cfg)
	}
	// 外部访问地址（P-20261019-10）：只接受 http/https origin（无凭据/路径/
	// query/fragment，尾斜杠归一），空串=清除（二维码接力回落当前地址/局域网
	// 候选）。校验失败 400 早反馈；该值只作二维码/复制内容，不参与任何重定向
	if req.ExternalAccessURL != nil {
		v, err := config.NormalizeExternalAccessURL(*req.ExternalAccessURL)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
			return
		}
		cfg.Server.ExternalAccessURL = v
	}
	// 多实例同步本端落位根（P-20261023-1）：空串=恢复默认；非空须为绝对路径
	//（白名单前缀边界依赖绝对形态——相对路径会让「前缀内」判定随进程 cwd 漂移）
	if req.SyncDestRoot != nil {
		v := strings.TrimSpace(*req.SyncDestRoot)
		if v != "" && !filepath.IsAbs(v) {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("syncDestRoot must be an absolute directory path"))
			return
		}
		cfg.Server.SyncDestRoot = v
	}
	// 新建文件分享默认有效期（P-20261020-5）：permanent/1d/7d/30d（空串 =
	// permanent）；1h 只在单次创建可选。写入即生效（创建链每次现读配置）
	if req.ShareDefaultTTL != nil {
		v := strings.TrimSpace(*req.ShareDefaultTTL)
		if !config.ValidShareDefaultTTL(v) {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("invalid shareDefaultTTL (permanent, 1d, 7d, 30d): %s", *req.ShareDefaultTTL))
			return
		}
		cfg.Server.ShareDefaultTTL = v
	}
	// 分享链接外发基址（P-20261020-2）：与外部访问地址同一套 origin 校验；
	// 分享链接可能指向主应用 origin（同源 /s/ 代理），也可能指向专用分享域名，
	// 因此独立成键。空串=清除，前端回落自动选址；改值无需重启（每次拼链现读）
	if req.SharePublicBaseURL != nil {
		v, err := config.NormalizeSharePublicBaseURL(*req.SharePublicBaseURL)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
			return
		}
		cfg.Server.SharePublicBaseURL = v
	}
	// 可信反向代理清单（P-20261020-1）：写路径即校验（IP/CIDR 非法直接 400，
	// 避免带病配置在下次重启时降级为无信任却无人知晓）。空数组=显式不信任，
	// 与缺省等价；保存后下次启动经 ApplyTrustedProxies 生效（不热更新——
	// Gin 信任表与进程级匹配器同源，热切会让在途请求口径漂移）
	if req.TrustedProxies != nil {
		v, err := config.NormalizeTrustedProxies(*req.TrustedProxies)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
			return
		}
		cfg.Server.TrustedProxies = v
	}
	// TLS：启用后需重启进程生效（监听器在启动期装配）。
	// 指针直接透传（nil=未配置不动，保持原值/默认开）。
	// cert/key 成对校验：只填其一必然导致启动期加载失败，保存期即拒绝
	if req.TLSEnabled != nil {
		cfg.Server.TLSEnabled = req.TLSEnabled
	}
	if req.TLSCertFile != nil {
		cfg.Server.TLSCertFile = strings.TrimSpace(*req.TLSCertFile)
	}
	if req.TLSKeyFile != nil {
		cfg.Server.TLSKeyFile = strings.TrimSpace(*req.TLSKeyFile)
	}
	if cfg.Server.TLSCertFile != "" || cfg.Server.TLSKeyFile != "" {
		if cfg.Server.TLSCertFile == "" || cfg.Server.TLSKeyFile == "" {
			shared.Error(c, http.StatusBadRequest, "Settings operation failed",
				fmt.Errorf("tlsCertFile and tlsKeyFile must be provided together (or leave both empty for auto-generated self-signed certificate)"))
			return
		}
	}
	// 实例间 TLS 校验策略：客户端侧即时生效（探测/代理/从中心更新按当前
	// 策略连接），切换后清空实例连接池使存量池化客户端按新策略重建
	//（代理池 + 探测客户端；更新下载与 WS 每次新建连接，无需清理）
	if req.TLSVerifyPeer != nil {
		old := cfg.Server.TLSVerifyPeerOrDefault()
		cfg.Server.TLSVerifyPeer = req.TLSVerifyPeer
		if old != *req.TLSVerifyPeer {
			proxy.ResetInstanceClients()
			checkHTTPClient.CloseIdleConnections()
		}
	}

	// 远程接入中继档案（P-20261019-11）：档案列表全量替换；密码留空 = 保持
	// 原密文（GET 不回密码）。运行态 enabled/activeId 保留服务端现值——启停
	// 与切换只经 POST /api/remoteaccess/tunnel，避免档案保存误改运行态。
	// sshkey 档案校验引用存在（被删密钥的档案保存期即拒绝，免启用时才发现）。
	if req.RemoteAccess != nil {
		next := *req.RemoteAccess
		if cfg.Server.RemoteAccess != nil {
			next.Enabled = cfg.Server.RemoteAccess.Enabled
			next.ActiveID = cfg.Server.RemoteAccess.ActiveID
		} else {
			next.Enabled = false
			next.ActiveID = ""
		}
		norm, err := config.NormalizeRemoteAccess(&next, cfg.Server.RemoteAccess)
		if err != nil {
			shared.ErrorWithCode(c, shared.CodeRemoteAccessConfigInvalid, "invalid remoteAccess settings", err)
			return
		}
		if norm != nil {
			for i := range norm.Profiles {
				p := &norm.Profiles[i]
				if p.AuthType != config.RemoteAccessAuthSSHKey {
					continue
				}
				if _, err := store.Get().SshKey.GetByID(p.SshKeyID); err != nil {
					shared.ErrorWithCode(c, shared.CodeRemoteAccessConfigInvalid, "invalid remoteAccess settings",
						fmt.Errorf("profile %q: ssh key %q not found", p.Name, p.SshKeyID))
					return
				}
			}
		}
		cfg.Server.RemoteAccess = norm
	}

	// 用户偏好漫游单键（P-20261007-1）：省略=不动 / null=清空 / 对象=全量替换；
	// 对对象仅两道校验（合法 JSON + ≤64KB）——内部键域 schema 前端自治，服务端
	// 不做结构白名单（后续新增偏好键零 Go 改动）。归一（compact）后整体替换落盘；
	// 成功后随下方 settings.changed 广播，各端启动期/广播期拉取应用（服务端真值 wins）
	if len(req.UserPrefs) > 0 {
		if string(req.UserPrefs) == "null" {
			// 显式 null = 清空（nil 落盘 omitempty 不写键，GET 回 null）——
			// 恢复「服务端未配置」形态，各端下次启动/广播走播种分支而非回默认
			cfg.Server.UserPrefs = nil
		} else {
			if err := config.ValidateUserPrefs(req.UserPrefs); err != nil {
				shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
				return
			}
			cfg.Server.UserPrefs = config.NormalizeUserPrefs(req.UserPrefs)
		}
	}

	if err := store.Get().Settings.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Settings operation failed", err)
		return
	}

	// tmux 鼠标接管热切换（P-20261109-7）：落盘成功才执行（失败即未生效无切换），
	// mouse 逐事件读取——现存全部专有 socket 会话即刻生效，新值下次 Create 运行
	// 同步兜底。仅本字段被显式携带时执行（每次保存都戳 tmux 是无谓 exec）
	if req.TerminalTmuxMouseEnabled != nil {
		terminal.ApplyTmuxMouseOption(*req.TerminalTmuxMouseEnabled)
	}

	// 自定义敏感模式注册表即时同步（P-20261006-11）：落盘成功才注入（失败即
	// 未生效无注入），Go 侧三消费面（命令历史跳过/审计脱敏/快照遮蔽）下一次
	// 判定即读新表，无需重启；TS 侧经下方 settings.changed 广播各自重拉
	mask.SetCustomPatterns(cfg.Server.CustomSensitivePatterns)

	// 审批档位翻转审计入账（P-20261005-162，best-effort 同 DeleteRemoteHost 惯例）：
	// 全局审批档位是安全姿态旋钮，「谁在何时切到放行/收回」只看配置终态无从追认。
	// 落盘成功后才记账（失败即未生效无账可记）；Detail 语言中立 old→new，
	// 24h 档追记到期时刻（RFC3339，时限档位的边界证据）。resolve/巡检两个写点
	// 在 ai 包同 action 入账，三处 detail 形态一致
	if req.AgentApprovalMode != nil && *req.AgentApprovalMode != oldApprovalMode {
		detail := oldApprovalMode + " → " + *req.AgentApprovalMode
		if *req.AgentApprovalMode == config.ApprovalModeAllow24h {
			detail += " (expires " + cfg.Server.AgentApprovalExpiresAt.UTC().Format(time.RFC3339) + ")"
		}
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditApprovalMode,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: detail,
		})
	}

	// 智能操作通道：通知前端设置已变（订阅方实时刷新主题/字体等，无需手动刷新页面）
	opschannel.BroadcastEvent(opschannel.EventSettingsChanged, nil)

	c.JSON(http.StatusOK, gin.H{"message": "settings updated"})
}

// GetGitConfig 获取项目级别的 Git 配置
func GetGitConfig(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	keys := []string{"user.name", "user.email"}
	result := gin.H{}
	for _, key := range keys {
		val, err := git.ExecGitConfig(p.Path, key)
		if err == nil {
			result[key] = strings.TrimSpace(val)
		}
	}

	c.JSON(http.StatusOK, gin.H{"data": result})
}

// SetGitConfig 设置项目级别的 Git 配置（仅允许 user.name 和 user.email）
func SetGitConfig(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req map[string]string
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
		return
	}

	// 安全白名单：只允许设置 user.name 和 user.email
	allowed := map[string]bool{"user.name": true, "user.email": true}
	for key, val := range req {
		if !allowed[key] {
			shared.Error(c, http.StatusBadRequest, "config key not allowed: "+key, nil)
			return
		}
		if err := git.SetGitConfig(p.Path, key, val); err != nil {
			shared.Error(c, http.StatusInternalServerError, "Settings operation failed", err)
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"message": "git config updated"})
}

// HealthCheck 健康检查端点，不受认证中间件保护
func HealthCheck(c *gin.Context) {
	checks := make(map[string]string)

	if _, err := exec.LookPath("git"); err != nil {
		checks["git"] = "unavailable"
	} else {
		checks["git"] = "ok"
	}

	dataDir := config.DataDir()
	if _, err := os.Stat(dataDir); err != nil {
		checks["datadir"] = "unreachable"
	} else {
		checks["datadir"] = "ok"
	}

	for _, v := range checks {
		if v != "ok" {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "degraded", "checks": checks})
			return
		}
	}
	// 内存观测（决策门 M5.2）：长会话 RSS 观察项——健康端点顺带暴露内存水位，
	// 供外部监控/排查读取；HeapAlloc=存活堆，Sys=向 OS 申请的总量
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"checks": checks,
		"memory": gin.H{
			"heapAllocMB": ms.HeapAlloc / 1024 / 1024,
			"sysMB":       ms.Sys / 1024 / 1024,
			"numGC":       ms.NumGC,
		},
		"process": gin.H{
			"goroutines":    runtime.NumGoroutine(),
			"uptimeSeconds": int(time.Since(processStartTime).Seconds()),
		},
		// 磁盘水位观测（P-20261002-12）：数据盘 + 系统盘（同卷去重），
		// 监控面板据此渲染水位条卡片
		"disk": gin.H{"volumes": diskVolumes()},
	})
}
