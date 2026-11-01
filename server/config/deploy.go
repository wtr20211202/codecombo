package config

import "time"

// DeployConfig 全局部署配置（Anthropic 凭据 + 模型 + 本地二进制目录）
type DeployConfig struct {
	AnthropicToken   string `json:"anthropicToken"`   // enc: 加密
	AnthropicBaseURL string `json:"anthropicBaseUrl"`
	Model            string `json:"model"` // 统一模型（远程 Claude Code 的 opus/sonnet/haiku/subagent 槽位共用）
	BinaryDir        string `json:"binaryDir"`
}

// ApplyDefaults 填充默认值（不覆盖已设置项）；Base URL 无默认值，留空须用户显式配置
func (c *DeployConfig) ApplyDefaults() {
	if c.Model == "" {
		c.Model = "glm-5.3[1m]"
	}
}

// DeployerInstance 一个 Deployer 的执行实例（含参数）
type DeployerInstance struct {
	DeployerID string            `json:"deployerId"`
	Params     map[string]string `json:"params"`
}

// DeployTask 部署任务
type DeployTask struct {
	ID           string             `json:"id"`
	HostID       string             `json:"hostId"`
	Host         string             `json:"host"`
	Instances    []DeployerInstance `json:"instances"`
	Status       string             `json:"status"`
	CurrentIndex int                `json:"currentIndex"`
	CurrentStep  string             `json:"currentStep"`
	Error        string             `json:"error,omitempty"`
	StartedAt    *time.Time         `json:"startedAt,omitempty"`
	FinishedAt   *time.Time         `json:"finishedAt,omitempty"`
	PublicKeys   []PublicKeyEntry   `json:"publicKeys,omitempty"`
	// WaitingFor 排队等待的同主机在途任务 id（P-20261004-36）：仅 queued 排队态
	// 非空，取到锁进入 running 或落终态时清空。增量字段（omitempty），旧记录
	// 反序列化为空串，升级兼容无需迁移
	WaitingFor string `json:"waitingFor,omitempty"`
}

// PublicKeyEntry init_ssh_key 实例完成后的公钥回传
type PublicKeyEntry struct {
	KeyName   string `json:"keyName"`
	PublicKey string `json:"publicKey"`
}

// 任务状态
const (
	TaskStatusQueued    = "queued"
	TaskStatusRunning   = "running"
	TaskStatusCompleted = "completed"
	TaskStatusFailed    = "failed"
	TaskStatusCancelled = "cancelled"
)

// IsTerminal 判断任务是否已结束
func (t *DeployTask) IsTerminal() bool {
	switch t.Status {
	case TaskStatusCompleted, TaskStatusFailed, TaskStatusCancelled:
		return true
	}
	return false
}

// Duration 计算任务耗时（未结束则用当前时间）
func (t *DeployTask) Duration() time.Duration {
	if t.StartedAt == nil {
		return 0
	}
	end := time.Now()
	if t.FinishedAt != nil {
		end = *t.FinishedAt
	}
	return end.Sub(*t.StartedAt)
}
