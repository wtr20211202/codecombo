package deploy

import (
	"context"
	"fmt"

	"codecombo/server/sshclient"
)

// InitUserDeployer 创建 cld 用户 + sudoers 免密
type InitUserDeployer struct{}

// cldUser 部署目标用户名
const cldUser = "cld"

func (d *InitUserDeployer) ID() string          { return "init_user" }
func (d *InitUserDeployer) Name() string        { return "deploy.tools.init_user.name" }
func (d *InitUserDeployer) Category() string    { return CategoryInit }
func (d *InitUserDeployer) Description() string { return "deploy.tools.init_user.description" }
func (d *InitUserDeployer) DependsOn() []string { return nil }
func (d *InitUserDeployer) Steps() []string {
	return []string{
		"deploy.steps.preflight",
		"deploy.steps.useradd",
		"deploy.steps.sudoers",
	}
}
func (d *InitUserDeployer) AllowMultiple() bool       { return false }
func (d *InitUserDeployer) ParamsSchema() []ParamSpec { return nil }

// Deploy 执行三步：preflight（已存在跳过）→ useradd → 写 sudoers
func (d *InitUserDeployer) Deploy(ctx context.Context, p DeployParams) error {
	log := p.Log

	log.LogKV("preflight", LevelInfo, "deploy.log.init_user.checking", map[string]any{"user": cldUser})
	out, _ := p.SSH.Exec(ctx, execOpts("id "+cldUser), nil)
	if out != nil && out.ExitCode == 0 {
		log.LogKV("preflight", LevelOK, "deploy.log.init_user.existsSkip", map[string]any{"user": cldUser})
		return nil
	}

	// 探测可用的 sudo 组：RHEL 系用 wheel，Debian/Ubuntu 系用 sudo
	// WSL Ubuntu 默认没有 wheel 组，useradd -G wheel 会 exit 6
	sudoGroup := probeSudoGroup(ctx, p.SSH)

	log.LogKV("useradd", LevelInfo, "deploy.log.init_user.creating",
		map[string]any{"user": cldUser, "group": sudoGroup})
	useraddCmd := fmt.Sprintf("useradd -m -s /bin/bash %s", cldUser)
	if sudoGroup != "" {
		useraddCmd = fmt.Sprintf("useradd -m -G %s -s /bin/bash %s", sudoGroup, cldUser)
	}
	if _, err := execOrFail(ctx, p, "useradd", "useradd", execOpts(useraddCmd), nil); err != nil {
		return err
	}
	log.LogKV("useradd", LevelOK, "deploy.log.init_user.created", map[string]any{"user": cldUser})

	const sudoConf = "/etc/sudoers.d/99-codecombo"
	log.LogKV("sudoers", LevelInfo, "deploy.log.init_user.writingSudoers", map[string]any{"path": sudoConf})
	cmd := fmt.Sprintf(`echo '%s ALL=(ALL) NOPASSWD: ALL' > %s && chmod 440 %s`, cldUser, sudoConf, sudoConf)
	if _, err := execOrFail(ctx, p, "sudoers", "sudoers", execOpts(cmd), nil); err != nil {
		return err
	}
	log.LogKV("sudoers", LevelOK, "deploy.log.init_user.sudoersConfigured", nil)
	return nil
}

// probeSudoGroup 探测系统可用的 sudo 组：优先 wheel（RHEL 系），其次 sudo（Debian 系）
// 都没有则返回空字符串，useradd 时不指定附加组（sudoers 仍可单独配置）
func probeSudoGroup(ctx context.Context, c *sshclient.Client) string {
	// getent group <name> exit 0 表示组存在
	out, _ := c.Exec(ctx, execOpts("getent group wheel"), nil)
	if out != nil && out.ExitCode == 0 {
		return "wheel"
	}
	out, _ = c.Exec(ctx, execOpts("getent group sudo"), nil)
	if out != nil && out.ExitCode == 0 {
		return "sudo"
	}
	return ""
}

func init() {
	Register(&InitUserDeployer{})
}
