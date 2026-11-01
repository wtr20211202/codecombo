package system

import (
	"testing"

	filestore "codecombo/server/filestore"
	"codecombo/server/store"
)

// 删除项目后的 ui-state 级联清理：projectId 指针、projectOrder、
// projectSessionOrder 中的死引用都要摘除；其他实例与其他键不动
func TestCleanupProjectUIState(t *testing.T) {
	ds := filestore.New(t.TempDir())
	store.SetDefault(store.New(ds))

	seed := map[string]interface{}{
		"local": map[string]interface{}{
			"projectId":    "dead-id",
			"projectOrder": []interface{}{"dead-id", "alive-id"},
			"projectSessionOrder": map[string]interface{}{
				"dead-id":  []interface{}{"s1"},
				"alive-id": []interface{}{"s2"},
			},
			"layout": map[string]interface{}{"sidePanelWidth": 260.0},
		},
		"inst-2": map[string]interface{}{
			"projectId": "alive-id",
		},
	}
	if err := store.Get().UIState.Update(seed); err != nil {
		t.Fatal(err)
	}

	CleanupProjectUIState("dead-id")

	data, err := store.Get().UIState.Get()
	if err != nil {
		t.Fatal(err)
	}
	local := data["local"].(map[string]interface{})
	if _, hit := local["projectId"]; hit {
		t.Error("local.projectId should be removed")
	}
	order := local["projectOrder"].([]interface{})
	if len(order) != 1 || order[0] != "alive-id" {
		t.Errorf("projectOrder = %v, want [alive-id]", order)
	}
	pso := local["projectSessionOrder"].(map[string]interface{})
	if _, hit := pso["dead-id"]; hit {
		t.Error("projectSessionOrder[dead-id] should be removed")
	}
	if _, ok := pso["alive-id"]; !ok {
		t.Error("projectSessionOrder[alive-id] should survive")
	}
	if local["layout"] == nil {
		t.Error("unrelated keys must survive")
	}
	inst2 := data["inst-2"].(map[string]interface{})
	if inst2["projectId"] != "alive-id" {
		t.Errorf("other instances untouched: %v", inst2["projectId"])
	}
}
