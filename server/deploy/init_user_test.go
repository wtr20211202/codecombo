package deploy

import "testing"

func TestInitUserMetadata(t *testing.T) {
	d := &InitUserDeployer{}
	if d.ID() != "init_user" {
		t.Errorf("expected id init_user, got %s", d.ID())
	}
	if d.Category() != CategoryInit {
		t.Errorf("expected category init, got %s", d.Category())
	}
	if len(d.DependsOn()) != 0 {
		t.Errorf("expected no deps, got %v", d.DependsOn())
	}
	if d.AllowMultiple() {
		t.Error("init_user should not allow multiple")
	}
	if len(d.ParamsSchema()) != 0 {
		t.Errorf("expected no params, got %v", d.ParamsSchema())
	}
	if len(d.Steps()) != 3 {
		t.Errorf("expected 3 steps, got %d", len(d.Steps()))
	}
}
