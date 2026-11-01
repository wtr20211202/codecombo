package deploy

import (
	"context"
	"fmt"
	"net"
	"strings"

	"codecombo/server/sshclient"
)

// InitSshKeyDeployer 在 cld 用户下生成 ed25519 SSH Key + 配置 ssh-agent + ssh config
// AllowMultiple=true，可通过不同 keyName 在一次任务中部署多个 key（github/gitlab 等）
type InitSshKeyDeployer struct{}

func (d *InitSshKeyDeployer) ID() string          { return "init_ssh_key" }
func (d *InitSshKeyDeployer) Name() string        { return "deploy.tools.init_ssh_key.name" }
func (d *InitSshKeyDeployer) Category() string    { return CategoryDevTool }
func (d *InitSshKeyDeployer) Description() string { return "deploy.tools.init_ssh_key.description" }
func (d *InitSshKeyDeployer) DependsOn() []string { return []string{"init_user"} }
func (d *InitSshKeyDeployer) Steps() []string {
	return []string{
		"deploy.steps.preflight",
		"deploy.steps.genKey",
		"deploy.steps.agent",
		"deploy.steps.config",
		"deploy.steps.verify",
	}
}
func (d *InitSshKeyDeployer) AllowMultiple() bool { return true }
func (d *InitSshKeyDeployer) ParamsSchema() []ParamSpec {
	return []ParamSpec{
		{
			Key: "keyName", Label: "deploy.tools.init_ssh_key.params.keyName",
			Type: "text", Required: true, Default: "id_ed25519",
			Placeholder: "deploy.tools.init_ssh_key.params.keyName.placeholder",
		},
		{
			Key: "email", Label: "deploy.tools.init_ssh_key.params.email",
			Type: "email", Required: true,
			Placeholder: "deploy.tools.init_ssh_key.params.email.placeholder",
		},
		{
			// gitHost：目标 Git 平台 host，默认 github.com，支持 host:port 形式
			Key: "gitHost", Label: "deploy.tools.init_ssh_key.params.gitHost",
			Type: "text", Required: true, Default: "github.com",
			Placeholder: "deploy.tools.init_ssh_key.params.gitHost.placeholder",
			Help:        "deploy.tools.init_ssh_key.params.gitHost.help",
		},
	}
}

