package store

import (
	"encoding/json"
	"log/slog"

	"codecombo/server/config"
)

// deployConfig 单例 ID
const deployConfigSingletonID = "default"

type DeployConfigStore interface {
	Get() (*config.DeployConfig, error)
	Save(cfg config.DeployConfig) error
	// MigrateLegacyModelFields 存量四槽位模型字段（opusModel/sonnetModel/
	// haikuModel/subagentModel）收敛为单一 model 字段的一次性补迁移。
	// 启动期调用一次（同 sshkey.MigrateLegacyPem 先例：迁移类写盘副作用
	// 不进读路径）；幂等：model 已有值或无旧字段时不动
	MigrateLegacyModelFields() (int, error)
}

type deployConfigRepo struct{ doc DocumentStore }

func (r *deployConfigRepo) Get() (*config.DeployConfig, error) {
	data, err := r.doc.Get("deployconfig", deployConfigSingletonID)
	if err != nil || len(data) == 0 {
		cfg := &config.DeployConfig{}
		cfg.ApplyDefaults()
		return cfg, nil
	}
	var cfg config.DeployConfig
	if json.Unmarshal(data, &cfg) != nil {
		cfg = config.DeployConfig{}
	}
	cfg.ApplyDefaults()
	cfg.AnthropicToken = config.DecryptIfNeeded(cfg.AnthropicToken)
	return &cfg, nil
}

func (r *deployConfigRepo) Save(cfg config.DeployConfig) error {
	cfg.ApplyDefaults()
	cfg.AnthropicToken = config.EncryptIfNeeded(cfg.AnthropicToken)
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	return r.doc.Upsert("deployconfig", deployConfigSingletonID, data)
}

// legacyModelFields 旧版 DeployConfig 的四槽位模型字段（升级兼容审计
// P-20261005-197：四字段合并为单一 model 的 ed8e33c3 未带迁移，旧数据面
// 升级后用户自定义模型会静默回落默认值）——仅供迁移读取，不参与业务序列化
type legacyModelFields struct {
	OpusModel     string `json:"opusModel"`
	SonnetModel   string `json:"sonnetModel"`
	HaikuModel    string `json:"haikuModel"`
	SubagentModel string `json:"subagentModel"`
}

// MigrateLegacyModelFields 把存量 opusModel/sonnetModel/haikuModel/subagentModel
// 迁移为 model 单字段（取首个非空槽位，opus 为主槽位优先）。幂等：model
// 已有值（新格式或已迁移过）即不动；迁移后旧字段随新结构序列化自然消失。
// 直接操作原始文档，不经 Get 的解密/默认值链，避免写回半态
func (r *deployConfigRepo) MigrateLegacyModelFields() (int, error) {
	data, err := r.doc.Get("deployconfig", deployConfigSingletonID)
	if err != nil {
		return 0, nil // 无存量配置即无迁移
	}
	var cfg config.DeployConfig
	if json.Unmarshal(data, &cfg) != nil {
		return 0, nil // 解析不了的脏文档不碰，交给 Get 的降级路径
	}
	if cfg.Model != "" {
		return 0, nil
	}
	var legacy legacyModelFields
	if json.Unmarshal(data, &legacy) != nil {
		return 0, nil
	}
	for _, m := range []string{legacy.OpusModel, legacy.SonnetModel, legacy.HaikuModel, legacy.SubagentModel} {
		if m != "" {
			cfg.Model = m
			break
		}
	}
	if cfg.Model == "" {
		return 0, nil // 无可迁移值
	}
	out, err := json.Marshal(cfg)
	if err != nil {
		return 0, err
	}
	// Get 成功即文档存在；启动期无并发写者，Update 直写
	if err := r.doc.Update("deployconfig", deployConfigSingletonID, out); err != nil {
		return 0, err
	}
	slog.Info("deployconfig: legacy model fields migrated to single model", "model", cfg.Model)
	return 1, nil
}
