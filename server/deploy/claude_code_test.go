package deploy

import (
	"testing"

	"codecombo/server/config"
)

func TestClaudeCodeMetadata(t *testing.T) {
	d := &ClaudeCodeDeployer{}
	if d.ID() != "claude_code" {
		t.Errorf("expected claude_code, got %s", d.ID())
	}
	if d.Category() != CategoryDevTool {
		t.Errorf("expected dev_tool, got %s", d.Category())
	}
	deps := d.DependsOn()
	if len(deps) != 1 || deps[0] != "init_user" {
		t.Errorf("expected [init_user], got %v", deps)
	}
	if d.AllowMultiple() {
		t.Error("claude_code should not allow multiple")
	}
	if len(d.Steps()) != 5 {
		t.Errorf("expected 5 steps, got %d", len(d.Steps()))
	}
}

func TestStartsWith(t *testing.T) {
	cases := []struct {
		s, prefix string
		want      bool
	}{
		{"[OK] hello", "[OK]", true},
		{"[FAIL] bad", "[FAIL]", true},
		{"hello", "[OK]", false},
		{"", "[OK]", false},
		{"OK", "[OK]", false},
	}
	for _, c := range cases {
		if got := startsWith(c.s, c.prefix); got != c.want {
			t.Errorf("startsWith(%q, %q) = %v, want %v", c.s, c.prefix, got, c.want)
		}
	}
}

func TestValidateClaudeCfg(t *testing.T) {
	cases := []struct {
		name string
		cfg  *config.DeployConfig
		pass bool
	}{
		{"nil config", nil, false},
		{"missing token", &config.DeployConfig{AnthropicBaseURL: "http://gw/", Model: "m"}, false},
		{"missing baseUrl", &config.DeployConfig{AnthropicToken: "tk", Model: "m"}, false},
		{"missing model", &config.DeployConfig{AnthropicToken: "tk", AnthropicBaseURL: "http://gw/"}, false},
		{"all set", &config.DeployConfig{AnthropicToken: "tk", AnthropicBaseURL: "http://gw/", Model: "m"}, true},
	}
	for _, c := range cases {
		err := validateClaudeCfg(c.cfg)
		if (err == nil) != c.pass {
			t.Errorf("%s: err=%v, want pass=%v", c.name, err, c.pass)
		}
	}
}
