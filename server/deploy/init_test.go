package deploy

import "testing"

// TestBuiltinDeployersRegistered 验证 init() 已注册内置 4 个 Deployer
func TestBuiltinDeployersRegistered(t *testing.T) {
	required := []string{"init_user", "claude_code", "init_ssh_key", "codecombo"}
	for _, id := range required {
		if Get(id) == nil {
			t.Errorf("deployer %s not registered", id)
		}
	}
}
