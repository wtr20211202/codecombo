// Package deploy 实现远程部署引擎：Deployer 插件接口、注册表、依赖补齐、任务管理
package deploy

import (
	"context"
	"fmt"

	"codecombo/server/config"
	"codecombo/server/sshclient"
)

// Category 常量
const (
	CategoryInit     = "init"
	CategoryDevTool  = "dev_tool"
	CategorySelfHost = "self_host"
)

// Deployer 部署工具接口
type Deployer interface {
	ID() string
	Name() string // i18n key（deploy.tools.<id>.name）
	Category() string
	Description() string // i18n key
	DependsOn() []string // 自动补齐依赖
	Steps() []string     // 阶段名（i18n key）
	AllowMultiple() bool // 是否允许一次任务多实例
	ParamsSchema() []ParamSpec
	Deploy(ctx context.Context, p DeployParams) error
}

// DeployParams 部署参数
type DeployParams struct {
	SSH    *sshclient.Client
	Host   *config.RemoteHost
	Cfg    *config.DeployConfig
	Params map[string]string
	Log    Logger
	Ctx    context.Context
}

// MustGetString 取必需参数
func (p DeployParams) MustGetString(key string) (string, error) {
	v, ok := p.Params[key]
	if !ok || v == "" {
		return "", fmt.Errorf("missing param: %s", key)
	}
	return v, nil
}

// GetString 取可选参数（带默认）
func (p DeployParams) GetString(key, def string) string {
	if v, ok := p.Params[key]; ok && v != "" {
		return v
	}
	return def
}
