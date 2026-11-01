package deploy

import (
	"testing"

	"codecombo/server/config"
)

func TestResolvePlanAutoAddDeps(t *testing.T) {
	in := []config.DeployerInstance{
		{DeployerID: "codecombo", Params: map[string]string{}},
	}
	resolved, err := ResolvePlan(in)
	if err != nil {
		t.Fatalf("ResolvePlan: %v", err)
	}
	ids := idsOf(resolved)
	if !contains(ids, "init_user") {
		t.Errorf("expected init_user auto-added, got %v", ids)
	}
	if !contains(ids, "codecombo") {
		t.Errorf("expected simple_coding kept, got %v", ids)
	}
	if indexOf(ids, "init_user") > indexOf(ids, "codecombo") {
		t.Errorf("init_user should come before simple_coding, got %v", ids)
	}
}

func TestResolvePlanAllowMultiple(t *testing.T) {
	in := []config.DeployerInstance{
		{DeployerID: "init_ssh_key", Params: map[string]string{"keyName": "id_ed25519_github", "email": "a@b.com"}},
		{DeployerID: "init_ssh_key", Params: map[string]string{"keyName": "id_ed25519_gitlab", "email": "c@d.com"}},
	}
	resolved, err := ResolvePlan(in)
	if err != nil {
		t.Fatalf("ResolvePlan: %v", err)
	}
	count := 0
	for _, inst := range resolved {
		if inst.DeployerID == "init_ssh_key" {
			count++
		}
	}
	if count != 2 {
		t.Errorf("expected 2 init_ssh_key instances, got %d", count)
	}
}

func TestResolvePlanRejectDuplicateSingle(t *testing.T) {
	in := []config.DeployerInstance{
		{DeployerID: "claude_code", Params: map[string]string{}},
		{DeployerID: "claude_code", Params: map[string]string{}},
	}
	_, err := ResolvePlan(in)
	if err == nil {
		t.Error("expected error for duplicate claude_code")
	}
}

func TestResolvePlanUnknownDeployer(t *testing.T) {
	in := []config.DeployerInstance{
		{DeployerID: "nonexistent", Params: map[string]string{}},
	}
	_, err := ResolvePlan(in)
	if err == nil {
		t.Error("expected error for unknown deployer")
	}
}

func TestResolvePlanDeduplicateDeps(t *testing.T) {
	// 多个工具都依赖 init_user，init_user 只应出现一次
	in := []config.DeployerInstance{
		{DeployerID: "claude_code", Params: map[string]string{}},
		{DeployerID: "codecombo", Params: map[string]string{}},
	}
	resolved, err := ResolvePlan(in)
	if err != nil {
		t.Fatalf("ResolvePlan: %v", err)
	}
	count := 0
	for _, inst := range resolved {
		if inst.DeployerID == "init_user" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected init_user only once, got %d", count)
	}
}

func TestResolvePlanInitSshKeyParamValidation(t *testing.T) {
	in := []config.DeployerInstance{
		{DeployerID: "init_ssh_key", Params: map[string]string{"keyName": "id_ed25519"}}, // 缺 email
	}
	_, err := ResolvePlan(in)
	if err == nil {
		t.Error("expected error for missing email")
	}
}

func TestResolvePlanInitSshKeyDefaultApplied(t *testing.T) {
	in := []config.DeployerInstance{
		{DeployerID: "init_ssh_key", Params: map[string]string{"email": "a@b.com"}}, // 缺 keyName，应取默认
	}
	resolved, err := ResolvePlan(in)
	if err != nil {
		t.Fatalf("ResolvePlan: %v", err)
	}
	// 找到 init_ssh_key 实例
	for _, inst := range resolved {
		if inst.DeployerID == "init_ssh_key" {
			if inst.Params["keyName"] != "id_ed25519" {
				t.Errorf("expected default keyName, got %s", inst.Params["keyName"])
			}
			return
		}
	}
	t.Fatal("init_ssh_key not in resolved")
}

func idsOf(instances []config.DeployerInstance) []string {
	out := make([]string, len(instances))
	for i, x := range instances {
		out[i] = x.DeployerID
	}
	return out
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func indexOf(s []string, v string) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}
