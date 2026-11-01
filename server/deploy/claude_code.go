package deploy

import (
	"context"
	"fmt"

	"codecombo/server/config"
	"codecombo/server/sshclient"
)

// ClaudeCodeDeployer 安装 Claude Code（依赖 init_user）
type ClaudeCodeDeployer struct{}

func (d *ClaudeCodeDeployer) ID() string          { return "claude_code" }
func (d *ClaudeCodeDeployer) Name() string        { return "deploy.tools.claude_code.name" }
func (d *ClaudeCodeDeployer) Category() string    { return CategoryDevTool }
func (d *ClaudeCodeDeployer) Description() string { return "deploy.tools.claude_code.description" }
func (d *ClaudeCodeDeployer) DependsOn() []string { return []string{"init_user"} }
func (d *ClaudeCodeDeployer) Steps() []string {
	return []string{
		"deploy.steps.preflight",
		"deploy.steps.upload",
		"deploy.steps.exec",
		"deploy.steps.cleanup",
		"deploy.steps.verify",
	}
}
func (d *ClaudeCodeDeployer) AllowMultiple() bool       { return false }
func (d *ClaudeCodeDeployer) ParamsSchema() []ParamSpec { return nil }

// Deploy 上传 setup_claude.sh → 执行 → 清理 → 验证
func (d *ClaudeCodeDeployer) Deploy(ctx context.Context, p DeployParams) error {
	log := p.Log
	const remoteScript = "/tmp/sc-setup-claude.sh"

	// 纵深防御：Trigger 已在任务创建前校验过，这里再拦一次（防直接调用 Deploy 的场景）
	if err := validateClaudeCfg(p.Cfg); err != nil {
		return err
	}

	// Step 1: preflight
	log.LogKV("preflight", LevelInfo, "deploy.log.claude_code.preparingUpload", nil)

	// Step 2: upload
	if err := p.SSH.UploadBytes([]byte(SetupClaudeScript()), sshclient.UploadOptions{
		RemotePath: remoteScript,
		Mode:       0644,
	}); err != nil {
		log.LogKV("upload", LevelFail, "deploy.log.claude_code.uploadFailed",
			map[string]any{"error": err.Error()})
		return fmt.Errorf("upload script: %w", err)
	}
	log.LogKV("upload", LevelOK, "deploy.log.claude_code.scriptUploaded", nil)

	// Step 3: exec（实时流，解析 [OK]/[FAIL] 标记决定 level）
	log.LogKV("exec", LevelInfo, "deploy.log.claude_code.runningScript", nil)
	env := map[string]string{
		"ANTHROPIC_TOKEN":    p.Cfg.AnthropicToken,
		"ANTHROPIC_BASE_URL": p.Cfg.AnthropicBaseURL,
		"MODEL":              p.Cfg.Model,
	}
	handler := func(stream, line string) {
		lvl := LevelInfo
		if stream == "stderr" {
			lvl = LevelWarn
		}
		if startsWith(line, "[OK]") {
			lvl = LevelOK
		} else if startsWith(line, "[FAIL]") {
			lvl = LevelFail
		} else if startsWith(line, "[DONE]") {
			lvl = LevelOK
		}
		// 脚本输出行原样转发（无 i18n key），前端显示原始内容
		log.Log("exec", lvl, line)
	}
	if _, err := p.SSH.Exec(ctx, sshclient.ExecOptions{
		Cmd: "bash " + remoteScript + " cld",
		Env: env,
	}, handler); err != nil {
		log.LogKV("exec", LevelFail, "deploy.log.claude_code.scriptFailed",
			map[string]any{"error": err.Error()})
		return fmt.Errorf("setup_claude.sh: %w", err)
	}

	// Step 4: cleanup
	_, _ = p.SSH.Exec(ctx, execOpts("rm -f "+remoteScript), nil)
	log.LogKV("cleanup", LevelOK, "deploy.log.claude_code.scriptRemoved", nil)

	// Step 5: verify
	log.LogKV("verify", LevelInfo, "deploy.log.claude_code.verifying", nil)
	out, err := p.SSH.Exec(ctx, execOpts("sudo -u cld bash -lc '. \"$HOME/.nvm/nvm.sh\" && claude --version 2>&1 && test -x /usr/bin/cld.sh'"), nil)
	if err != nil || out.ExitCode != 0 {
		msg := "verify failed"
		if err != nil {
			msg = err.Error()
		}
		log.LogKV("verify", LevelFail, "deploy.log.claude_code.verifyFailed",
			map[string]any{"error": msg})
		return fmt.Errorf("verify claude: %s", msg)
	}
	log.LogKV("verify", LevelOK, "deploy.log.claude_code.verified", nil)
	return nil
}

func init() {
	Register(&ClaudeCodeDeployer{})
}

// startsWith 简化前缀判断
func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// validateClaudeCfg 校验 claude_code 部署所需的 Anthropic 配置
// token / baseUrl / model 缺一不可——任一为空，远程 Claude Code 都无法正常工作
func validateClaudeCfg(cfg *config.DeployConfig) error {
	if cfg == nil {
		return fmt.Errorf("deploy config not loaded")
	}
	switch {
	case cfg.AnthropicToken == "":
		return fmt.Errorf("anthropicToken is required for claude_code deployment")
	case cfg.AnthropicBaseURL == "":
		return fmt.Errorf("anthropicBaseUrl is required for claude_code deployment")
	case cfg.Model == "":
		return fmt.Errorf("model is required for claude_code deployment")
	}
	return nil
}
