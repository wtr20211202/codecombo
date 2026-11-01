package deploy

import "testing"

func TestInitSshKeyMetadata(t *testing.T) {
	d := &InitSshKeyDeployer{}
	if d.ID() != "init_ssh_key" {
		t.Errorf("expected init_ssh_key, got %s", d.ID())
	}
	if d.Category() != CategoryDevTool {
		t.Errorf("expected dev_tool, got %s", d.Category())
	}
	if !d.AllowMultiple() {
		t.Error("init_ssh_key should allow multiple")
	}
	deps := d.DependsOn()
	if len(deps) != 1 || deps[0] != "init_user" {
		t.Errorf("expected [init_user], got %v", deps)
	}

	schema := d.ParamsSchema()
	keys := map[string]ParamSpec{}
	for _, s := range schema {
		keys[s.Key] = s
	}
	if _, ok := keys["keyName"]; !ok {
		t.Error("expected keyName param")
	} else if !keys["keyName"].Required {
		t.Error("keyName should be required")
	}
	if _, ok := keys["email"]; !ok {
		t.Error("expected email param")
	} else if !keys["email"].Required {
		t.Error("email should be required")
	}
	if keys["keyName"].Default != "id_ed25519" {
		t.Errorf("expected keyName default id_ed25519, got %s", keys["keyName"].Default)
	}
}
