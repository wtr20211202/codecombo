package system

// 用户自定义智能体运行时管理（config.Server.CustomAgents 的 CRUD）：
// 增删改即时持久化并同步进 agentops Provider 注册表——此后新建会话下拉、
// 可用性/版本探测、agentLaunchCommands 覆盖、默认智能体白名单与内置
// 运行时（claude/codex/dsh）走同一条链路，无需重启进程。

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// customAgentNameRe 注册名约束：小写字母/数字开头，可含 - _ ，≤64 字符。
// 注册名是会话 meta 落库值 + agentLaunchCommands 的 key + URL 路径参数，
// 收紧字符集避免键位/URL 双重歧义；展示自由度由 displayName 承担
var customAgentNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// customAgentPayload 增/改请求体。Name 更新时可缺省（沿用 URL 中的旧名，
// 即"只改显示名/命令"场景）；显式传入且与旧名不同 = 改名
type customAgentPayload struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Command     string `json:"command"`
}

// CreateCustomAgent POST /api/settings/custom-agents
func CreateCustomAgent(c *gin.Context) {
	upsertCustomAgent(c, "")
}

// UpdateCustomAgent PUT /api/settings/custom-agents/:name
func UpdateCustomAgent(c *gin.Context) {
	upsertCustomAgent(c, c.Param("name"))
}

// upsertCustomAgent 新增（oldName 空）/ 更新（可改名）共用主链路
func upsertCustomAgent(c *gin.Context, oldName string) {
	var req customAgentPayload
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = oldName // 未显式传 name = 沿用旧名
	}

	cfg := store.Get().Settings.Get()
	if cfg == nil {
		shared.Error(c, http.StatusInternalServerError, "Settings operation failed",
			fmt.Errorf("settings not initialized"))
		return
	}
	// 更新入口必须指向已存在的项（create 场景 oldName 为空，跳过）
	if oldName != "" && cfg.Server.FindCustomAgent(oldName) == nil {
		shared.Error(c, http.StatusNotFound, "custom agent not found",
			fmt.Errorf("custom agent not found: %s", oldName))
		return
	}
	agent, err := validateCustomAgent(cfg, name, oldName, req.DisplayName, req.Command)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "Settings operation failed", err)
		return
	}

	// 改名 = 摘旧插新（其余字段 SaveCustomAgent 按 Name 幂等覆盖）
	if oldName != "" && oldName != agent.Name {
		cfg.Server.DeleteCustomAgent(oldName)
		// 启动命令覆盖与默认选型跟着迁移，改名不丢用户配置
		if cfg.Server.AgentLaunchCommands != nil {
			if v, ok := cfg.Server.AgentLaunchCommands[oldName]; ok {
				delete(cfg.Server.AgentLaunchCommands, oldName)
				cfg.Server.AgentLaunchCommands[agent.Name] = v
			}
		}
		if cfg.Server.AgentProvider == oldName {
			cfg.Server.AgentProvider = agent.Name
		}
	}
	cfg.Server.SaveCustomAgent(agent)

	if !saveAndSyncSettings(c, cfg) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"customAgents": customAgentsJSON(cfg)}})
}

// DeleteCustomAgent DELETE /api/settings/custom-agents/:name。
// 级联清理：该运行时的启动命令覆盖、指向它的默认智能体选型
func DeleteCustomAgent(c *gin.Context) {
	name := c.Param("name")
	cfg := store.Get().Settings.Get()
	if cfg == nil || cfg.Server.FindCustomAgent(name) == nil {
		shared.Error(c, http.StatusNotFound, "custom agent not found",
			fmt.Errorf("custom agent not found: %s", name))
		return
	}
	cfg.Server.DeleteCustomAgent(name)
	if cfg.Server.AgentLaunchCommands != nil {
		delete(cfg.Server.AgentLaunchCommands, name)
	}
	if cfg.Server.AgentProvider == name {
		cfg.Server.AgentProvider = "auto"
	}

	if !saveAndSyncSettings(c, cfg) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"customAgents": customAgentsJSON(cfg)}})
}

// validateCustomAgent 入参校验 + 清洗。oldName 非空时注册名冲突检查豁免自身
// （更新不改名的场景），改名撞其他运行时仍然拒绝
func validateCustomAgent(cfg *config.Config, name, oldName, displayName, command string) (config.CustomAgent, error) {
	if !customAgentNameRe.MatchString(name) {
		return config.CustomAgent{}, fmt.Errorf("invalid custom agent name (lowercase letters/digits, may contain - _, max 64): %s", name)
	}
	// 保留名：auto 是选型关键字，shell 是一等纯终端运行时；其余撞已注册
	// 运行时（内置 + 已配置的自定义）一律拒绝
	if name == "auto" || name == "shell" {
		return config.CustomAgent{}, fmt.Errorf("custom agent name is reserved: %s", name)
	}
	if name != oldName && agentops.IsRegisteredProvider(name) {
		return config.CustomAgent{}, fmt.Errorf("custom agent name conflicts with registered runtime: %s", name)
	}
	displayName = strings.TrimSpace(displayName)
	if len(displayName) > 60 {
		return config.CustomAgent{}, fmt.Errorf("displayName too long (max 60): %d", len(displayName))
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return config.CustomAgent{}, fmt.Errorf("command is required")
	}
	// 与 agentLaunchCommands 同一上限：经 PTY 注入 shell 执行（与手敲等价），
	// 上限防误粘超长串
	if len(command) > 200 {
		return config.CustomAgent{}, fmt.Errorf("command too long (max 200): %d", len(command))
	}
	return config.CustomAgent{Name: name, DisplayName: displayName, Command: command}, nil
}

// saveAndSyncSettings 持久化设置并把自定义运行时段同步进注册表（增删改共用）。
// 同步后 IsRegisteredProvider / Runtimes / 选型即刻生效；广播 settings.changed
// 与 UpdateSettings 口径一致（订阅方实时跟随）
func saveAndSyncSettings(c *gin.Context, cfg *config.Config) bool {
	if err := store.Get().Settings.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Settings operation failed", err)
		return false
	}
	agentops.SyncCustomAgents(cfg.Server.CustomAgents)
	opschannel.BroadcastEvent(opschannel.EventSettingsChanged, nil)
	return true
}

// customAgentsJSON 对外快照（nil 落空数组，前端免判 null）
func customAgentsJSON(cfg *config.Config) []config.CustomAgent {
	if len(cfg.Server.CustomAgents) == 0 {
		return []config.CustomAgent{}
	}
	return cfg.Server.CustomAgents
}