// Deploy 流程：preflight → genKey（存在跳过）→ agent → config → verify（回传公钥）
func (d *InitSshKeyDeployer) Deploy(ctx context.Context, p DeployParams) error {
	log := p.Log
	keyName, err := p.MustGetString("keyName")
	if err != nil {
		return err
	}
	email, err := p.MustGetString("email")
	if err != nil {
		return err
	}
	gitHost, err := p.MustGetString("gitHost")
	if err != nil {
		return err
	}

	// 拆解 host:port（标准 net.SplitHostPort 解析失败视为纯 host）
	host := gitHost
	port := ""
	if h, p, e := net.SplitHostPort(gitHost); e == nil {
		host = h
		port = p
	}

	log.LogKV("preflight", LevelInfo, "deploy.log.init_ssh_key.targetKey",
		map[string]any{"keyName": keyName, "email": email})
	out, _ := p.SSH.Exec(ctx, execOpts("id "+cldUser), nil)
	if out == nil || out.ExitCode != 0 {
		return fmt.Errorf("cld user not exists, run init_user first")
	}

	log.LogKV("genKey", LevelInfo, "deploy.log.init_ssh_key.checkingKey", nil)
	genCmd := fmt.Sprintf(`sudo -u %s bash -lc '
set -e
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if [ ! -f ~/.ssh/%s ]; then
  ssh-keygen -t ed25519 -C "%s" -f ~/.ssh/%s -N ""
  echo GENERATED
else
  echo EXISTS
fi
'`, cldUser, keyName, email, keyName)
	out, err = execOrFail(ctx, p, "genKey", "ssh-keygen", sshclient.ExecOptions{Cmd: genCmd}, nil)
	if err != nil {
		return err
	}
	if n := len(out.Stdout); n > 0 {
		switch strings.TrimSpace(out.Stdout[n-1]) {
		case "GENERATED":
			log.LogKV("genKey", LevelOK, "deploy.log.init_ssh_key.generated", nil)
		case "EXISTS":
			log.LogKV("genKey", LevelWarn, "deploy.log.init_ssh_key.existsSkip", nil)
		}
	}

	log.LogKV("agent", LevelInfo, "deploy.log.init_ssh_key.configuringAgent", nil)
	agentCmd := fmt.Sprintf(`sudo -u %s bash -lc '
MARK="# sc-managed: ssh-add %s"
if ! grep -qF "$MARK" ~/.bashrc 2>/dev/null; then
  {
    echo "$MARK"
    echo "[[ -z \"\$SSH_AUTH_SOCK\" ]] && eval \"\$(ssh-agent -s)\" >/dev/null"
    echo "ssh-add ~/.ssh/%s 2>/dev/null"
    echo "# sc-managed-end %s"
  } >> ~/.bashrc
fi
'`, cldUser, keyName, keyName, keyName)
	if _, err := p.SSH.Exec(ctx, sshclient.ExecOptions{Cmd: agentCmd}, nil); err != nil {
		log.LogKV("agent", LevelWarn, "deploy.log.init_ssh_key.agentFailed",
			map[string]any{"error": err.Error()})
	} else {
		log.LogKV("agent", LevelOK, "deploy.log.init_ssh_key.agentUpdated", nil)
	}

	if keyName != "id_ed25519" {
		log.LogKV("config", LevelInfo, "deploy.log.init_ssh_key.appendingAlias", nil)
		hostAlias := fmt.Sprintf("%s-%s", host, keyName)

		// SSH config 块：端口可选（gitHost 含端口时输出 Port 行）
		var sshConfigBlock string
		if port != "" {
			sshConfigBlock = fmt.Sprintf(`
Host %s
  HostName %s
  Port %s
  User git
  IdentityFile ~/.ssh/%s
  IdentitiesOnly yes
`, hostAlias, host, port, keyName)
		} else {
			sshConfigBlock = fmt.Sprintf(`
Host %s
  HostName %s
  User git
  IdentityFile ~/.ssh/%s
  IdentitiesOnly yes
`, hostAlias, host, keyName)
		}

		configCmd := fmt.Sprintf(`sudo -u %s bash -lc '
touch ~/.ssh/config && chmod 600 ~/.ssh/config
if ! grep -qF "Host %s" ~/.ssh/config 2>/dev/null; then
  cat >> ~/.ssh/config <<EOF
%s
EOF
  echo APPENDED
else
  echo EXISTS
fi
'`, cldUser, hostAlias, sshConfigBlock)
		out, err = p.SSH.Exec(ctx, sshclient.ExecOptions{Cmd: configCmd}, nil)
		if err != nil {
			log.LogKV("config", LevelWarn, "deploy.log.init_ssh_key.configFailed",
				map[string]any{"error": err.Error()})
		} else if n := len(out.Stdout); n > 0 {
			switch strings.TrimSpace(out.Stdout[n-1]) {
			case "APPENDED":
				log.LogKV("config", LevelOK, "deploy.log.init_ssh_key.aliasAppended", nil)
			case "EXISTS":
				log.LogKV("config", LevelOK, "deploy.log.init_ssh_key.aliasExists", nil)
			}
		}
	} else {
		log.LogKV("config", LevelOK, "deploy.log.init_ssh_key.aliasNotNeeded", nil)
	}

	log.LogKV("verify", LevelInfo, "deploy.log.init_ssh_key.readingPub", nil)
	pubCmd := fmt.Sprintf("sudo -u %s cat /home/%s/.ssh/%s.pub", cldUser, cldUser, keyName)
	out, err = p.SSH.Exec(ctx, execOpts(pubCmd), nil)
	if err != nil || len(out.Stdout) == 0 {
		msg := "read public key failed"
		if err != nil {
			msg = err.Error()
		}
		log.LogKV("verify", LevelFail, "deploy.log.init_ssh_key.readPubFailed",
			map[string]any{"error": msg})
		return fmt.Errorf("verify: %s", msg)
	}
	pub := strings.TrimSpace(out.Stdout[0])
	log.SetPublicKey(keyName, pub)
	log.LogKV("verify", LevelOK, "deploy.log.init_ssh_key.pubRetrieved",
		map[string]any{"bytes": len(pub)})
	return nil
}

func init() {
	Register(&InitSshKeyDeployer{})
}
