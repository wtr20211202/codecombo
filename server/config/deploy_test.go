package config

import (
	"testing"
	"time"
)

func TestRemoteHostDefaults(t *testing.T) {
	rh := RemoteHost{Port: 0}
	rh.ApplyDefaults()
	if rh.Port != 22 {
		t.Errorf("expected default port 22, got %d", rh.Port)
	}
	if rh.ID == "" {
		t.Error("expected ID to be set")
	}
	if rh.CreatedAt.IsZero() {
		t.Error("expected CreatedAt set")
	}
	if rh.UpdatedAt.IsZero() {
		t.Error("expected UpdatedAt set")
	}
}

func TestRemoteHostKeepsExistingID(t *testing.T) {
	rh := RemoteHost{ID: "sc_rh_existing", Port: 2222}
	rh.ApplyDefaults()
	if rh.ID != "sc_rh_existing" {
		t.Errorf("ID should not be overwritten, got %s", rh.ID)
	}
	if rh.Port != 2222 {
		t.Errorf("Port should not be overwritten when set, got %d", rh.Port)
	}
}

func TestDeployConfigDefaults(t *testing.T) {
	cfg := DeployConfig{}
	cfg.ApplyDefaults()
	if cfg.AnthropicBaseURL != "" {
		t.Errorf("expected empty default base url, got %s", cfg.AnthropicBaseURL)
	}
	if cfg.Model != "glm-5.3[1m]" {
		t.Errorf("expected model glm-5.3[1m], got %s", cfg.Model)
	}
}

func TestDeployConfigKeepsExistingValues(t *testing.T) {
	cfg := DeployConfig{
		AnthropicBaseURL: "https://custom.example.com/",
		Model:            "custom-model",
	}
	cfg.ApplyDefaults()
	if cfg.AnthropicBaseURL != "https://custom.example.com/" {
		t.Errorf("base url should be kept, got %s", cfg.AnthropicBaseURL)
	}
	if cfg.Model != "custom-model" {
		t.Errorf("model should be kept, got %s", cfg.Model)
	}
}

func TestDeployTaskIsTerminal(t *testing.T) {
	cases := []struct {
		status string
		want   bool
	}{
		{TaskStatusQueued, false},
		{TaskStatusRunning, false},
		{TaskStatusCompleted, true},
		{TaskStatusFailed, true},
		{TaskStatusCancelled, true},
		{"", false},
	}
	for _, c := range cases {
		task := DeployTask{Status: c.status}
		if got := task.IsTerminal(); got != c.want {
			t.Errorf("status=%q IsTerminal=%v want %v", c.status, got, c.want)
		}
	}
}

func TestDeployTaskDuration(t *testing.T) {
	start := time.Now()
	end := start.Add(5 * time.Minute)
	task := DeployTask{StartedAt: &start, FinishedAt: &end}
	if d := task.Duration(); d != 5*time.Minute {
		t.Errorf("expected 5m, got %v", d)
	}
}

func TestDeployTaskDurationNoStart(t *testing.T) {
	task := DeployTask{}
	if d := task.Duration(); d != 0 {
		t.Errorf("expected 0, got %v", d)
	}
}

func TestDeployTaskDurationRunning(t *testing.T) {
	start := time.Now().Add(-10 * time.Second)
	task := DeployTask{StartedAt: &start}
	d := task.Duration()
	if d < 9*time.Second || d > 30*time.Second {
		t.Errorf("expected ~10s, got %v", d)
	}
}
