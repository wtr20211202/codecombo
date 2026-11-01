package deploy

import (
	"context"
	"testing"
)

func TestRegistryRegisterAndGet(t *testing.T) {
	d := &fakeDeployer{id: "test_dep"}
	Register(d)
	defer unregister("test_dep")

	got := Get("test_dep")
	if got == nil {
		t.Fatal("expected to find test_dep")
	}
	if got.ID() != "test_dep" {
		t.Errorf("expected id test_dep, got %s", got.ID())
	}
}

func TestRegistryGetUnknown(t *testing.T) {
	if Get("does_not_exist") != nil {
		t.Error("expected nil for unknown id")
	}
}

func TestRegistryListByCategory(t *testing.T) {
	d1 := &fakeDeployer{id: "list_a", cat: CategoryInit}
	d2 := &fakeDeployer{id: "list_b", cat: CategoryDevTool}
	d3 := &fakeDeployer{id: "list_c", cat: CategorySelfHost}
	Register(d1)
	Register(d2)
	Register(d3)
	defer func() {
		unregister("list_a")
		unregister("list_b")
		unregister("list_c")
	}()

	all := List()
	ids := make([]string, 0, len(all))
	for _, d := range all {
		ids = append(ids, d.ID())
	}

	// init 应在 dev_tool 前，dev_tool 应在 self_host 前
	var idxA, idxB, idxC = -1, -1, -1
	for i, id := range ids {
		switch id {
		case "list_a":
			idxA = i
		case "list_b":
			idxB = i
		case "list_c":
			idxC = i
		}
	}
	if idxA < 0 || idxB < 0 || idxC < 0 {
		t.Fatalf("expected all three, got %v", ids)
	}
	if !(idxA < idxB && idxB < idxC) {
		t.Errorf("expected order init<dev_tool<self_host, got %v", ids)
	}
}

func TestApplyParamDefaults(t *testing.T) {
	schema := []ParamSpec{
		{Key: "keyName", Default: "id_ed25519"},
		{Key: "email"},
	}
	params := ApplyParamDefaults(schema, map[string]string{"email": "a@b.com"})
	if params["keyName"] != "id_ed25519" {
		t.Errorf("expected default id_ed25519, got %s", params["keyName"])
	}
	if params["email"] != "a@b.com" {
		t.Errorf("expected provided email, got %s", params["email"])
	}
}

func TestApplyParamDefaultsNilMap(t *testing.T) {
	schema := []ParamSpec{{Key: "x", Default: "y"}}
	params := ApplyParamDefaults(schema, nil)
	if params["x"] != "y" {
		t.Errorf("expected default y, got %s", params["x"])
	}
}

func TestValidateParamsMissingRequired(t *testing.T) {
	schema := []ParamSpec{{Key: "email", Required: true}}
	err := ValidateParams(schema, map[string]string{})
	if err == nil {
		t.Fatal("expected error for missing required")
	}
	pe, ok := err.(*ParamValidationError)
	if !ok || pe.Key != "email" {
		t.Errorf("expected ParamValidationError{email}, got %v", err)
	}
}

func TestValidateParamsOK(t *testing.T) {
	schema := []ParamSpec{{Key: "email", Required: true}}
	if err := ValidateParams(schema, map[string]string{"email": "a@b.com"}); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

type fakeDeployer struct {
	id  string
	cat string
}

func (f *fakeDeployer) ID() string                  { return f.id }
func (f *fakeDeployer) Name() string                { return "fake" }
func (f *fakeDeployer) Category() string            { return f.cat }
func (f *fakeDeployer) Description() string         { return "" }
func (f *fakeDeployer) DependsOn() []string         { return nil }
func (f *fakeDeployer) Steps() []string             { return nil }
func (f *fakeDeployer) AllowMultiple() bool         { return false }
func (f *fakeDeployer) ParamsSchema() []ParamSpec   { return nil }
func (f *fakeDeployer) Deploy(_ context.Context, _ DeployParams) error { return nil }
